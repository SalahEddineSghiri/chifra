import { Decimal } from "decimal.js";

export const RECONCILIATION_ENGINE_VERSION = "reconciliation-v1";
export const RECONCILIATION_RULES_VERSION = "payment-matching-rules-v1";
export const ROUNDING_CONVENTION = "ROUND_HALF_UP_2_DECIMALS";
export const PAYMENT_WINDOW_DAYS = 60;
export const MAX_GROUP_SIZE = 3;
export const MAX_GROUP_CANDIDATES = 20;

export type ReconciliationDocument = {
  id: string;
  supplierName: string | null;
  invoiceNumber: string | null;
  issuedOn: string | null;
  kind: "INVOICE" | "CREDIT" | "UNDETERMINED";
  status: "READY" | "REVIEW_REQUIRED";
  amountTtc: string | null;
};

export type ReconciliationBankLine = {
  id: string;
  bookedOn: string;
  label: string;
  debitMad: string;
  creditMad: string;
  classification: "PURCHASE_CANDIDATE" | "SALARY" | "BANK_FEE" | "CLIENT_RECEIPT" | "OTHER";
};

export type AllocationResult = {
  bankLineId: string;
  documentId: string;
  amountMad: string;
};

export type LineReconciliation = {
  bankLineId: string;
  status: "FULLY_MATCHED" | "PARTIALLY_ALLOCATED" | "UNMATCHED"
    | "REVIEW_REQUIRED" | "EXCLUDED" | "WAITING";
  supplierName: string | null;
  paymentAmountMad: string;
  allocatedAmountMad: string;
  unallocatedAmountMad: string;
  reason: string;
  candidateDocumentIds: string[];
  allocations: AllocationResult[];
};

export type DocumentReconciliation = {
  documentId: string;
  amountTtcMad: string | null;
  paidAmountMad: string;
  residualMad: string | null;
  status: "MATCHED" | "PARTIAL" | "UNMATCHED" | "NOT_ELIGIBLE";
};

export type ReconciliationResult = {
  engineVersion: string;
  summary: {
    eligiblePaymentLines: number;
    fullyMatchedLines: number;
    partiallyAllocatedLines: number;
    reviewRequiredLines: number;
    unmatchedLines: number;
    excludedLines: number;
    waitingLines: number;
    matchRatePercent: string | null;
  };
  lines: LineReconciliation[];
  documents: DocumentReconciliation[];
};

type EligibleDocument = ReconciliationDocument & {
  supplierName: string;
  issuedOn: string;
  amount: Decimal;
};

function searchKey(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleUpperCase("fr-FR")
    .replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000);
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function combinations<T>(values: T[], maximumSize: number): T[][] {
  const result: T[][] = [];
  function visit(start: number, selected: T[]) {
    if (selected.length > 0) result.push([...selected]);
    if (selected.length === maximumSize) return;
    for (let index = start; index < values.length; index += 1) {
      const value = values[index];
      if (value === undefined) continue;
      selected.push(value);
      visit(index + 1, selected);
      selected.pop();
    }
  }
  visit(0, []);
  return result;
}

function lineWithoutAllocation(
  line: ReconciliationBankLine,
  status: LineReconciliation["status"],
  reason: string,
  candidates: string[] = [],
): LineReconciliation {
  const amount = new Decimal(line.debitMad);
  return {
    bankLineId: line.id,
    status,
    supplierName: null,
    paymentAmountMad: money(amount),
    allocatedAmountMad: "0.00",
    unallocatedAmountMad: money(amount),
    reason,
    candidateDocumentIds: candidates,
    allocations: [],
  };
}

export function reconcile(
  documents: ReconciliationDocument[],
  bankLines: ReconciliationBankLine[],
): ReconciliationResult {
  const eligibleDocuments: EligibleDocument[] = documents.flatMap((document) => {
    if (document.status !== "READY" || document.kind !== "INVOICE"
      || document.supplierName === null || document.supplierName.trim().length === 0
      || document.issuedOn === null
      || document.amountTtc === null) return [];
    try {
      const amount = new Decimal(document.amountTtc);
      return amount.greaterThan(0)
        ? [{ ...document, supplierName: document.supplierName, issuedOn: document.issuedOn, amount }]
        : [];
    } catch {
      return [];
    }
  });
  const residuals = new Map(eligibleDocuments.map((document) => [document.id, document.amount]));
  const sortedLines = [...bankLines].sort((left, right) =>
    left.bookedOn.localeCompare(right.bookedOn) || left.id.localeCompare(right.id));
  const lines: LineReconciliation[] = [];

  for (const line of sortedLines) {
    if (["SALARY", "BANK_FEE", "CLIENT_RECEIPT"].includes(line.classification)) {
      lines.push(lineWithoutAllocation(line, "EXCLUDED", "Ligne exclue du rapprochement des achats."));
      continue;
    }
    if (line.classification === "OTHER") {
      lines.push(lineWithoutAllocation(line, "WAITING", "Nature bancaire à vérifier."));
      continue;
    }

    const payment = new Decimal(line.debitMad);
    if (!payment.greaterThan(0)) {
      lines.push(lineWithoutAllocation(
        line, "REVIEW_REQUIRED", "Candidat achat sans débit bancaire positif.",
      ));
      continue;
    }
    const labelKey = searchKey(line.label);
    const supplierNames = [...new Set(eligibleDocuments
      .map((document) => document.supplierName)
      .filter((name) => labelKey.includes(searchKey(name))))];
    if (supplierNames.length !== 1) {
      const possible = eligibleDocuments.filter((document) => {
        const residual = residuals.get(document.id);
        const age = daysBetween(document.issuedOn, line.bookedOn);
        return residual?.greaterThan(0) === true && age >= 0 && age <= PAYMENT_WINDOW_DAYS;
      }).map((document) => document.id);
      lines.push(lineWithoutAllocation(
        line, "REVIEW_REQUIRED",
        supplierNames.length === 0
          ? "Fournisseur non identifié de façon déterministe."
          : "Plusieurs fournisseurs sont présents dans le libellé.",
        possible,
      ));
      continue;
    }

    const supplierName = supplierNames[0];
    if (!supplierName) throw new Error("Fournisseur rapproché absent");
    const candidates = eligibleDocuments.filter((document) => {
      const residual = residuals.get(document.id);
      const age = daysBetween(document.issuedOn, line.bookedOn);
      return document.supplierName === supplierName
        && residual?.greaterThan(0) === true && age >= 0 && age <= PAYMENT_WINDOW_DAYS;
    });
    if (candidates.length === 0) {
      const result = lineWithoutAllocation(
        line, "UNMATCHED", "Aucune pièce éligible dans la fenêtre de 60 jours.",
      );
      result.supplierName = supplierName;
      lines.push(result);
      continue;
    }

    const referenced = candidates.filter((document) => document.invoiceNumber !== null
      && labelKey.includes(searchKey(document.invoiceNumber)));
    let selected: EligibleDocument[] | null = referenced.length === 1 ? referenced : null;
    if (referenced.length > 1) {
      const result = lineWithoutAllocation(
        line, "REVIEW_REQUIRED", "Plusieurs pièces correspondent à la référence bancaire.",
        referenced.map((document) => document.id),
      );
      result.supplierName = supplierName;
      lines.push(result);
      continue;
    }
    if (selected === null) {
      if (candidates.length > MAX_GROUP_CANDIDATES) {
        const result = lineWithoutAllocation(
          line, "REVIEW_REQUIRED",
          `Plus de ${MAX_GROUP_CANDIDATES} pièces sont possibles ; recherche combinatoire non exécutée.`,
          candidates.map((document) => document.id),
        );
        result.supplierName = supplierName;
        lines.push(result);
        continue;
      }
      const exactGroups = combinations(candidates, MAX_GROUP_SIZE).filter((group) =>
        group.reduce((sum, document) => sum.plus(residuals.get(document.id) ?? 0), new Decimal(0))
          .equals(payment));
      if (exactGroups.length === 1) selected = exactGroups[0] ?? null;
      else if (exactGroups.length > 1) {
        const result = lineWithoutAllocation(
          line, "REVIEW_REQUIRED", "Plusieurs combinaisons exactes sont possibles.",
          [...new Set(exactGroups.flat().map((document) => document.id))],
        );
        result.supplierName = supplierName;
        lines.push(result);
        continue;
      } else if (candidates.length === 1) selected = candidates;
    }
    if (selected === null) {
      const result = lineWithoutAllocation(
        line, "REVIEW_REQUIRED", "Plusieurs pièces restent possibles sans combinaison exacte unique.",
        candidates.map((document) => document.id),
      );
      result.supplierName = supplierName;
      lines.push(result);
      continue;
    }

    let remainingPayment = payment;
    const allocations: AllocationResult[] = [];
    for (const document of selected) {
      const residual = residuals.get(document.id);
      if (!residual || !residual.greaterThan(0) || !remainingPayment.greaterThan(0)) continue;
      const amount = Decimal.min(residual, remainingPayment);
      residuals.set(document.id, residual.minus(amount));
      remainingPayment = remainingPayment.minus(amount);
      allocations.push({
        bankLineId: line.id, documentId: document.id, amountMad: money(amount),
      });
    }
    const allocated = payment.minus(remainingPayment);
    const leavesDocumentResidual = selected.some((document) =>
      residuals.get(document.id)?.greaterThan(0) === true);
    const fullyMatched = remainingPayment.isZero() && !leavesDocumentResidual;
    lines.push({
      bankLineId: line.id,
      status: fullyMatched ? "FULLY_MATCHED" : "PARTIALLY_ALLOCATED",
      supplierName,
      paymentAmountMad: money(payment),
      allocatedAmountMad: money(allocated),
      unallocatedAmountMad: money(remainingPayment),
      reason: fullyMatched && selected.length > 1
        ? "Combinaison exacte unique de pièces."
        : fullyMatched ? "Pièce unique identifiée."
          : leavesDocumentResidual ? "Paiement partiel affecté à une pièce unique."
            : "Paiement supérieur au résiduel disponible.",
      candidateDocumentIds: selected.map((document) => document.id),
      allocations,
    });
  }

  const documentResults: DocumentReconciliation[] = documents.map((document) => {
    const eligible = eligibleDocuments.find((candidate) => candidate.id === document.id);
    if (!eligible) {
      return {
        documentId: document.id, amountTtcMad: document.amountTtc,
        paidAmountMad: "0.00", residualMad: null, status: "NOT_ELIGIBLE",
      };
    }
    const residual = residuals.get(document.id) ?? eligible.amount;
    const paid = eligible.amount.minus(residual);
    return {
      documentId: document.id,
      amountTtcMad: money(eligible.amount),
      paidAmountMad: money(paid),
      residualMad: money(residual),
      status: residual.isZero() ? "MATCHED" : paid.greaterThan(0) ? "PARTIAL" : "UNMATCHED",
    };
  });
  const eligibleLines = lines.filter((line) => !["EXCLUDED", "WAITING"].includes(line.status));
  const fullyMatchedLines = eligibleLines.filter((line) => line.status === "FULLY_MATCHED").length;
  return {
    engineVersion: RECONCILIATION_ENGINE_VERSION,
    summary: {
      eligiblePaymentLines: eligibleLines.length,
      fullyMatchedLines,
      partiallyAllocatedLines: eligibleLines.filter((line) => line.status === "PARTIALLY_ALLOCATED").length,
      reviewRequiredLines: eligibleLines.filter((line) => line.status === "REVIEW_REQUIRED").length,
      unmatchedLines: eligibleLines.filter((line) => line.status === "UNMATCHED").length,
      excludedLines: lines.filter((line) => line.status === "EXCLUDED").length,
      waitingLines: lines.filter((line) => line.status === "WAITING").length,
      matchRatePercent: eligibleLines.length === 0 ? null
        : new Decimal(fullyMatchedLines).div(eligibleLines.length).mul(100)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    },
    lines,
    documents: documentResults,
  };
}
