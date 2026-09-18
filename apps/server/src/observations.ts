export const observationNames = [
  "supplierName", "supplierIce", "customerIce", "invoiceNumber", "issuedOn",
  "amountHt", "vatAmount", "amountTtc", "printedVatRate",
] as const;

export const OBSERVATION_PARSER_VERSION = "labels-v2";

export type ObservationName = (typeof observationNames)[number];
export type ExtractionMethod = "PDF_TEXT" | "OCR";
export type NormalizationCode =
  | "ARABIC_INDIC_DIGITS_TO_LATIN"
  | "PERSIAN_DIGITS_TO_LATIN"
  | "ARABIC_DECIMAL_TO_DOT"
  | "ARABIC_THOUSANDS_REMOVED"
  | "GROUPING_SEPARATOR_REMOVED"
  | "DECIMAL_COMMA_TO_DOT"
  | "DATE_SEPARATOR_TO_HYPHEN";
export type ObservationCandidate = {
  rawValue: string;
  value: string;
  page: number;
  extractionMethod: ExtractionMethod;
  extractionVersion: string;
  normalization: NormalizationCode[];
};
export type ObservedField = {
  value: string | null;
  rawValue: string | null;
  page: number | null;
  missingReason: string | null;
  extractionMethod: ExtractionMethod | null;
  extractionVersion: string | null;
  normalization: NormalizationCode[];
  candidates: ObservationCandidate[];
  reviewRequired: boolean;
};
export type InvoiceObservations = {
  status: "COMPLETE" | "PARTIAL";
  fields: Record<ObservationName, ObservedField>;
};

type PageText = {
  page: number;
  text: string;
  method: ExtractionMethod;
  version: string;
};
type Line = PageText;
type Normalized = { rawValue: string; value: string; normalization: NormalizationCode[] };

const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
const digitSequence = "[0-9٠-٩۰-۹]";
const icePattern = new RegExp(`(?<!${digitSequence})(${digitSequence}{15})(?!${digitSequence})`, "u");
const datePattern = new RegExp(`(${digitSequence}{4}[-/.]${digitSequence}{2}[-/.]${digitSequence}{2})`, "u");
const amountPattern = new RegExp(
  `-?${digitSequence}+(?:[ \\u00a0\\u202f٬,.٫]${digitSequence}+)+`, "gu",
);

function field(candidates: ObservationCandidate[]): ObservedField {
  if (candidates.length === 0) {
    return {
      value: null,
      rawValue: null,
      page: null,
      missingReason: "Champ absent ou format non reconnu dans le texte.",
      extractionMethod: null,
      extractionVersion: null,
      normalization: [],
      candidates: [],
      reviewRequired: false,
    };
  }
  const distinct = new Set(candidates.map((candidate) => candidate.value));
  if (distinct.size !== 1) {
    return {
      value: null,
      rawValue: null,
      page: null,
      missingReason: "Plusieurs valeurs différentes trouvées.",
      extractionMethod: null,
      extractionVersion: null,
      normalization: [],
      candidates,
      reviewRequired: true,
    };
  }
  const first = candidates[0];
  if (!first) throw new Error("Candidat absent");
  return {
    value: first.value,
    rawValue: first.rawValue,
    page: first.page,
    missingReason: null,
    extractionMethod: first.extractionMethod,
    extractionVersion: first.extractionVersion,
    normalization: first.normalization,
    candidates,
    reviewRequired: false,
  };
}

function mapDigits(raw: string): { value: string; normalization: NormalizationCode[] } {
  const normalization: NormalizationCode[] = [];
  let value = raw;
  if (/[٠-٩]/u.test(value)) {
    value = value.replace(/[٠-٩]/gu, (digit) => String(arabicDigits.indexOf(digit)));
    normalization.push("ARABIC_INDIC_DIGITS_TO_LATIN");
  }
  if (/[۰-۹]/u.test(value)) {
    value = value.replace(/[۰-۹]/gu, (digit) => String(persianDigits.indexOf(digit)));
    normalization.push("PERSIAN_DIGITS_TO_LATIN");
  }
  return { value, normalization };
}

function unique(codes: NormalizationCode[]): NormalizationCode[] {
  return [...new Set(codes)];
}

function normalizeIdentifier(rawValue: string, length?: number): Normalized | null {
  const mapped = mapDigits(rawValue.trim());
  if (length !== undefined && mapped.value.length !== length) return null;
  if (!/^\d+$/.test(mapped.value)) return null;
  return { rawValue: rawValue.trim(), value: mapped.value, normalization: mapped.normalization };
}

function normalizeInvoiceNumber(rawValue: string): Normalized | null {
  const raw = rawValue.trim();
  const mapped = mapDigits(raw);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}/-]{3,}$/u.test(mapped.value)) return null;
  return { rawValue: raw, value: mapped.value, normalization: mapped.normalization };
}

function normalizeAmount(rawValue: string): Normalized | null {
  const raw = rawValue.trim();
  const mapped = mapDigits(raw);
  const normalization = [...mapped.normalization];
  let value = mapped.value.replace(/[\u00a0\u202f]/g, " ");
  if (!/^-?[0-9][0-9 ,.٬٫]*$/.test(value)) return null;

  if (value.includes("٫")) {
    value = value.replaceAll("٫", ".");
    normalization.push("ARABIC_DECIMAL_TO_DOT");
  }
  if (value.includes("٬")) {
    value = value.replaceAll("٬", "");
    normalization.push("ARABIC_THOUSANDS_REMOVED");
  }
  if (value.includes(" ")) {
    value = value.replaceAll(" ", "");
    normalization.push("GROUPING_SEPARATOR_REMOVED");
  }

  const lastDot = value.lastIndexOf(".");
  const lastComma = value.lastIndexOf(",");
  const decimalIndex = Math.max(lastDot, lastComma);
  if (decimalIndex < 0 || value.length - decimalIndex - 1 !== 2) return null;
  const decimalSeparator = value[decimalIndex];
  const integer = value.slice(0, decimalIndex).replace(/[.,]/g, "");
  const fraction = value.slice(decimalIndex + 1);
  if (decimalSeparator === ",") normalization.push("DECIMAL_COMMA_TO_DOT");
  if (/[.,]/.test(value.slice(0, decimalIndex))) {
    normalization.push("GROUPING_SEPARATOR_REMOVED");
  }
  if (!/^-?\d+$/.test(integer) || !/^\d{2}$/.test(fraction)) return null;
  const negative = integer.startsWith("-");
  const unsigned = negative ? integer.slice(1) : integer;
  const canonicalInteger = unsigned.replace(/^0+(?=\d)/, "");
  return {
    rawValue: raw,
    value: `${negative ? "-" : ""}${canonicalInteger}.${fraction}`,
    normalization: unique(normalization),
  };
}

function normalizeRate(rawValue: string): Normalized | null {
  const raw = rawValue.trim();
  const mapped = mapDigits(raw);
  let value = mapped.value;
  const normalization = [...mapped.normalization];
  if (value.includes("٫")) {
    value = value.replaceAll("٫", ".");
    normalization.push("ARABIC_DECIMAL_TO_DOT");
  }
  if (value.includes(",")) {
    value = value.replaceAll(",", ".");
    normalization.push("DECIMAL_COMMA_TO_DOT");
  }
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(value)) return null;
  return { rawValue: raw, value, normalization: unique(normalization) };
}

function normalizeDate(rawValue: string): Normalized | null {
  const raw = rawValue.trim();
  const mapped = mapDigits(raw);
  let value = mapped.value;
  const normalization = [...mapped.normalization];
  if (/[/.]/.test(value)) {
    value = value.replace(/[/.]/g, "-");
    normalization.push("DATE_SEPARATOR_TO_HYPHEN");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return { rawValue: raw, value, normalization: unique(normalization) };
}

function provenance(line: Line, normalized: Normalized): ObservationCandidate {
  return {
    ...normalized,
    page: line.page,
    extractionMethod: line.method,
    extractionVersion: line.version,
  };
}

function inlineOrNext(
  lines: Line[], index: number, inline: string,
  parse: (value: string) => Normalized | null,
): Normalized | null {
  if (inline.trim()) return parse(inline);
  const current = lines[index];
  const next = lines[index + 1];
  if (!current || next?.page !== current.page) return null;
  return parse(next.text);
}

function amountFromLine(lines: Line[], index: number): Normalized | null {
  const current = lines[index];
  if (!current) return null;
  const values = [...current.text.matchAll(amountPattern)]
    .map((match) => match[0]).filter((value): value is string => value !== undefined);
  if (values.length === 1) return normalizeAmount(values[0]);
  if (values.length > 1) return null;
  const next = lines[index + 1];
  return next?.page === current.page ? normalizeAmount(next.text) : null;
}

function invoiceNumberFromLine(text: string): Normalized | null {
  if (!/(?:FACTURE|AVOIR|فاتور)/iu.test(text)) return null;
  const tokens = text.match(/[\p{L}\p{N}][\p{L}\p{N}/-]{3,}/gu) ?? [];
  for (const token of tokens) {
    if (/(?:FACTURE|AVOIR|فاتور)/iu.test(token)) continue;
    if (/\p{N}/u.test(token)) {
      const parsed = normalizeInvoiceNumber(token);
      if (parsed) return parsed;
    }
  }
  return null;
}

export function extractInvoiceObservations(segments: PageText[]): InvoiceObservations {
  const lines = segments.flatMap(({ page, text, method, version }) => text.split(/\r?\n/)
    .map((value) => ({ page, text: value.trim(), method, version }))
    .filter((line) => line.text.length > 0));
  const candidates: Record<ObservationName, ObservationCandidate[]> = {
    supplierName: [], supplierIce: [], customerIce: [], invoiceNumber: [], issuedOn: [],
    amountHt: [], vatAmount: [], amountTtc: [], printedVatRate: [],
  };
  const add = (name: ObservationName, normalized: Normalized | null, line: Line) => {
    if (normalized !== null) candidates[name].push(provenance(line, normalized));
  };

  for (const [index, line] of lines.entries()) {
    const text = line.text;
    const next = lines[index + 1];
    const supplierIceLabel = /(?:^ICE\b|المعرف\s+الموحد\s+للمقاولة)/iu.test(text)
      && !/(?:client|الزبون|العميل)/iu.test(text);
    const customerIceLabel = /(?:ICE\s+(?:client|الزبون|العميل)|معرف\s+(?:الزبون|العميل))/iu.test(text);
    const nextSupplierIceLabel = next !== undefined
      && /(?:^ICE\b|المعرف\s+الموحد\s+للمقاولة)/iu.test(next.text)
      && !/(?:client|الزبون|العميل)/iu.test(next.text);

    if (next?.page === line.page && !/^(?:FACTURE|AVOIR|ICE\b|فاتور)/iu.test(text)
      && nextSupplierIceLabel) {
      add("supplierName", { rawValue: text, value: text, normalization: [] }, line);
    }

    const ice = icePattern.exec(text)?.[1];
    if (customerIceLabel && ice) add("customerIce", normalizeIdentifier(ice, 15), line);
    else if (supplierIceLabel && ice) add("supplierIce", normalizeIdentifier(ice, 15), line);
    if (customerIceLabel && !ice && next?.page === line.page) {
      const nextIce = icePattern.exec(next.text)?.[1];
      if (nextIce) add("customerIce", normalizeIdentifier(nextIce, 15), next);
    }

    add("invoiceNumber", invoiceNumberFromLine(text), line);

    if (/(?:^Date(?:\s+(?:de\s+)?facture)?\b|التاريخ)/iu.test(text)) {
      const rawDate = datePattern.exec(text)?.[1];
      add("issuedOn", rawDate ? normalizeDate(rawDate) : inlineOrNext(lines, index, "", normalizeDate), line);
    }

    if (/(?:Total\s+HT|المجموع\s+(?:دون|قبل)\s+الضريبة|الإجمالي\s+(?:دون|قبل)\s+الضريبة)/iu.test(text)) {
      add("amountHt", amountFromLine(lines, index), line);
    }

    if (/(?:^TVA\b|الضريبة\s+على\s+القيمة\s+المضافة)/iu.test(text)) {
      const rate = new RegExp(`(${digitSequence}{1,2}(?:[,.٫]${digitSequence}{1,2})?)\\s*[٪%]`, "u").exec(text)?.[1];
      add("printedVatRate", rate ? normalizeRate(rate) : null, line);
      add("vatAmount", amountFromLine(lines, index), line);
    }

    if (/(?:Net\s+[àa]\s+payer\s+TTC|Total\s+TTC|Montant\s+TTC|المجموع\s+مع\s+الضريبة|الإجمالي\s+مع\s+الضريبة)/iu.test(text)) {
      add("amountTtc", amountFromLine(lines, index), line);
    }
  }

  const fields = Object.fromEntries(
    observationNames.map((name) => [name, field(candidates[name])]),
  ) as Record<ObservationName, ObservedField>;
  return {
    status: observationNames.every((name) => fields[name].value !== null) ? "COMPLETE" : "PARTIAL",
    fields,
  };
}
