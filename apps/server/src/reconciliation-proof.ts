import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { z } from "zod";
import { reconcile } from "./reconciliation-engine.js";

const documentSchema = z.strictObject({
  id: z.uuid(),
  supplierName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  issuedOn: z.string().nullable(),
  kind: z.enum(["INVOICE", "CREDIT", "UNDETERMINED"]),
  status: z.enum(["READY", "REVIEW_REQUIRED"]),
  amountTtc: z.string().nullable(),
});
const bankLineSchema = z.strictObject({
  id: z.uuid(),
  bookedOn: z.string(),
  label: z.string(),
  debitMad: z.string(),
  creditMad: z.string(),
  classification: z.enum([
    "PURCHASE_CANDIDATE", "SALARY", "BANK_FEE", "CLIENT_RECEIPT", "OTHER",
  ]),
});
const proofInputSchema = z.object({
  metadata: z.object({
    rulesVersion: z.string(),
    currency: z.literal("MAD"),
    roundingConvention: z.string(),
    paymentWindowDays: z.number().int().positive(),
    maximumGroupSize: z.number().int().positive(),
    maximumGroupCandidates: z.number().int().positive(),
  }),
  documents: z.array(documentSchema),
  bankLines: z.array(bankLineSchema),
  documentSources: z.array(z.object({
    documentId: z.uuid(),
    sourceId: z.uuid(),
    tabularRecordId: z.uuid().nullable(),
    extractionId: z.uuid().nullable(),
    extractionMethod: z.string().nullable(),
    extractionVersion: z.string().nullable(),
  })),
});

type ProofRow = {
  tool_name: string;
  tool_version: string;
  input_payload: unknown;
  output_payload: unknown;
};

export async function replayReconciliationProof(pool: Pool, proofId: string) {
  const result = await pool.query<ProofRow>(
    `SELECT tool_name, tool_version, input_payload, output_payload
       FROM calculation_proofs WHERE id = $1`,
    [proofId],
  );
  const proof = result.rows[0];
  if (!proof) throw new Error("Preuve de calcul introuvable.");
  if (proof.tool_name !== "deterministic-reconciliation") {
    throw new Error("La preuve ne correspond pas au moteur de rapprochement.");
  }
  const input = proofInputSchema.parse(proof.input_payload);
  const replayed = reconcile(input.documents, input.bankLines);
  return {
    proofId,
    toolName: proof.tool_name,
    toolVersion: proof.tool_version,
    rulesVersion: input.metadata.rulesVersion,
    verified: isDeepStrictEqual(replayed, proof.output_payload),
  };
}
