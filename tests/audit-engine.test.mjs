import assert from "node:assert/strict";
import { test } from "node:test";
import { auditDocuments } from "../dist/server/audit-engine.js";
import { loadReferenceData } from "../dist/server/reference-data.js";

const reference = loadReferenceData();

function document(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    kind: "INVOICE",
    status: "READY",
    invoiceNumber: "FA-001",
    supplierName: "INFOTECH MAROC",
    supplierIce: "005678901000091",
    customerIce: "001987654000073",
    issuedOn: "2026-03-01",
    account: "6132",
    printedVatRate: "20.00",
    amountHt: "7800.00",
    vatAmount: "1560.00",
    amountTtc: "9360.00",
    ...overrides,
  };
}

function byCode(result, code) {
  return result.documents[0].checks.find((item) => item.code === code);
}

test("une facture normale connue ne reçoit aucune anomalie", () => {
  const result = auditDocuments([document()], reference);
  assert.equal(result.documents[0].status, "PASS");
  assert.equal(result.summary.anomalyCount, 0);
  assert.equal(result.documents[0].supplierReference.matchBy, "ICE");
});

test("cohérence interne et conformité TVA restent deux contrôles distincts", () => {
  const result = auditDocuments([document({
    printedVatRate: "7.00", amountHt: "1000.00", vatAmount: "70.00", amountTtc: "1070.00",
  })], reference);
  assert.equal(byCode(result, "INTERNAL_VAT").status, "PASS");
  assert.equal(byCode(result, "INTERNAL_TTC").status, "PASS");
  assert.equal(byCode(result, "REFERENCE_VAT_RATE").status, "ANOMALY");
  assert.deepEqual(byCode(result, "REFERENCE_VAT_AMOUNT"), {
    code: "REFERENCE_VAT_AMOUNT",
    family: "VAT",
    status: "ANOMALY",
    message: "TVA observée différente de la TVA attendue selon le référentiel.",
    observed: "70.00",
    expected: "200.00",
    differenceMad: "-130.00",
    absoluteExposureMad: "130.00",
    missingFields: [],
    relatedDocumentId: null,
  });
});

test("un écart fiscal positif conserve son signe et son exposition absolue", () => {
  const result = auditDocuments([document({
    amountHt: "1000.00", vatAmount: "210.00", amountTtc: "1210.00",
  })], reference);
  const fiscal = byCode(result, "REFERENCE_VAT_AMOUNT");
  assert.equal(fiscal.status, "ANOMALY");
  assert.equal(fiscal.differenceMad, "10.00");
  assert.equal(fiscal.absoluteExposureMad, "10.00");
});

test("les écarts TTC négatif et positif sont détectés", () => {
  for (const [ttc, difference] of [["1190.00", "-10.00"], ["1210.00", "10.00"]]) {
    const result = auditDocuments([document({
      amountHt: "1000.00", vatAmount: "200.00", amountTtc: ttc,
    })], reference);
    assert.equal(byCode(result, "INTERNAL_TTC").status, "ANOMALY");
    assert.equal(byCode(result, "INTERNAL_TTC").differenceMad, difference);
  }
});

test("les bornes de période sont inclusives", () => {
  for (const [issuedOn, expected] of [
    ["2026-01-01", "PASS"], ["2026-06-30", "PASS"],
    ["2025-12-31", "ANOMALY"], ["2026-07-01", "ANOMALY"],
  ]) {
    const result = auditDocuments([document({ issuedOn })], reference);
    assert.equal(byCode(result, "PERIOD").status, expected);
  }
});

test("un fournisseur inconnu ne reçoit aucun taux inventé", () => {
  const result = auditDocuments([document({
    supplierName: "INCONNU", supplierIce: "999999999999999",
  })], reference);
  assert.equal(byCode(result, "SUPPLIER_REFERENCE").status, "ANOMALY");
  assert.equal(byCode(result, "REFERENCE_VAT_RATE").status, "NOT_EVALUABLE");
  assert.equal(byCode(result, "REFERENCE_VAT_AMOUNT").expected, null);
  assert.equal(result.documents[0].supplierReference, null);
});

test("les champs absents restent non évaluables ou en anomalie sans zéro supposé", () => {
  const result = auditDocuments([document({
    supplierIce: null, amountHt: null, vatAmount: null, amountTtc: null,
  })], reference);
  assert.equal(byCode(result, "MANDATORY_FIELDS").status, "ANOMALY");
  assert.deepEqual(byCode(result, "MANDATORY_FIELDS").missingFields.sort(), [
    "amountHt", "amountTtc", "supplierIce", "vatAmount",
  ]);
  assert.equal(byCode(result, "INTERNAL_TTC").status, "NOT_EVALUABLE");
  assert.equal(byCode(result, "INTERNAL_TTC").observed, null);
});

test("un doublon probable utilise une fenêtre strictement inférieure à sept jours", () => {
  const first = document({ invoiceNumber: "FA-001", issuedOn: "2026-03-01" });
  const near = document({ invoiceNumber: "FA-002", issuedOn: "2026-03-07" });
  const far = document({ invoiceNumber: "FA-003", issuedOn: "2026-03-08" });
  const result = auditDocuments([first, near, far], reference);
  assert.ok(result.documents[0].checks.some((item) =>
    item.code === "PROBABLE_DUPLICATE" && item.relatedDocumentId === near.id));
  assert.ok(!result.documents[0].checks.some((item) =>
    item.code === "PROBABLE_DUPLICATE" && item.relatedDocumentId === far.id));
});

test("un doublon exact conserve les deux pièces sans les fusionner", () => {
  const first = document();
  const second = document();
  const result = auditDocuments([first, second], reference);
  assert.equal(result.documents.length, 2);
  assert.equal(result.documents[0].checks.find((item) => item.code === "EXACT_DUPLICATE")
    .relatedDocumentId, second.id);
  assert.equal(result.documents[1].checks.find((item) => item.code === "EXACT_DUPLICATE")
    .relatedDocumentId, first.id);
});

test("le seuil aberrant est strictement supérieur à dix fois la moyenne", () => {
  const controlledReference = {
    ...reference,
    suppliers: reference.suppliers.map((supplier) => supplier.ice === "005678901000091"
      ? { ...supplier, averageTtcMad: "100.00" } : supplier),
  };
  const limit = auditDocuments([document({ amountTtc: "1000.00" })], controlledReference);
  const above = auditDocuments([document({ amountTtc: "1000.01" })], controlledReference);
  assert.equal(byCode(limit, "ABNORMAL_AMOUNT").status, "PASS");
  assert.equal(byCode(above, "ABNORMAL_AMOUNT").status, "ANOMALY");
});

test("un compte inconnu ou différent reste séparé de la valeur observée", () => {
  const unknown = auditDocuments([document({ account: "9999" })], reference);
  const different = auditDocuments([document({ account: "6125" })], reference);
  assert.equal(byCode(unknown, "ACCOUNT").observed, "9999");
  assert.equal(byCode(unknown, "ACCOUNT").status, "ANOMALY");
  assert.equal(byCode(different, "ACCOUNT").observed, "6125");
  assert.equal(byCode(different, "ACCOUNT").expected, "6132");
});
