import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  AUDIT_ENGINE_VERSION,
  AUDIT_ROUNDING_CONVENTION,
  AUDIT_RULES_VERSION,
  auditDocuments,
  type AuditDocument,
  type AuditResult,
} from "./audit-engine.js";
import type { ReferenceData } from "./reference-data.js";
import { BatchNotCompletedError, BatchNotFoundError } from "./reconciliation-store.js";

type RunRow = {
  id: string;
  engine_version: string;
  rules_version: string;
  reference_version: string;
  reference_hashes: ReferenceData["hashes"];
  summary: AuditResult["summary"];
  created_at: Date;
};

type ResultRow = {
  document_id: string;
  invoice_number: string | null;
  supplier_name: string | null;
  supplier_ice: string | null;
  issued_on: string | null;
  amount_ttc: string | null;
  status: AuditResult["documents"][number]["status"];
  supplier_reference: AuditResult["documents"][number]["supplierReference"];
  checks: AuditResult["documents"][number]["checks"];
};

type SourceRow = {
  document_id: string;
  source_id: string;
  filename: string;
  row_number: number | null;
};

export type AuditView = {
  id: string;
  engineVersion: string;
  rulesVersion: string;
  referenceVersion: string;
  roundingConvention: string;
  referenceHashes: ReferenceData["hashes"];
  createdAt: string;
  summary: AuditResult["summary"];
  documents: Array<{
    documentId: string;
    invoiceNumber: string | null;
    supplierName: string | null;
    supplierIce: string | null;
    issuedOn: string | null;
    amountTtc: string | null;
    status: AuditResult["documents"][number]["status"];
    supplierReference: AuditResult["documents"][number]["supplierReference"];
    checks: AuditResult["documents"][number]["checks"];
    sources: Array<{ sourceId: string; filename: string; rowNumber: number | null }>;
  }>;
};

async function loadAudit(
  client: PoolClient,
  batchId: string,
  referenceVersion: string,
): Promise<AuditView | null> {
  const runResult = await client.query<RunRow>(
    `SELECT id, engine_version, rules_version, reference_version,
            reference_hashes, summary, created_at
       FROM audit_runs
      WHERE batch_id = $1 AND engine_version = $2 AND reference_version = $3`,
    [batchId, AUDIT_ENGINE_VERSION, referenceVersion],
  );
  const run = runResult.rows[0];
  if (!run) return null;
  const [resultRows, sourceRows] = await Promise.all([
    client.query<ResultRow>(
      `SELECT dar.document_id, ad.invoice_number, ad.supplier_name, ad.supplier_ice,
              ad.issued_on::text, ad.amount_ttc::text, dar.status,
              dar.supplier_reference, dar.checks
         FROM document_audit_results dar
         JOIN accounting_documents ad ON ad.id = dar.document_id
        WHERE dar.run_id = $1 ORDER BY ad.created_at, ad.id`,
      [run.id],
    ),
    client.query<SourceRow>(
      `SELECT ads.document_id, ads.source_id, sf.original_filename AS filename, str.row_number
         FROM accounting_document_sources ads
         JOIN accounting_documents ad ON ad.id = ads.document_id
         JOIN source_files sf ON sf.id = ads.source_id
         LEFT JOIN source_tabular_records str ON str.id = ads.tabular_record_id
        WHERE ad.batch_id = $1 ORDER BY ads.created_at, ads.id`,
      [batchId],
    ),
  ]);
  const sourcesByDocument = new Map<string, SourceRow[]>();
  for (const source of sourceRows.rows) {
    const list = sourcesByDocument.get(source.document_id) ?? [];
    list.push(source);
    sourcesByDocument.set(source.document_id, list);
  }
  return {
    id: run.id,
    engineVersion: run.engine_version,
    rulesVersion: run.rules_version,
    referenceVersion: run.reference_version,
    roundingConvention: AUDIT_ROUNDING_CONVENTION,
    referenceHashes: run.reference_hashes,
    createdAt: run.created_at.toISOString(),
    summary: run.summary,
    documents: resultRows.rows.map((row) => ({
      documentId: row.document_id,
      invoiceNumber: row.invoice_number,
      supplierName: row.supplier_name,
      supplierIce: row.supplier_ice,
      issuedOn: row.issued_on,
      amountTtc: row.amount_ttc,
      status: row.status,
      supplierReference: row.supplier_reference,
      checks: row.checks,
      sources: (sourcesByDocument.get(row.document_id) ?? []).map((source) => ({
        sourceId: source.source_id,
        filename: source.filename,
        rowNumber: source.row_number,
      })),
    })),
  };
}

export async function getAudit(
  pool: Pool,
  batchId: string,
  referenceVersion: string,
): Promise<AuditView | null> {
  const client = await pool.connect();
  try {
    return await loadAudit(client, batchId, referenceVersion);
  } finally {
    client.release();
  }
}

export async function runAudit(
  pool: Pool,
  batchId: string,
  jobId: string,
  reference: ReferenceData,
): Promise<AuditView> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const batch = await client.query<{ status: string }>(
      "SELECT status FROM batches WHERE id = $1 FOR UPDATE", [batchId],
    );
    if (batch.rowCount === 0) throw new BatchNotFoundError("Lot introuvable.");
    if (batch.rows[0]?.status !== "COMPLETED") {
      throw new BatchNotCompletedError("Le lot doit être fermé et consolidé avant l'audit.");
    }
    const existing = await loadAudit(client, batchId, reference.version);
    if (existing) {
      await client.query("COMMIT");
      return existing;
    }
    const documentResult = await client.query<AuditDocument>(
      `SELECT id, kind, status, invoice_number AS "invoiceNumber",
              supplier_name AS "supplierName", supplier_ice AS "supplierIce",
              customer_ice AS "customerIce", issued_on::text AS "issuedOn",
              account, printed_vat_rate::text AS "printedVatRate",
              amount_ht::text AS "amountHt", vat_amount::text AS "vatAmount",
              amount_ttc::text AS "amountTtc"
         FROM accounting_documents WHERE batch_id = $1 ORDER BY created_at, id`,
      [batchId],
    );
    const sourceResult = await client.query(
      `SELECT ads.document_id, ads.source_id, ads.tabular_record_id,
              COALESCE(str.extraction_id, so.extraction_id) AS extraction_id
         FROM accounting_document_sources ads
         JOIN accounting_documents ad ON ad.id = ads.document_id
         LEFT JOIN source_tabular_records str ON str.id = ads.tabular_record_id
         LEFT JOIN source_observations so
           ON so.source_id = ads.source_id AND ads.tabular_record_id IS NULL
        WHERE ad.batch_id = $1 ORDER BY ads.created_at, ads.id`,
      [batchId],
    );
    const documents = documentResult.rows;
    const result = auditDocuments(documents, reference);
    const runId = randomUUID();
    await client.query(
      `INSERT INTO audit_runs (
         id, job_id, batch_id, engine_version, rules_version, reference_version,
         reference_hashes, summary, input_payload, output_payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)`,
      [runId, jobId, batchId, result.engineVersion, result.rulesVersion, reference.version,
        JSON.stringify(reference.hashes), JSON.stringify(result.summary),
        JSON.stringify({
          roundingConvention: AUDIT_ROUNDING_CONVENTION,
          documents,
          documentSources: sourceResult.rows,
        }),
        JSON.stringify(result)],
    );
    for (const document of result.documents) {
      await client.query(
        `INSERT INTO document_audit_results (
           id, run_id, document_id, status, supplier_reference, checks
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [randomUUID(), runId, document.documentId, document.status,
          JSON.stringify(document.supplierReference), JSON.stringify(document.checks)],
      );
    }
    const view = await loadAudit(client, batchId, reference.version);
    if (!view) throw new Error("Audit créé sans résultat lisible");
    await client.query("COMMIT");
    return view;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
