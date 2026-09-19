import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcile } from "../dist/server/reconciliation-engine.js";

function document(id, supplierName, amountTtc, issuedOn = "2026-01-01", invoiceNumber = id) {
  return {
    id, supplierName, invoiceNumber, issuedOn,
    kind: "INVOICE", status: "READY", amountTtc,
  };
}

function line(id, label, debitMad, bookedOn = "2026-01-15", classification = "PURCHASE_CANDIDATE") {
  return { id, label, debitMad, creditMad: "0.00", bookedOn, classification };
}

test("une combinaison exacte unique rapproche trois factures", () => {
  const result = reconcile([
    document("d1", "BUREAU VERITAS MAROC", "120.00"),
    document("d2", "BUREAU VERITAS MAROC", "240.00"),
    document("d3", "BUREAU VERITAS MAROC", "360.00"),
  ], [line("l1", "VIR BUREAU VERITAS MAROC REGROUPEMENT", "720.00")]);

  assert.equal(result.lines[0].status, "FULLY_MATCHED");
  assert.deepEqual(result.lines[0].allocations.map((allocation) => allocation.amountMad), [
    "120.00", "240.00", "360.00",
  ]);
  assert.equal(result.summary.matchRatePercent, "100.00");
  assert.ok(result.documents.every((item) => item.status === "MATCHED"));
});

test("deux paiements successifs conservent le résiduel sans double allocation", () => {
  const result = reconcile(
    [document("d1", "INFOTECH MAROC", "1200.00", "2026-01-01", "FA-001")],
    [
      line("l1", "VIR INFOTECH MAROC FA-001 ACOMPTE", "450.00", "2026-01-10"),
      line("l2", "VIR INFOTECH MAROC FA-001 SOLDE", "750.00", "2026-01-20"),
    ],
  );

  assert.equal(result.lines[0].status, "PARTIALLY_ALLOCATED");
  assert.equal(result.lines[1].status, "FULLY_MATCHED");
  assert.deepEqual(result.lines.flatMap((item) => item.allocations.map((allocation) => allocation.amountMad)), [
    "450.00", "750.00",
  ]);
  assert.deepEqual(result.documents[0], {
    documentId: "d1", amountTtcMad: "1200.00", paidAmountMad: "1200.00",
    residualMad: "0.00", status: "MATCHED",
  });
});

test("la fenêtre de paiement accepte 60 jours et refuse 61 jours", () => {
  const eligible = reconcile(
    [document("d1", "FOURNISSEUR DELAI", "100.00", "2026-01-01")],
    [line("l1", "VIR FOURNISSEUR DELAI", "100.00", "2026-03-02")],
  );
  const late = reconcile(
    [document("d1", "FOURNISSEUR DELAI", "100.00", "2026-01-01")],
    [line("l1", "VIR FOURNISSEUR DELAI", "100.00", "2026-03-03")],
  );

  assert.equal(eligible.lines[0].status, "FULLY_MATCHED");
  assert.equal(late.lines[0].status, "UNMATCHED");
  assert.equal(late.documents[0].residualMad, "100.00");
});

test("un même montant chez deux fournisseurs reste en revue", () => {
  const result = reconcile([
    document("d1", "FOURNISSEUR ALPHA", "600.00"),
    document("d2", "FOURNISSEUR BETA", "600.00"),
  ], [line("l1", "VIR FACTURE 600 MAD", "600.00")]);

  assert.equal(result.lines[0].status, "REVIEW_REQUIRED");
  assert.equal(result.lines[0].allocations.length, 0);
  assert.deepEqual(result.lines[0].candidateDocumentIds, ["d1", "d2"]);
  assert.equal(result.summary.matchRatePercent, "0.00");
});

test("les exclusions et lignes autres restent visibles hors dénominateur", () => {
  const result = reconcile([], [
    line("salary", "VIREMENT SALAIRES", "100.00", "2026-01-01", "SALARY"),
    line("fee", "FRAIS BANCAIRES", "10.00", "2026-01-02", "BANK_FEE"),
    { ...line("client", "REGLEMENT CLIENT", "0.00", "2026-01-03", "CLIENT_RECEIPT"), creditMad: "50.00" },
    line("other", "OPERATION A QUALIFIER", "25.00", "2026-01-04", "OTHER"),
  ]);

  assert.deepEqual(result.lines.map((item) => item.status), [
    "EXCLUDED", "EXCLUDED", "EXCLUDED", "WAITING",
  ]);
  assert.equal(result.summary.eligiblePaymentLines, 0);
  assert.equal(result.summary.excludedLines, 3);
  assert.equal(result.summary.waitingLines, 1);
  assert.equal(result.summary.matchRatePercent, null);
});

test("une pièce en revue et un avoir ne sont pas alloués automatiquement", () => {
  const result = reconcile([
    { ...document("review", "FOURNISSEUR ALPHA", "100.00"), status: "REVIEW_REQUIRED" },
    { ...document("credit", "FOURNISSEUR ALPHA", "-20.00"), kind: "CREDIT" },
  ], [line("l1", "VIR FOURNISSEUR ALPHA", "100.00")]);

  assert.equal(result.lines[0].status, "REVIEW_REQUIRED");
  assert.ok(result.documents.every((item) => item.status === "NOT_ELIGIBLE"));
  assert.equal(result.lines[0].allocations.length, 0);
});

test("la recherche de regroupement est bornée", () => {
  const documents = Array.from({ length: 21 }, (_, index) =>
    document(`d${index}`, "FOURNISSEUR NOMBREUX", "10.00"));
  const result = reconcile(
    documents,
    [line("l1", "VIR FOURNISSEUR NOMBREUX REGROUPEMENT", "30.00")],
  );

  assert.equal(result.lines[0].status, "REVIEW_REQUIRED");
  assert.match(result.lines[0].reason, /Plus de 20 pièces/);
  assert.equal(result.lines[0].allocations.length, 0);
});

test("un mouvement crédit classé par erreur comme achat n'est jamais alloué", () => {
  const candidate = line("l1", "VIR FOURNISSEUR ALPHA", "0.00");
  const result = reconcile(
    [document("d1", "FOURNISSEUR ALPHA", "100.00")],
    [{ ...candidate, creditMad: "100.00" }],
  );

  assert.equal(result.lines[0].status, "REVIEW_REQUIRED");
  assert.equal(result.lines[0].allocations.length, 0);
  assert.equal(result.documents[0].residualMad, "100.00");
});
