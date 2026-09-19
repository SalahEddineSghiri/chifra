import { Decimal } from "decimal.js";
import type { ReferenceData, SupplierReference } from "./reference-data.js";

export const AUDIT_ENGINE_VERSION = "audit-v1";
export const AUDIT_RULES_VERSION = "fiscal-rules-v1";
export const AUDIT_ROUNDING_CONVENTION = "ROUND_HALF_UP_2_DECIMALS";

export type AuditDocument = {
  id: string;
  kind: "INVOICE" | "CREDIT" | "UNDETERMINED";
  status: "READY" | "REVIEW_REQUIRED";
  invoiceNumber: string | null;
  supplierName: string | null;
  supplierIce: string | null;
  customerIce: string | null;
  issuedOn: string | null;
  account: string | null;
  printedVatRate: string | null;
  amountHt: string | null;
  vatAmount: string | null;
  amountTtc: string | null;
};

export type AuditCheck = {
  code: string;
  family: "ARITHMETIC" | "VAT" | "PERIOD" | "SUPPLIER" | "MANDATORY"
    | "ACCOUNT" | "ABNORMAL_AMOUNT" | "DUPLICATE" | "SOURCE";
  status: "PASS" | "ANOMALY" | "NOT_EVALUABLE";
  message: string;
  observed: string | null;
  expected: string | null;
  differenceMad: string | null;
  absoluteExposureMad: string | null;
  missingFields: string[];
  relatedDocumentId: string | null;
};

export type DocumentAudit = {
  documentId: string;
  status: "PASS" | "ANOMALY" | "NOT_EVALUABLE";
  supplierReference: null | {
    matchBy: "ICE" | "NAME";
    name: string;
    ice: string;
    category: string;
    usualVatRate: string;
    account: string;
    averageTtcMad: string;
  };
  checks: AuditCheck[];
};

export type AuditResult = {
  engineVersion: string;
  rulesVersion: string;
  referenceVersion: string;
  summary: {
    documentCount: number;
    passedDocumentCount: number;
    anomalousDocumentCount: number;
    nonEvaluableDocumentCount: number;
    anomalyCount: number;
    nonEvaluableCheckCount: number;
    anomaliesByFamily: Record<string, number>;
  };
  documents: DocumentAudit[];
};

function normalized(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleUpperCase("fr-FR")
    .replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function decimal(value: string | null): Decimal | null {
  if (value === null) return null;
  try {
    return new Decimal(value);
  } catch {
    return null;
  }
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function check(
  code: string,
  family: AuditCheck["family"],
  status: AuditCheck["status"],
  message: string,
  values: Partial<Omit<AuditCheck, "code" | "family" | "status" | "message">> = {},
): AuditCheck {
  return {
    code, family, status, message,
    observed: values.observed ?? null,
    expected: values.expected ?? null,
    differenceMad: values.differenceMad ?? null,
    absoluteExposureMad: values.absoluteExposureMad ?? null,
    missingFields: values.missingFields ?? [],
    relatedDocumentId: values.relatedDocumentId ?? null,
  };
}

function supplierFor(
  document: AuditDocument,
  reference: ReferenceData,
): { supplier: SupplierReference; matchBy: "ICE" | "NAME" } | null {
  if (document.supplierIce !== null) {
    const supplier = reference.suppliers.find((item) => item.ice === document.supplierIce);
    return supplier ? { supplier, matchBy: "ICE" } : null;
  }
  if (document.supplierName === null) return null;
  const matches = reference.suppliers.filter((item) =>
    normalized(item.name) === normalized(document.supplierName ?? ""));
  return matches.length === 1 && matches[0] ? { supplier: matches[0], matchBy: "NAME" } : null;
}

function baseChecks(document: AuditDocument, reference: ReferenceData): DocumentAudit {
  const checks: AuditCheck[] = [];
  const supplierMatch = supplierFor(document, reference);
  const amountHt = decimal(document.amountHt);
  const vatAmount = decimal(document.vatAmount);
  const amountTtc = decimal(document.amountTtc);
  const printedRate = decimal(document.printedVatRate);
  const required = {
    supplierIce: document.supplierIce,
    customerIce: document.customerIce,
    invoiceNumber: document.invoiceNumber,
    issuedOn: document.issuedOn,
    amountHt: document.amountHt,
    vatAmount: document.vatAmount,
    amountTtc: document.amountTtc,
  };
  const missingFields = Object.entries(required)
    .filter(([, value]) => value === null || value.trim().length === 0)
    .map(([name]) => name);
  checks.push(check(
    "MANDATORY_FIELDS", "MANDATORY", missingFields.length === 0 ? "PASS" : "ANOMALY",
    missingFields.length === 0 ? "Mentions obligatoires présentes."
      : "Une ou plusieurs mentions obligatoires sont absentes.",
    { missingFields },
  ));

  if (supplierMatch === null) {
    checks.push(check(
      "SUPPLIER_REFERENCE", "SUPPLIER", "ANOMALY",
      "Fournisseur absent du référentiel ; aucun taux ni compte n'est déduit.",
      { observed: document.supplierIce ?? document.supplierName,
        absoluteExposureMad: amountTtc ? money(amountTtc.abs()) : null },
    ));
  } else {
    checks.push(check(
      "SUPPLIER_REFERENCE", "SUPPLIER", "PASS", "Fournisseur identifié dans le référentiel.",
      { observed: document.supplierIce ?? document.supplierName, expected: supplierMatch.supplier.ice },
    ));
    if (document.supplierName !== null
      && normalized(document.supplierName) !== normalized(supplierMatch.supplier.name)) {
      checks.push(check(
        "SUPPLIER_NAME", "SUPPLIER", "ANOMALY",
        "Le nom observé diffère du nom associé à l'ICE de référence.",
        { observed: document.supplierName, expected: supplierMatch.supplier.name },
      ));
    }
  }

  if (document.issuedOn === null) {
    checks.push(check("PERIOD", "PERIOD", "NOT_EVALUABLE", "Date absente."));
  } else {
    const inPeriod = document.issuedOn >= reference.rules.periodStart
      && document.issuedOn <= reference.rules.periodEnd;
    checks.push(check(
      "PERIOD", "PERIOD", inPeriod ? "PASS" : "ANOMALY",
      inPeriod ? "Date comprise dans la période."
        : `Date hors de la période ${reference.rules.periodStart} à ${reference.rules.periodEnd}.`,
      { observed: document.issuedOn,
        expected: `${reference.rules.periodStart}..${reference.rules.periodEnd}`,
        absoluteExposureMad: !inPeriod && amountTtc ? money(amountTtc.abs()) : null },
    ));
  }

  if (amountHt === null || vatAmount === null || printedRate === null) {
    checks.push(check(
      "INTERNAL_VAT", "ARITHMETIC", "NOT_EVALUABLE",
      "HT, TVA observée ou taux imprimé absent.",
    ));
  } else {
    const expected = amountHt.mul(printedRate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const difference = vatAmount.minus(expected);
    checks.push(check(
      "INTERNAL_VAT", "ARITHMETIC", difference.isZero() ? "PASS" : "ANOMALY",
      difference.isZero() ? "TVA observée cohérente avec le taux imprimé."
        : "TVA observée incohérente avec le taux imprimé.",
      { observed: money(vatAmount), expected: money(expected), differenceMad: money(difference),
        absoluteExposureMad: difference.isZero() ? null : money(difference.abs()) },
    ));
  }

  if (amountHt === null || vatAmount === null || amountTtc === null) {
    checks.push(check(
      "INTERNAL_TTC", "ARITHMETIC", "NOT_EVALUABLE", "HT, TVA ou TTC absent.",
    ));
  } else {
    const expected = amountHt.plus(vatAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const difference = amountTtc.minus(expected);
    checks.push(check(
      "INTERNAL_TTC", "ARITHMETIC", difference.isZero() ? "PASS" : "ANOMALY",
      difference.isZero() ? "TTC cohérent avec HT + TVA." : "TTC incohérent avec HT + TVA.",
      { observed: money(amountTtc), expected: money(expected), differenceMad: money(difference),
        absoluteExposureMad: difference.isZero() ? null : money(difference.abs()) },
    ));
  }

  if (supplierMatch === null || printedRate === null) {
    checks.push(check(
      "REFERENCE_VAT_RATE", "VAT", "NOT_EVALUABLE",
      supplierMatch === null ? "Taux attendu inconnu car le fournisseur n'est pas référencé."
        : "Taux imprimé absent.",
    ));
  } else {
    const expectedRate = new Decimal(supplierMatch.supplier.usualVatRate);
    checks.push(check(
      "REFERENCE_VAT_RATE", "VAT", printedRate.equals(expectedRate) ? "PASS" : "ANOMALY",
      printedRate.equals(expectedRate) ? "Taux imprimé conforme au référentiel."
        : "Taux imprimé différent du taux de référence.",
      { observed: printedRate.toFixed(2), expected: expectedRate.toFixed(2) },
    ));
  }

  if (supplierMatch === null || amountHt === null || vatAmount === null) {
    checks.push(check(
      "REFERENCE_VAT_AMOUNT", "VAT", "NOT_EVALUABLE",
      supplierMatch === null ? "TVA attendue inconnue car le fournisseur n'est pas référencé."
        : "HT ou TVA observée absent.",
    ));
  } else {
    const referenceRate = new Decimal(supplierMatch.supplier.usualVatRate);
    const expected = amountHt.mul(referenceRate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const difference = vatAmount.minus(expected);
    checks.push(check(
      "REFERENCE_VAT_AMOUNT", "VAT", difference.isZero() ? "PASS" : "ANOMALY",
      difference.isZero() ? "TVA observée conforme au référentiel."
        : "TVA observée différente de la TVA attendue selon le référentiel.",
      { observed: money(vatAmount), expected: money(expected), differenceMad: money(difference),
        absoluteExposureMad: difference.isZero() ? null : money(difference.abs()) },
    ));
  }

  if (document.account === null) {
    checks.push(check(
      "ACCOUNT", "ACCOUNT", "NOT_EVALUABLE", "Compte observé absent.",
      { expected: supplierMatch?.supplier.account ?? null },
    ));
  } else if (!reference.accounts.has(document.account)) {
    checks.push(check(
      "ACCOUNT", "ACCOUNT", "ANOMALY", "Compte observé absent du plan comptable fourni.",
      { observed: document.account, expected: supplierMatch?.supplier.account ?? null },
    ));
  } else if (supplierMatch && document.account !== supplierMatch.supplier.account) {
    checks.push(check(
      "ACCOUNT", "ACCOUNT", "ANOMALY", "Compte observé différent du compte fournisseur habituel.",
      { observed: document.account, expected: supplierMatch.supplier.account },
    ));
  } else {
    checks.push(check(
      "ACCOUNT", "ACCOUNT", "PASS", "Compte observé reconnu.",
      { observed: document.account, expected: supplierMatch?.supplier.account ?? document.account },
    ));
  }

  if (supplierMatch === null || amountTtc === null || !amountTtc.greaterThan(0)) {
    checks.push(check(
      "ABNORMAL_AMOUNT", "ABNORMAL_AMOUNT", "NOT_EVALUABLE",
      supplierMatch === null ? "Moyenne fournisseur indisponible."
        : "Montant TTC positif indisponible pour ce contrôle.",
    ));
  } else {
    const threshold = new Decimal(supplierMatch.supplier.averageTtcMad)
      .mul(reference.rules.abnormalAmountMultiplier);
    const abnormal = amountTtc.greaterThan(threshold);
    checks.push(check(
      "ABNORMAL_AMOUNT", "ABNORMAL_AMOUNT", abnormal ? "ANOMALY" : "PASS",
      abnormal ? "Montant strictement supérieur à dix fois la moyenne fournisseur."
        : "Montant sous le seuil d'aberration.",
      { observed: money(amountTtc), expected: `<=${money(threshold)}`,
        absoluteExposureMad: abnormal ? money(amountTtc) : null },
    ));
  }

  if (document.status === "REVIEW_REQUIRED") {
    checks.push(check(
      "SOURCE_CONFLICT", "SOURCE", "ANOMALY",
      "La consolidation contient un conflit de sources à résoudre.",
    ));
  }

  return {
    documentId: document.id,
    status: "PASS",
    supplierReference: supplierMatch ? {
      matchBy: supplierMatch.matchBy,
      name: supplierMatch.supplier.name,
      ice: supplierMatch.supplier.ice,
      category: supplierMatch.supplier.category,
      usualVatRate: supplierMatch.supplier.usualVatRate,
      account: supplierMatch.supplier.account,
      averageTtcMad: supplierMatch.supplier.averageTtcMad,
    } : null,
    checks,
  };
}

function supplierIdentity(document: AuditDocument, result: DocumentAudit): string | null {
  if (result.supplierReference) return `REF:${result.supplierReference.ice}`;
  if (document.supplierIce) return `ICE:${document.supplierIce}`;
  if (document.supplierName) return `NAME:${normalized(document.supplierName)}`;
  return null;
}

function daysApart(left: string, right: string): number {
  return Math.abs(Math.round((Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`))
    / 86_400_000));
}

export function auditDocuments(documents: AuditDocument[], reference: ReferenceData): AuditResult {
  const results = documents.map((document) => baseChecks(document, reference));
  for (let leftIndex = 0; leftIndex < documents.length; leftIndex += 1) {
    const left = documents[leftIndex];
    const leftResult = results[leftIndex];
    if (!left || !leftResult) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < documents.length; rightIndex += 1) {
      const right = documents[rightIndex];
      const rightResult = results[rightIndex];
      if (!right || !rightResult || left.kind !== right.kind) continue;
      const leftSupplier = supplierIdentity(left, leftResult);
      const rightSupplier = supplierIdentity(right, rightResult);
      if (leftSupplier === null || leftSupplier !== rightSupplier
        || left.amountTtc === null || right.amountTtc === null
        || !new Decimal(left.amountTtc).equals(right.amountTtc)
        || left.issuedOn === null || right.issuedOn === null) continue;
      const exact = left.invoiceNumber !== null && left.invoiceNumber === right.invoiceNumber
        && left.issuedOn === right.issuedOn && left.amountHt === right.amountHt
        && left.vatAmount === right.vatAmount;
      const gap = daysApart(left.issuedOn, right.issuedOn);
      if (!exact && gap >= reference.rules.duplicateWindowDays) continue;
      const code = exact ? "EXACT_DUPLICATE" : "PROBABLE_DUPLICATE";
      const message = exact ? "Deux pièces métier strictement identiques sont présentes."
        : `Même fournisseur et TTC avec ${gap} jour(s) d'écart.`;
      const exposure = money(new Decimal(left.amountTtc).abs());
      leftResult.checks.push(check(code, "DUPLICATE", "ANOMALY", message, {
        observed: left.amountTtc, expected: null, absoluteExposureMad: exposure,
        relatedDocumentId: right.id,
      }));
      rightResult.checks.push(check(code, "DUPLICATE", "ANOMALY", message, {
        observed: right.amountTtc, expected: null, absoluteExposureMad: exposure,
        relatedDocumentId: left.id,
      }));
    }
  }

  for (const result of results) {
    result.status = result.checks.some((item) => item.status === "ANOMALY") ? "ANOMALY"
      : result.checks.some((item) => item.status === "NOT_EVALUABLE") ? "NOT_EVALUABLE" : "PASS";
  }
  const anomalies = results.flatMap((result) => result.checks)
    .filter((item) => item.status === "ANOMALY");
  const anomaliesByFamily: Record<string, number> = {};
  for (const anomaly of anomalies) {
    anomaliesByFamily[anomaly.family] = (anomaliesByFamily[anomaly.family] ?? 0) + 1;
  }
  return {
    engineVersion: AUDIT_ENGINE_VERSION,
    rulesVersion: AUDIT_RULES_VERSION,
    referenceVersion: reference.version,
    summary: {
      documentCount: results.length,
      passedDocumentCount: results.filter((item) => item.status === "PASS").length,
      anomalousDocumentCount: results.filter((item) => item.status === "ANOMALY").length,
      nonEvaluableDocumentCount: results.filter((item) => item.status === "NOT_EVALUABLE").length,
      anomalyCount: anomalies.length,
      nonEvaluableCheckCount: results.flatMap((item) => item.checks)
        .filter((item) => item.status === "NOT_EVALUABLE").length,
      anomaliesByFamily,
    },
    documents: results,
  };
}
