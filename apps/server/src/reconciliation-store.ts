import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  RECONCILIATION_ENGINE_VERSION,
  RECONCILIATION_RULES_VERSION,
  ROUNDING_CONVENTION,
  PAYMENT_WINDOW_DAYS,
  MAX_GROUP_SIZE,
  MAX_GROUP_CANDIDATES,
  reconcile,
  type ReconciliationBankLine,
  type ReconciliationDocument,
  type ReconciliationResult,
} from "./reconciliation-engine.js";

type RunRow = {
  id: string;
  engine_version: string;
  summary: ReconciliationResult["summary"];
  created_at: Date;
  proof_id: string;
  tool_name: string;
  tool_version: string;
  executed_at: Date;
  proof_metadata: ReconciliationProofMetadata;
  document_sources: DocumentSourceProof[];
};

export type ReconciliationProofMetadata = {
  rulesVersion: string;
  currency: "MAD";
  roundingConvention: string;
  paymentWindowDays: number;
  maximumGroupSize: number;
  maximumGroupCandidates: number;
};

export type DocumentSourceProof = {
  documentId: string;
  sourceId: string;
  tabularRecordId: string | null;
  extractionId: string | null;
  extractionMethod: string | null;
  extractionVersion: string | null;
};

type LineRow = {
  bank_line_id: string;
  booked_on: string;
  label: string;
  classification: ReconciliationBankLine["classification"];
  status: ReconciliationResult["lines"][number]["status"];
  supplier_name: string | null;
  payment_amount_mad: string;
  allocated_amount_mad: string;
  unallocated_amount_mad: string;
  reason: string;
  candidate_document_ids: string[];
};

type AllocationRow = {
  bank_line_id: string;
  document_id: string;
  invoice_number: string | null;
  amount_mad: string;
};

type DocumentRow = {
  document_id: string;
  invoice_number: string | null;
  supplier_name: string | null;
  issued_on: string | null;
  amount_ttc_mad: string | null;
  paid_amount_mad: string;
  residual_mad: string | null;
  status: ReconciliationResult["documents"][number]["status"];
};

export class BatchNotFoundError extends Error {}
export class BatchNotCompletedError extends Error {}

export type ReconciliationView = {
  id: string;
  engineVersion: string;
  proofId: string;
  proof: {
    id: string;
    toolName: string;
    toolVersion: string;
    executedAt: string;
    metadata: ReconciliationProofMetadata;
    documentSources: DocumentSourceProof[];
  };
  createdAt: string;
  summary: ReconciliationResult["summary"];
  lines: Array<{
    bankLineId: string;
    bookedOn: string;
    label: string;
    classification: ReconciliationBankLine["classification"];
    status: ReconciliationResult["lines"][number]["status"];
    supplierName: string | null;
    paymentAmountMad: string;
    allocatedAmountMad: string;
    unallocatedAmountMad: string;
    reason: string;
    candidateDocumentIds: string[];
    allocations: Array<{
      documentId: string;
      invoiceNumber: string | null;
      amountMad: string;
    }>;
  }>;
  documents: Array<{
    documentId: string;
    invoiceNumber: string | null;
    supplierName: string | null;
    issuedOn: string | null;
    amountTtcMad: string | null;
    paidAmountMad: string;
    residualMad: string | null;
    status: ReconciliationResult["documents"][number]["status"];
  }>;
};

async function loadCurrent(client: PoolClient, batchId: string): Promise<ReconciliationView | null> {
  const runResult = await client.query<RunRow>(
    `SELECT rr.id, rr.engine_version, rr.summary, rr.created_at, cp.id AS proof_id,
            cp.tool_name, cp.tool_version, cp.executed_at,
            cp.input_payload->'metadata' AS proof_metadata,
            cp.input_payload->'documentSources' AS document_sources
       FROM reconciliation_runs rr
       JOIN calculation_proofs cp ON cp.run_id = rr.id
      WHERE rr.batch_id = $1 AND rr.is_current = true`,
    [batchId],
  );
  const run = runResult.rows[0];
  if (!run) return null;

  const [lineResult, allocationResult, documentResult] = await Promise.all([
    client.query<LineRow>(
      `SELECT rlr.bank_line_id, bl.booked_on::text, bl.label, bl.classification,
              rlr.status, rlr.supplier_name, rlr.payment_amount_mad::text,
              rlr.allocated_amount_mad::text, rlr.unallocated_amount_mad::text,
              rlr.reason, rlr.candidate_document_ids
         FROM reconciliation_line_results rlr
         JOIN bank_lines bl ON bl.id = rlr.bank_line_id
        WHERE rlr.run_id = $1
        ORDER BY bl.booked_on, bl.statement_id, bl.line_number, bl.id`,
      [run.id],
    ),
    client.query<AllocationRow>(
      `SELECT pa.bank_line_id, pa.document_id, ad.invoice_number, pa.amount_mad::text
         FROM payment_allocations pa
         JOIN accounting_documents ad ON ad.id = pa.document_id
        WHERE pa.run_id = $1 ORDER BY pa.created_at, pa.id`,
      [run.id],
    ),
    client.query<DocumentRow>(
      `SELECT rdr.document_id, ad.invoice_number, ad.supplier_name, ad.issued_on::text,
              rdr.amount_ttc_mad::text, rdr.paid_amount_mad::text,
              rdr.residual_mad::text, rdr.status
         FROM reconciliation_document_results rdr
         JOIN accounting_documents ad ON ad.id = rdr.document_id
        WHERE rdr.run_id = $1 ORDER BY ad.created_at, ad.id`,
      [run.id],
    ),
  ]);
  const allocationsByLine = new Map<string, AllocationRow[]>();
  for (const allocation of allocationResult.rows) {
    const current = allocationsByLine.get(allocation.bank_line_id) ?? [];
    current.push(allocation);
    allocationsByLine.set(allocation.bank_line_id, current);
  }

  return {
    id: run.id,
    engineVersion: run.engine_version,
    proofId: run.proof_id,
    proof: {
      id: run.proof_id,
      toolName: run.tool_name,
      toolVersion: run.tool_version,
      executedAt: run.executed_at.toISOString(),
      metadata: run.proof_metadata,
      documentSources: run.document_sources,
    },
    createdAt: run.created_at.toISOString(),
    summary: run.summary,
    lines: lineResult.rows.map((line) => ({
      bankLineId: line.bank_line_id,
      bookedOn: line.booked_on,
      label: line.label,
      classification: line.classification,
      status: line.status,
      supplierName: line.supplier_name,
      paymentAmountMad: line.payment_amount_mad,
      allocatedAmountMad: line.allocated_amount_mad,
      unallocatedAmountMad: line.unallocated_amount_mad,
      reason: line.reason,
      candidateDocumentIds: line.candidate_document_ids,
      allocations: (allocationsByLine.get(line.bank_line_id) ?? []).map((allocation) => ({
        documentId: allocation.document_id,
        invoiceNumber: allocation.invoice_number,
        amountMad: allocation.amount_mad,
      })),
    })),
    documents: documentResult.rows.map((document) => ({
      documentId: document.document_id,
      invoiceNumber: document.invoice_number,
      supplierName: document.supplier_name,
      issuedOn: document.issued_on,
      amountTtcMad: document.amount_ttc_mad,
      paidAmountMad: document.paid_amount_mad,
      residualMad: document.residual_mad,
      status: document.status,
    })),
  };
}

export async function getCurrentReconciliation(
  pool: Pool,
  batchId: string,
): Promise<ReconciliationView | null> {
  const client = await pool.connect();
  try {
    return await loadCurrent(client, batchId);
  } finally {
    client.release();
  }
}

export async function runReconciliation(
  pool: Pool,
  batchId: string,
  jobId: string,
): Promise<{ created: boolean; reconciliation: ReconciliationView }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const batch = await client.query<{ status: string }>(
      "SELECT status FROM batches WHERE id = $1 FOR UPDATE", [batchId],
    );
    if (batch.rowCount === 0) throw new BatchNotFoundError("Lot introuvable.");
    if (batch.rows[0]?.status !== "COMPLETED") {
      throw new BatchNotCompletedError("Le lot doit être fermé et consolidé avant le rapprochement.");
    }

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM reconciliation_runs
        WHERE batch_id = $1 AND engine_version = $2`,
      [batchId, RECONCILIATION_ENGINE_VERSION],
    );
    if (existing.rowCount !== 0) {
      const current = await loadCurrent(client, batchId);
      if (!current) throw new Error("Rapprochement existant sans résultat courant");
      await client.query("COMMIT");
      return { created: false, reconciliation: current };
    }

    const documentResult = await client.query<ReconciliationDocument>(
      `SELECT id, supplier_name AS "supplierName", invoice_number AS "invoiceNumber",
              issued_on::text AS "issuedOn", kind, status, amount_ttc::text AS "amountTtc"
         FROM accounting_documents WHERE batch_id = $1 ORDER BY created_at, id`,
      [batchId],
    );
    const bankLineResult = await client.query<ReconciliationBankLine>(
      `SELECT bl.id, bl.booked_on::text AS "bookedOn", bl.label,
              bl.debit_mad::text AS "debitMad", bl.credit_mad::text AS "creditMad",
              bl.classification
         FROM bank_lines bl
         JOIN bank_statements bs ON bs.id = bl.statement_id
        WHERE bs.batch_id = $1 ORDER BY bl.booked_on, bl.statement_id, bl.line_number, bl.id`,
      [batchId],
    );
    const sourceResult = await client.query<{
      documentId: string;
      sourceId: string;
      tabularRecordId: string | null;
      extractionId: string | null;
      extractionMethod: string | null;
      extractionVersion: string | null;
    }>(
      `SELECT ads.document_id AS "documentId", ads.source_id AS "sourceId",
              ads.tabular_record_id AS "tabularRecordId",
              COALESCE(str.extraction_id, so.extraction_id) AS "extractionId",
              se.method AS "extractionMethod", se.method_version AS "extractionVersion"
         FROM accounting_document_sources ads
         JOIN accounting_documents ad ON ad.id = ads.document_id
         LEFT JOIN source_tabular_records str ON str.id = ads.tabular_record_id
         LEFT JOIN source_observations so
           ON so.source_id = ads.source_id AND ads.tabular_record_id IS NULL
         LEFT JOIN source_extractions se
           ON se.id = COALESCE(str.extraction_id, so.extraction_id)
        WHERE ad.batch_id = $1 ORDER BY ads.created_at, ads.id`,
      [batchId],
    );
    const documents = documentResult.rows;
    const bankLines = bankLineResult.rows;
    const documentSources = sourceResult.rows;
    const metadata: ReconciliationProofMetadata = {
      rulesVersion: RECONCILIATION_RULES_VERSION,
      currency: "MAD",
      roundingConvention: ROUNDING_CONVENTION,
      paymentWindowDays: PAYMENT_WINDOW_DAYS,
      maximumGroupSize: MAX_GROUP_SIZE,
      maximumGroupCandidates: MAX_GROUP_CANDIDATES,
    };
    const result = reconcile(documents, bankLines);
    const runId = randomUUID();
    const proofId = randomUUID();

    await client.query(
      `UPDATE reconciliation_runs
          SET is_current = false, superseded_at = now()
        WHERE batch_id = $1 AND is_current = true`,
      [batchId],
    );
    await client.query(
      `UPDATE payment_allocations SET is_current = false
        WHERE run_id IN (SELECT id FROM reconciliation_runs WHERE batch_id = $1)`,
      [batchId],
    );
    await client.query(
      `INSERT INTO reconciliation_runs (
         id, job_id, batch_id, engine_version, status, summary
       ) VALUES ($1, $2, $3, $4, 'COMPLETED', $5::jsonb)`,
      [runId, jobId, batchId, result.engineVersion, JSON.stringify(result.summary)],
    );
    await client.query(
      `INSERT INTO calculation_proofs (
         id, run_id, tool_name, tool_version, input_payload, output_payload
       ) VALUES ($1, $2, 'deterministic-reconciliation', $3, $4::jsonb, $5::jsonb)`,
      [proofId, runId, result.engineVersion,
        JSON.stringify({ metadata, documents, bankLines, documentSources }), JSON.stringify(result)],
    );

    for (const line of result.lines) {
      await client.query(
        `INSERT INTO reconciliation_line_results (
           id, run_id, proof_id, bank_line_id, status, supplier_name,
           payment_amount_mad, allocated_amount_mad, unallocated_amount_mad,
           reason, candidate_document_ids
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10, $11::uuid[])`,
        [randomUUID(), runId, proofId, line.bankLineId, line.status, line.supplierName,
          line.paymentAmountMad, line.allocatedAmountMad, line.unallocatedAmountMad,
          line.reason, line.candidateDocumentIds],
      );
      for (const allocation of line.allocations) {
        await client.query(
          `INSERT INTO payment_allocations (
             id, run_id, proof_id, bank_line_id, document_id, amount_mad
           ) VALUES ($1, $2, $3, $4, $5, $6::numeric)`,
          [randomUUID(), runId, proofId, allocation.bankLineId,
            allocation.documentId, allocation.amountMad],
        );
      }
    }
    for (const document of result.documents) {
      await client.query(
        `INSERT INTO reconciliation_document_results (
           id, run_id, document_id, amount_ttc_mad, paid_amount_mad, residual_mad, status
         ) VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7)`,
        [randomUUID(), runId, document.documentId, document.amountTtcMad,
          document.paidAmountMad, document.residualMad, document.status],
      );
    }

    const reconciliation = await loadCurrent(client, batchId);
    if (!reconciliation) throw new Error("Rapprochement créé sans résultat lisible");
    await client.query("COMMIT");
    return { created: true, reconciliation };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
