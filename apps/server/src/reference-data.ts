import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import { z } from "zod";

export const REFERENCE_VERSION = "chiffra-reference-v1";

export type SupplierReference = {
  name: string;
  ice: string;
  category: string;
  usualVatRate: string;
  account: string;
  recurring: boolean;
  averageTtcMad: string;
};

export type ReferenceData = {
  version: string;
  hashes: Record<"accounts" | "suppliers" | "rules", string>;
  accounts: Map<string, string>;
  suppliers: SupplierReference[];
  rules: {
    periodStart: string;
    periodEnd: string;
    duplicateWindowDays: number;
    abnormalAmountMultiplier: string;
  };
};

function parseCsv(text: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const finishField = () => {
    row.push(field);
    field = "";
  };
  const finishRow = () => {
    finishField();
    if (row.some((value) => value.length > 0)) result.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") finishField();
    else if (character === "\n") finishRow();
    else if (character !== "\r") field += character;
  }
  if (quoted) throw new Error("Référentiel CSV avec guillemet non fermé");
  if (field.length > 0 || row.length > 0) finishRow();
  return result;
}

function objects(text: string): Record<string, string>[] {
  const rows = parseCsv(text.replace(/^\uFEFF/u, ""));
  const headers = rows[0];
  if (!headers) throw new Error("Référentiel CSV vide");
  return rows.slice(1).map((values, rowIndex) => {
    if (values.length !== headers.length) {
      throw new Error(`Référentiel CSV invalide à la ligne ${rowIndex + 2}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

const accountSchema = z.strictObject({
  compte: z.string().regex(/^\d{4}$/),
  libelle: z.string().trim().min(1),
});
const supplierSchema = z.strictObject({
  fournisseur: z.string().trim().min(1),
  ice: z.string().regex(/^\d{15}$/),
  categorie: z.string().trim().min(1),
  taux_tva_habituel: z.string().regex(/^(?:7|10|14|20)$/),
  compte_comptable: z.string().regex(/^\d{4}$/),
  recurrent: z.enum(["oui", "non"]),
  montant_moyen_ttc_mad: z.string().min(1),
});

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

let cached: { directory: string; data: ReferenceData } | null = null;

export function loadReferenceData(
  directory = process.env.REFERENCE_DATA_DIR ?? "reference-data/v1",
): ReferenceData {
  if (cached?.directory === directory) return cached.data;
  const accountsText = readFileSync(join(directory, "plan-comptable.csv"), "utf8");
  const suppliersText = readFileSync(join(directory, "referentiel-fournisseurs.csv"), "utf8");
  const rulesText = readFileSync(join(directory, "regles-fiscales.md"), "utf8");
  const accounts = new Map<string, string>();
  for (const raw of objects(accountsText)) {
    const account = accountSchema.parse(raw);
    if (accounts.has(account.compte)) throw new Error(`Compte dupliqué : ${account.compte}`);
    accounts.set(account.compte, account.libelle);
  }
  const suppliers = objects(suppliersText).map((raw) => {
    const supplier = supplierSchema.parse(raw);
    if (!accounts.has(supplier.compte_comptable)) {
      throw new Error(`Compte fournisseur inconnu : ${supplier.compte_comptable}`);
    }
    const average = new Decimal(supplier.montant_moyen_ttc_mad);
    if (!average.greaterThan(0)) throw new Error(`Moyenne fournisseur invalide : ${supplier.fournisseur}`);
    return {
      name: supplier.fournisseur,
      ice: supplier.ice,
      category: supplier.categorie,
      usualVatRate: new Decimal(supplier.taux_tva_habituel).toFixed(2),
      account: supplier.compte_comptable,
      recurring: supplier.recurrent === "oui",
      averageTtcMad: average.toFixed(2),
    };
  });
  if (new Set(suppliers.map((supplier) => supplier.ice)).size !== suppliers.length) {
    throw new Error("ICE fournisseur dupliqué dans le référentiel");
  }
  if (!rulesText.includes("du 1er janvier au 30 juin 2026")
    || !rulesText.includes("jusqu'à 60 jours")
    || !rulesText.includes("dix fois")) {
    throw new Error("Version inattendue du référentiel fiscal");
  }
  const data: ReferenceData = {
    version: REFERENCE_VERSION,
    hashes: {
      accounts: hash(accountsText),
      suppliers: hash(suppliersText),
      rules: hash(rulesText),
    },
    accounts,
    suppliers,
    rules: {
      periodStart: "2026-01-01",
      periodEnd: "2026-06-30",
      duplicateWindowDays: 7,
      abnormalAmountMultiplier: "10",
    },
  };
  cached = { directory, data };
  return data;
}
