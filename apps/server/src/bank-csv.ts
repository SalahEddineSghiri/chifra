import { Decimal } from "decimal.js";

export const BANK_CSV_VERSION = "bank-csv-v1";
export type BankClassification =
  | "PURCHASE_CANDIDATE"
  | "SALARY"
  | "BANK_FEE"
  | "CLIENT_RECEIPT"
  | "OTHER";

export type ParsedBankLine = {
  lineNumber: number;
  bookedOn: string;
  label: string;
  debitMad: string;
  creditMad: string;
  balanceMad: string;
  classification: BankClassification;
  balanceConsistent: boolean | null;
  rawValues: Record<string, string>;
};

export class BankCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankCsvError";
  }
}

function rows(text: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.some((value) => value.length > 0)) result.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      endField();
    } else if (character === "\n") {
      endRow();
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (quoted) throw new BankCsvError("Guillemet CSV non fermé.");
  if (field.length > 0 || row.length > 0) endRow();
  return result;
}

function decimal(raw: string, lineNumber: number, column: string, allowNegative: boolean): Decimal {
  const value = raw.trim();
  const pattern = allowNegative
    ? /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/
    : /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
  if (!pattern.test(value)) {
    throw new BankCsvError(`Ligne ${lineNumber} : ${column} doit être un montant décimal.`);
  }
  const parsed = new Decimal(value);
  if (parsed.abs().greaterThan("9999999999999999.99")) {
    throw new BankCsvError(`Ligne ${lineNumber} : ${column} dépasse la limite autorisée.`);
  }
  return parsed;
}

function classification(label: string, debit: Decimal, credit: Decimal): BankClassification {
  if (/\bSALAIRES?\b/iu.test(label)) return "SALARY";
  if (/\bFRAIS\b/iu.test(label)) return "BANK_FEE";
  if (credit.greaterThan(0) && /\b(?:REGLEMENT|RÈGLEMENT|VIR(?:EMENT)?)\s+CLIENT\b/iu.test(label)) {
    return "CLIENT_RECEIPT";
  }
  if (debit.greaterThan(0) && /^(?:VIR|VIREMENT|REGLEMENT|RÈGLEMENT)\b/iu.test(label)) {
    return "PURCHASE_CANDIDATE";
  }
  return "OTHER";
}

export function parseBankStatementCsv(text: string): ParsedBankLine[] {
  const parsedRows = rows(text.replace(/^\uFEFF/u, ""));
  const header = parsedRows[0]?.map((value) => value.trim());
  const expectedHeader = ["date", "libelle", "debit_mad", "credit_mad", "solde_mad"];
  if (!header || header.length !== expectedHeader.length
    || header.some((value, index) => value !== expectedHeader[index])) {
    throw new BankCsvError(`En-tête attendu : ${expectedHeader.join(",")}.`);
  }
  if (parsedRows.length < 2) throw new BankCsvError("Le relevé ne contient aucune ligne.");
  if (parsedRows.length > 5001) throw new BankCsvError("Le relevé dépasse 5000 lignes.");

  let previousBalance: Decimal | null = null;
  return parsedRows.slice(1).map((values, index) => {
    const lineNumber = index + 2;
    if (values.length !== expectedHeader.length) {
      throw new BankCsvError(`Ligne ${lineNumber} : 5 colonnes attendues.`);
    }
    const [rawDate, rawLabel, rawDebit, rawCredit, rawBalance] = values;
    if (rawDate === undefined || rawLabel === undefined || rawDebit === undefined
      || rawCredit === undefined || rawBalance === undefined) {
      throw new BankCsvError(`Ligne ${lineNumber} : colonnes incomplètes.`);
    }
    const bookedOn = rawDate.trim();
    const date = new Date(`${bookedOn}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bookedOn) || Number.isNaN(date.getTime())
      || date.toISOString().slice(0, 10) !== bookedOn) {
      throw new BankCsvError(`Ligne ${lineNumber} : date ISO invalide.`);
    }
    const label = rawLabel.trim();
    if (label.length < 1 || label.length > 500) {
      throw new BankCsvError(`Ligne ${lineNumber} : libellé requis (500 caractères maximum).`);
    }
    const debit = decimal(rawDebit, lineNumber, "debit_mad", false);
    const credit = decimal(rawCredit, lineNumber, "credit_mad", false);
    const balance = decimal(rawBalance, lineNumber, "solde_mad", true);
    if (debit.isZero() === credit.isZero()) {
      throw new BankCsvError(`Ligne ${lineNumber} : un seul montant débit ou crédit doit être positif.`);
    }
    const balanceConsistent = previousBalance === null
      ? null
      : previousBalance.minus(debit).plus(credit).equals(balance);
    previousBalance = balance;
    return {
      lineNumber,
      bookedOn,
      label,
      debitMad: debit.toFixed(2),
      creditMad: credit.toFixed(2),
      balanceMad: balance.toFixed(2),
      classification: classification(label, debit, credit),
      balanceConsistent,
      rawValues: {
        date: rawDate,
        libelle: rawLabel,
        debit_mad: rawDebit,
        credit_mad: rawCredit,
        solde_mad: rawBalance,
      },
    };
  });
}
