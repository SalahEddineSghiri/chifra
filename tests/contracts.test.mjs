import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptAuditor, acceptExplainer, acceptIngestor, acceptReconciler,
  initialState, markNonTraite, stateSchema,
} from "../dist/index.js";

const source = {
  sourceId: "src-1", page: 1, row: null,
  extractionMethod: "PDF_TEXT", extractionVersion: "poppler-v1",
};
const read = (value, rawValue = value) => ({
  value,
  rawValue,
  source,
  missingReason: null,
  normalization: [],
  candidates: [{ value, rawValue, source, normalization: [] }],
  reviewRequired: false,
});
const missing = (reason) => ({
  value: null,
  rawValue: null,
  source: null,
  missingReason: reason,
  normalization: [],
  candidates: [],
  reviewRequired: false,
});
const observations = {
  invoiceNumber: read("F-1"), supplierName: read("Fournisseur test"),
  supplierIce: missing("ICE illisible"), customerIce: read("001987654000073"),
  issuedOn: read("2026-02-10"), amountHt: read("1000.00"),
  vatAmount: read("70.00"), amountTtc: read("1070.00"),
  printedVatRate: read("7"),
};

test("état initial sérialisable avec inconnues à null", () => {
  const state = initialState("batch-1", "run-1", "doc-1");
  assert.equal(state.observations, null);
  assert.deepEqual(stateSchema.parse(JSON.parse(JSON.stringify(state))), state);
});

test("Ingestor refuse les champs dérivés et les montants flottants", () => {
  const state = initialState("batch-1", "run-1", "doc-1");
  const ingested = acceptIngestor(state, { observations });
  assert.equal(ingested.control.stage, "INGESTED");
  assert.equal(ingested.observations.supplierIce.value, null);
  const ocrSource = { ...source, extractionMethod: "OCR", extractionVersion: "tesseract-v1" };
  const mixed = acceptIngestor(state, {
    observations: {
      ...observations,
      amountTtc: {
        value: "1070.00", rawValue: "1070.00", source: ocrSource, missingReason: null,
        normalization: [],
        reviewRequired: false,
        candidates: [{
          value: "1070.00", rawValue: "1070.00", source: ocrSource, normalization: [],
        }],
      },
    },
  });
  assert.equal(mixed.observations.amountTtc.source.extractionMethod, "OCR");
  assert.throws(() => acceptIngestor(state, { observations, expectedVat: "200.00" }));
  assert.throws(() => acceptIngestor(state, { observations: { ...observations, amountHt: read(1000) } }));
  assert.throws(() => acceptIngestor(state, { observations: { ...observations, amountTtc: missing("") } }));
  assert.throws(() => acceptIngestor(state, {
    observations: {
      ...observations,
      amountTtc: {
        value: null, rawValue: null, source: null, missingReason: null,
        normalization: [], candidates: [], reviewRequired: false,
      },
    },
  }));
});

test("un champ ambigu exige une revue humaine sans valeur retenue", () => {
  const state = initialState("batch-1", "run-1", "doc-1");
  const ambiguousAmount = {
    value: null,
    rawValue: null,
    source: null,
    missingReason: "Plusieurs valeurs différentes trouvées.",
    normalization: [],
    candidates: [
      { rawValue: "100.00", value: "100.00", source, normalization: [] },
      { rawValue: "200.00", value: "200.00", source, normalization: [] },
    ],
    reviewRequired: true,
  };
  const ingested = acceptIngestor(state, {
    observations: { ...observations, amountHt: ambiguousAmount },
  });
  assert.equal(ingested.observations.amountHt.value, null);
  assert.equal(ingested.observations.amountHt.reviewRequired, true);
  assert.throws(() => acceptIngestor(state, {
    observations: {
      ...observations,
      amountHt: { ...ambiguousAmount, candidates: [] },
    },
  }));
});

test("transitions et domaines d'écriture des rôles", () => {
  const initial = initialState("batch-1", "run-1", "doc-1");
  assert.throws(() => acceptAuditor(initial, {}));
  const ingested = acceptIngestor(initial, { observations });
  const reconciled = acceptReconciler(ingested, {
    reconciliation: { status: "NON_RAPPROCHE", residualMad: "1070.00", proofIds: ["calc-1"] },
  });
  const audited = acceptAuditor(reconciled, {
    arithmetic: { status: "CONFORME", difference: "0.00", proofId: "calc-2" },
    fiscal: { status: "ECART", difference: "-130.00", proofId: "calc-3" },
  });
  assert.equal(audited.observations.vatAmount.value, "70.00");
  assert.equal(audited.calculations.fiscal.difference, "-130.00");
  assert.throws(() => acceptExplainer(audited, { explanation: "TVA à vérifier", calculations: {} }));
  assert.equal(acceptExplainer(audited, { explanation: "TVA à vérifier" }).control.stage, "EXPLAINED");
  assert.throws(() => acceptIngestor(audited, { observations }));
});

test("Orchestrator arrête un document avec un motif explicite", () => {
  const state = initialState("batch-1", "run-1", "doc-1");
  const stopped = markNonTraite(state, "Source illisible");
  assert.equal(stopped.control.stage, "NON_TRAITE");
  assert.equal(stopped.control.stopReason, "Source illisible");
  assert.throws(() => markNonTraite(state, ""));
  assert.throws(() => markNonTraite(stopped, "Autre motif"));
});
