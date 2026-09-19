import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { z } from "zod";
import { auditDocuments } from "./audit-engine.js";
import type { ReferenceData } from "./reference-data.js";

const documentSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["INVOICE", "CREDIT", "UNDETERMINED"]),
  status: z.enum(["READY", "REVIEW_REQUIRED"]),
  invoiceNumber: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierIce: z.string().nullable(),
  customerIce: z.string().nullable(),
  issuedOn: z.string().nullable(),
  account: z.string().nullable(),
  printedVatRate: z.string().nullable(),
  amountHt: z.string().nullable(),
  vatAmount: z.string().nullable(),
  amountTtc: z.string().nullable(),
});
const inputSchema = z.object({
  roundingConvention: z.string(),
  documents: z.array(documentSchema),
  documentSources: z.array(z.unknown()),
});

type ProofRow = {
  engine_version: string;
  rules_version: string;
  reference_version: string;
  reference_hashes: ReferenceData["hashes"];
  input_payload: unknown;
  output_payload: unknown;
};

export async function replayAuditProof(pool: Pool, proofId: string, reference: ReferenceData) {
  const result = await pool.query<ProofRow>(
    `SELECT engine_version, rules_version, reference_version, reference_hashes,
            input_payload, output_payload
       FROM audit_runs WHERE id = $1`,
    [proofId],
  );
  const proof = result.rows[0];
  if (!proof) throw new Error("Preuve d'audit introuvable.");
  if (proof.reference_version !== reference.version
    || !isDeepStrictEqual(proof.reference_hashes, reference.hashes)) {
    throw new Error("Les référentiels disponibles diffèrent de ceux de la preuve.");
  }
  const input = inputSchema.parse(proof.input_payload);
  const replayed = auditDocuments(input.documents, reference);
  return {
    proofId,
    engineVersion: proof.engine_version,
    rulesVersion: proof.rules_version,
    referenceVersion: proof.reference_version,
    verified: isDeepStrictEqual(replayed, proof.output_payload),
  };
}
