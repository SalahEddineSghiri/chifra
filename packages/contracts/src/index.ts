import { z } from "zod";

// Montants en MAD et taux en pourcentage : jamais de Number pour les calculs.
export const decimalStringSchema = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const id = z.string().min(1);
const sourceSchema = z.strictObject({
  sourceId: id,
  page: z.number().int().positive().nullable(),
  row: z.number().int().positive().nullable(),
});

function observed(valueSchema: z.ZodType<string>) {
  return z.strictObject({
    value: valueSchema.nullable(),
    source: sourceSchema.nullable(),
    missingReason: z.string().min(1).nullable(),
  }).refine(
    (field) => field.value === null
      ? field.source === null && field.missingReason !== null
      : field.source !== null && field.missingReason === null,
    "Une valeur absente exige un motif ; une valeur lue exige une source",
  );
}

export const observationsSchema = z.strictObject({
  invoiceNumber: observed(id),
  supplierName: observed(id),
  supplierIce: observed(id),
  customerIce: observed(id),
  issuedOn: observed(z.iso.date()),
  amountHt: observed(decimalStringSchema),
  vatAmount: observed(decimalStringSchema),
  amountTtc: observed(decimalStringSchema),
  printedVatRate: observed(decimalStringSchema),
  extractionMethod: z.enum(["PDF_TEXT", "OCR", "TABULAR"]),
});

export const referencesSchema = z.strictObject({
  supplierId: id.nullable(),
  ruleId: id.nullable(),
  ruleVersion: id.nullable(),
  expectedVatRate: decimalStringSchema.nullable(),
}).refine(
  (ref) => ref.expectedVatRate === null || (ref.ruleId !== null && ref.ruleVersion !== null),
  "Un taux attendu exige une règle et sa version",
);

const checkSchema = z.strictObject({
  status: z.enum(["CONFORME", "ECART", "NON_EVALUABLE"]),
  difference: decimalStringSchema.nullable(),
  proofId: id.nullable(),
});
const reconciliationSchema = z.strictObject({
  status: z.enum(["NON_RAPPROCHE", "PARTIEL", "RAPPROCHE", "A_REVOIR"]),
  residualMad: decimalStringSchema.nullable(),
  proofIds: z.array(id),
});

export const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  control: z.strictObject({
    batchId: id,
    runId: id,
    documentId: id,
    stage: z.enum(["RECEIVED", "INGESTED", "RECONCILED", "AUDITED", "EXPLAINED", "NON_TRAITE"]),
    attempts: z.number().int().nonnegative(),
    stopReason: z.string().min(1).nullable(),
  }),
  observations: observationsSchema.nullable(),
  references: referencesSchema.nullable(),
  calculations: z.strictObject({
    reconciliation: reconciliationSchema.nullable(),
    arithmetic: checkSchema.nullable(),
    fiscal: checkSchema.nullable(),
  }),
  review: z.strictObject({
    decisionId: id.nullable(),
    memoryIds: z.array(id),
    explanation: z.string().min(1).nullable(),
  }),
});

export type AgentState = z.infer<typeof stateSchema>;
const ingestorSchema = z.strictObject({ observations: observationsSchema });
const reconcilerSchema = z.strictObject({ reconciliation: reconciliationSchema });
const auditorSchema = z.strictObject({ arithmetic: checkSchema, fiscal: checkSchema });
const explainerSchema = z.strictObject({ explanation: z.string().min(1) });

export function initialState(batchId: string, runId: string, documentId: string): AgentState {
  return stateSchema.parse({
    schemaVersion: 1,
    control: { batchId, runId, documentId, stage: "RECEIVED", attempts: 0, stopReason: null },
    observations: null,
    references: null,
    calculations: { reconciliation: null, arithmetic: null, fiscal: null },
    review: { decisionId: null, memoryIds: [], explanation: null },
  });
}

function requireStage(state: AgentState, stage: AgentState["control"]["stage"]): void {
  if (state.control.stage !== stage) throw new Error(`Transition interdite depuis ${state.control.stage}`);
}

// Ces gardes définissent les transitions et droits d'écriture, pas des agents simulés.
export function acceptIngestor(input: unknown, output: unknown): AgentState {
  const state = stateSchema.parse(input);
  requireStage(state, "RECEIVED");
  const parsed = ingestorSchema.parse(output);
  return stateSchema.parse({ ...state, control: { ...state.control, stage: "INGESTED" }, observations: parsed.observations });
}

export function acceptReconciler(input: unknown, output: unknown): AgentState {
  const state = stateSchema.parse(input);
  requireStage(state, "INGESTED");
  const parsed = reconcilerSchema.parse(output);
  return stateSchema.parse({ ...state, control: { ...state.control, stage: "RECONCILED" }, calculations: { ...state.calculations, reconciliation: parsed.reconciliation } });
}

export function acceptAuditor(input: unknown, output: unknown): AgentState {
  const state = stateSchema.parse(input);
  requireStage(state, "RECONCILED");
  const parsed = auditorSchema.parse(output);
  return stateSchema.parse({ ...state, control: { ...state.control, stage: "AUDITED" }, calculations: { ...state.calculations, arithmetic: parsed.arithmetic, fiscal: parsed.fiscal } });
}

export function acceptExplainer(input: unknown, output: unknown): AgentState {
  const state = stateSchema.parse(input);
  requireStage(state, "AUDITED");
  const parsed = explainerSchema.parse(output);
  return stateSchema.parse({ ...state, control: { ...state.control, stage: "EXPLAINED" }, review: { ...state.review, explanation: parsed.explanation } });
}

export function markNonTraite(input: unknown, reason: string): AgentState {
  const state = stateSchema.parse(input);
  if (state.control.stage === "EXPLAINED" || state.control.stage === "NON_TRAITE") throw new Error("Traitement déjà terminé");
  return stateSchema.parse({ ...state, control: { ...state.control, stage: "NON_TRAITE", stopReason: reason } });
}
