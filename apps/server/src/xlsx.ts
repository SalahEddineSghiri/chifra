import { Decimal } from "decimal.js";

export const XLSX_PARSER_VERSION = "xlsx-achats-v2";
const expectedHeaders = [
  "id", "numero", "fournisseur", "ice", "date", "compte", "taux_tva", "ht", "tva", "ttc",
] as const;
const MAX_ROWS = 5_000;

type CellValue = string | number | boolean | Date | null;
type WorkbookSheet = { sheet: string; data: CellValue[][] };
type WorkbookReader = (
  path: string,
  options: { parseNumber: (value: string) => string },
) => Promise<WorkbookSheet[]>;

export type TabularField = {
  value: string | null;
  rawValue: string | null;
  missingReason: string | null;
  row: number;
  column: string;
  extractionMethod: "TABULAR";
  extractionVersion: string;
  normalization: string[];
};

export type TabularRecord = {
  rowNumber: number;
  externalDocumentId: string | null;
  status: "COMPLETE" | "PARTIAL";
  fields: {
    externalDocumentId: TabularField;
    invoiceNumber: TabularField;
    supplierName: TabularField;
    supplierIce: TabularField;
    issuedOn: TabularField;
    account: TabularField;
    printedVatRate: TabularField;
    amountHt: TabularField;
    vatAmount: TabularField;
    amountTtc: TabularField;
  };
  rawValues: Record<string, string | null>;
};

export type XlsxOutcome =
  | { status: "DONE"; reason: null; sheetName: string; records: TabularRecord[] }
  | { status: "NON_TRAITE"; reason: string; sheetName: null; records: [] };

class XlsxFormatError extends Error {}

function isUnreadableWorkbook(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (["InvalidInputError", "InvalidSpreadsheetError", "SheetNotFoundError"].includes(error.name)) {
    return true;
  }
  const code = (error as Error & { code?: unknown }).code;
  return code === "FILE_ENDED";
}

function workbookFailureReason(error: Error): string {
  const code = (error as Error & { code?: unknown }).code;
  return code === "FILE_ENDED"
    ? "Archive XLSX tronquée ou illisible."
    : error.message || "Fichier XLSX illisible ou structure non prise en charge.";
}

function rawCell(value: CellValue): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function prepare(raw: string) {
  const value = raw.trim();
  return {
    value,
    normalization: value === raw ? [] : ["WHITESPACE_TRIMMED"],
  };
}

function field(
  rawValue: string | null,
  row: number,
  column: string,
  normalize: (raw: string) => { value: string; normalization: string[] } | null,
): TabularField {
  const blank = rawValue === null || rawValue.trim() === "";
  const normalized = blank ? null : normalize(rawValue);
  return {
    value: normalized?.value ?? null,
    rawValue,
    missingReason: normalized ? null : blank
      ? "Cellule vide dans le XLSX."
      : "Valeur XLSX invalide pour ce champ.",
    row,
    column,
    extractionMethod: "TABULAR",
    extractionVersion: XLSX_PARSER_VERSION,
    normalization: normalized?.normalization ?? [],
  };
}

function text(maxLength: number, pattern?: RegExp) {
  return (raw: string) => {
    const { value, normalization } = prepare(raw);
    return value.length > 0 && value.length <= maxLength && (!pattern || pattern.test(value))
      ? { value, normalization }
      : null;
  };
}

function decimal(scale: number, minimum?: Decimal, maximum?: Decimal) {
  return (raw: string) => {
    try {
      const prepared = prepare(raw);
      const parsed = new Decimal(prepared.value);
      if (!parsed.isFinite() || (minimum && parsed.lt(minimum)) || (maximum && parsed.gt(maximum))) {
        return null;
      }
      const value = scale === 2 ? parsed.toFixed(2) : parsed.toDecimalPlaces(scale).toString();
      return {
        value,
        normalization: value === prepared.value
          ? prepared.normalization
          : [...prepared.normalization, "DECIMAL_CANONICAL"],
      };
    } catch {
      return null;
    }
  };
}

function date(raw: string) {
  const { value, normalization } = prepare(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? { value, normalization }
    : null;
}

function parseRecord(row: CellValue[], rowNumber: number): TabularRecord {
  const rawValues = Object.fromEntries(expectedHeaders.map((header, index) => [
    header, rawCell(row[index] ?? null),
  ])) as Record<(typeof expectedHeaders)[number], string | null>;
  const fields = {
    externalDocumentId: field(rawValues.id, rowNumber, "id", text(80)),
    invoiceNumber: field(rawValues.numero, rowNumber, "numero", text(120, /^[\p{L}\p{N}/-]+$/u)),
    supplierName: field(rawValues.fournisseur, rowNumber, "fournisseur", text(200)),
    supplierIce: field(rawValues.ice, rowNumber, "ice", text(15, /^\d{15}$/)),
    issuedOn: field(rawValues.date, rowNumber, "date", date),
    account: field(rawValues.compte, rowNumber, "compte", text(30, /^\d+$/)),
    printedVatRate: field(rawValues.taux_tva, rowNumber, "taux_tva",
      decimal(2, new Decimal(0), new Decimal(100))),
    amountHt: field(rawValues.ht, rowNumber, "ht", decimal(2)),
    vatAmount: field(rawValues.tva, rowNumber, "tva", decimal(2)),
    amountTtc: field(rawValues.ttc, rowNumber, "ttc", decimal(2)),
  };
  const required = [
    fields.invoiceNumber, fields.supplierName, fields.issuedOn,
    fields.amountHt, fields.vatAmount, fields.amountTtc,
  ];
  return {
    rowNumber,
    externalDocumentId: fields.externalDocumentId.value,
    status: required.every((item) => item.value !== null) ? "COMPLETE" : "PARTIAL",
    fields,
    rawValues,
  };
}

export async function extractXlsx(path: string): Promise<XlsxOutcome> {
  try {
    const moduleName = "read-excel-file/node";
    const workbookModule = await import(moduleName) as unknown as { default: WorkbookReader };
    const sheets = await workbookModule.default(path, { parseNumber: (value) => value });
    const matches = sheets.filter(({ data }) => {
      const headers = data[0]?.map(rawCell);
      return headers?.length === expectedHeaders.length
        && expectedHeaders.every((header, index) => headers[index] === header);
    });
    if (matches.length !== 1) {
      throw new XlsxFormatError("Une feuille avec les dix colonnes d'achats attendues est requise.");
    }
    const selected = matches[0];
    if (!selected) throw new XlsxFormatError("Feuille XLSX absente.");
    const rows = selected.data.slice(1)
      .map((row, index) => ({ row, rowNumber: index + 2 }))
      .filter(({ row }) => row.some((cell) => {
        const raw = rawCell(cell);
        return raw !== null && raw.trim() !== "";
      }));
    if (rows.length === 0) throw new XlsxFormatError("Le XLSX ne contient aucune ligne d'achat.");
    if (rows.length > MAX_ROWS) throw new XlsxFormatError("Le XLSX dépasse 5 000 lignes.");
    return {
      status: "DONE",
      reason: null,
      sheetName: selected.sheet,
      records: rows.map(({ row, rowNumber }) => parseRecord(row, rowNumber)),
    };
  } catch (error) {
    if (error instanceof XlsxFormatError || isUnreadableWorkbook(error)) {
      return {
        status: "NON_TRAITE",
        reason: workbookFailureReason(error),
        sheetName: null,
        records: [],
      };
    }
    throw error;
  }
}
