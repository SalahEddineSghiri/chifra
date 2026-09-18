export const observationNames = [
  "supplierName", "supplierIce", "customerIce", "invoiceNumber", "issuedOn",
  "amountHt", "vatAmount", "amountTtc", "printedVatRate",
] as const;

export type ObservationName = (typeof observationNames)[number];
export type ObservedField = {
  value: string | null;
  page: number | null;
  missingReason: string | null;
};
export type InvoiceObservations = {
  status: "COMPLETE" | "PARTIAL";
  fields: Record<ObservationName, ObservedField>;
};

type PageText = { page: number; text: string };
type Line = { page: number; text: string };
type Candidate = { value: string; page: number };

function field(candidates: Candidate[]): ObservedField {
  if (candidates.length === 0) {
    return { value: null, page: null, missingReason: "Champ non trouvé dans le texte." };
  }
  const distinct = new Set(candidates.map((candidate) => candidate.value));
  if (distinct.size !== 1) {
    return { value: null, page: null, missingReason: "Plusieurs valeurs différentes trouvées." };
  }
  const first = candidates[0];
  if (!first) throw new Error("Candidat absent");
  return { value: first.value, page: first.page, missingReason: null };
}

function normaliseAmount(raw: string): string | null {
  const trimmed = raw.trim().replace(/[\u00a0\u202f]/g, " ");
  if (!/^-?(?:\d{1,3}(?: \d{3})+|\d+)[,.]\d{2}$/.test(trimmed)) return null;
  const compact = trimmed.replaceAll(" ", "").replace(",", ".");
  const negative = compact.startsWith("-");
  const unsigned = negative ? compact.slice(1) : compact;
  const [integer, fraction] = unsigned.split(".");
  if (!integer || !fraction) return null;
  return `${negative ? "-" : ""}${integer.replace(/^0+(?=\d)/, "")}.${fraction}`;
}

function validDate(raw: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? null : raw;
}

function nextValue(lines: Line[], index: number, inline: string, parse: (value: string) => string | null) {
  if (inline.trim()) return parse(inline);
  const next = lines[index + 1];
  if (next?.page !== lines[index]?.page) return null;
  return next ? parse(next.text) : null;
}

export function extractInvoiceObservations(segments: PageText[]): InvoiceObservations {
  const lines = segments.flatMap(({ page, text }) => text.split(/\r?\n/)
    .map((line) => ({ page, text: line.trim() })).filter((line) => line.text.length > 0));
  const candidates: Record<ObservationName, Candidate[]> = {
    supplierName: [], supplierIce: [], customerIce: [], invoiceNumber: [], issuedOn: [],
    amountHt: [], vatAmount: [], amountTtc: [], printedVatRate: [],
  };
  const add = (name: ObservationName, value: string | null, page: number) => {
    if (value !== null) candidates[name].push({ value, page });
  };

  for (const [index, line] of lines.entries()) {
    const text = line.text;
    const next = lines[index + 1];
    if (index === 0 && next?.page === line.page && /^ICE\s*[: ]?\s*\d{15}\b/i.test(next.text)) {
      add("supplierName", text, line.page);
    }
    const supplierIce = /^ICE\s*[: ]?\s*(\d{15})\b/i.exec(text);
    if (supplierIce) add("supplierIce", supplierIce[1] ?? null, line.page);
    const customerIce = /^ICE\s+client\s*[: ]?\s*(\d{15})\b/i.exec(text);
    if (customerIce) add("customerIce", customerIce[1] ?? null, line.page);
    if (/^ICE\s+client\s*:?$/i.test(text) && next?.page === line.page) {
      add("customerIce", /^\d{15}$/.test(next.text) ? next.text : null, line.page);
    }
    const invoiceNumber = /^(?:FACTURE|AVOIR)\s*(?:N[°ºo.]?\s*)?[:#-]?\s*([A-Z0-9][A-Z0-9/-]{3,})$/i.exec(text);
    if (invoiceNumber) add("invoiceNumber", invoiceNumber[1] ?? null, line.page);
    const date = /^Date(?:\s+(?:de\s+)?facture)?\s*:?\s*(.*)$/i.exec(text);
    if (date) add("issuedOn", nextValue(lines, index, date[1] ?? "", validDate), line.page);
    const ht = /^Total\s+HT\s*:?\s*(.*)$/i.exec(text);
    if (ht) add("amountHt", nextValue(lines, index, ht[1] ?? "", normaliseAmount), line.page);
    const vat = /^TVA\s+(\d{1,2}(?:[,.]\d{1,2})?)\s*%\s*:?\s*(.*)$/i.exec(text);
    if (vat) {
      add("printedVatRate", vat[1]?.replace(",", ".") ?? null, line.page);
      add("vatAmount", nextValue(lines, index, vat[2] ?? "", normaliseAmount), line.page);
    }
    const ttc = /^(?:Net\s+[àa]\s+payer\s+TTC|Total\s+TTC|Montant\s+TTC)\s*:?\s*(.*)$/i.exec(text);
    if (ttc) add("amountTtc", nextValue(lines, index, ttc[1] ?? "", normaliseAmount), line.page);
  }

  const fields = Object.fromEntries(observationNames.map((name) => [name, field(candidates[name])]))
    as Record<ObservationName, ObservedField>;
  return {
    status: observationNames.every((name) => fields[name].value !== null) ? "COMPLETE" : "PARTIAL",
    fields,
  };
}
