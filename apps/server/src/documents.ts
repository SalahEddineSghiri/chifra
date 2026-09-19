import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { consolidateBatch, summarizeConsolidation } from "./consolidation.js";

const paramsSchema = z.strictObject({ batchId: z.uuid() });

type DocumentRow = {
  id: string;
  external_document_id: string | null;
  kind: string;
  status: string;
  invoice_number: string | null;
  supplier_name: string | null;
  supplier_ice: string | null;
  customer_ice: string | null;
  issued_on: string | null;
  account: string | null;
  printed_vat_rate: string | null;
  amount_ht: string | null;
  vat_amount: string | null;
  amount_ttc: string | null;
};
type RelationRow = {
  document_id: string;
  source_id: string;
  filename: string;
  tabular_record_id: string | null;
  row_number: number | null;
  relation_status: string;
};
type ConflictRow = {
  id: string;
  document_id: string;
  field_name: string;
  document_value: string | null;
  tabular_value: string | null;
  reason: string;
  status: string;
};

export function registerDocumentRoutes(app: FastifyInstance, pool: Pool) {
  app.get("/api/batches/:batchId/documents", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identifiant de lot invalide." });
    const batch = await pool.query<{ status: string }>(
      "SELECT status FROM batches WHERE id = $1", [params.data.batchId],
    );
    if (batch.rowCount === 0) return reply.code(404).send({ error: "Lot introuvable." });

    const documents = await pool.query<DocumentRow>(
      `SELECT id, external_document_id, kind, status, invoice_number, supplier_name,
              supplier_ice, customer_ice, issued_on::text, account,
              printed_vat_rate::text, amount_ht::text, vat_amount::text, amount_ttc::text
         FROM accounting_documents WHERE batch_id = $1 ORDER BY created_at, id`,
      [params.data.batchId],
    );
    const relations = await pool.query<RelationRow>(
      `SELECT ads.document_id, ads.source_id, sf.original_filename AS filename,
              ads.tabular_record_id, str.row_number, ads.relation_status
         FROM accounting_document_sources ads
         JOIN accounting_documents ad ON ad.id = ads.document_id
         JOIN source_files sf ON sf.id = ads.source_id
         LEFT JOIN source_tabular_records str ON str.id = ads.tabular_record_id
        WHERE ad.batch_id = $1 ORDER BY ads.created_at, ads.id`,
      [params.data.batchId],
    );
    const conflicts = await pool.query<ConflictRow>(
      `SELECT id, document_id, field_name, document_value, tabular_value, reason, status
         FROM accounting_document_conflicts
        WHERE batch_id = $1 ORDER BY created_at, id`,
      [params.data.batchId],
    );
    const client = await pool.connect();
    try {
      const summary = await summarizeConsolidation(client, params.data.batchId);
      return {
        batchStatus: batch.rows[0]?.status,
        summary,
        documents: documents.rows.map((document) => ({
          id: document.id,
          externalDocumentId: document.external_document_id,
          kind: document.kind,
          status: document.status,
          invoiceNumber: document.invoice_number,
          supplierName: document.supplier_name,
          supplierIce: document.supplier_ice,
          customerIce: document.customer_ice,
          issuedOn: document.issued_on,
          account: document.account,
          printedVatRate: document.printed_vat_rate,
          amountHt: document.amount_ht,
          vatAmount: document.vat_amount,
          amountTtc: document.amount_ttc,
          sources: relations.rows.filter((relation) => relation.document_id === document.id)
            .map((relation) => ({
              sourceId: relation.source_id,
              filename: relation.filename,
              tabularRecordId: relation.tabular_record_id,
              rowNumber: relation.row_number,
              relationStatus: relation.relation_status,
            })),
          conflicts: conflicts.rows.filter((conflict) => conflict.document_id === document.id)
            .map((conflict) => ({
              id: conflict.id,
              fieldName: conflict.field_name,
              documentValue: conflict.document_value,
              tabularValue: conflict.tabular_value,
              reason: conflict.reason,
              status: conflict.status,
            })),
        })),
      };
    } finally {
      client.release();
    }
  });

  app.post("/api/batches/:batchId/close", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identifiant de lot invalide." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{ status: string }>(
        "SELECT status FROM batches WHERE id = $1 FOR UPDATE", [params.data.batchId],
      );
      if (batch.rowCount === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Lot introuvable." });
      }
      if (batch.rows[0]?.status === "COMPLETED") {
        const summary = await summarizeConsolidation(client, params.data.batchId);
        await client.query("COMMIT");
        return { batch: { id: params.data.batchId, status: "COMPLETED" }, summary };
      }
      if (batch.rows[0]?.status !== "OPEN") {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "La fermeture de ce lot est déjà en cours." });
      }
      const states = await client.query<{ total: number; pending: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status IN ('RECEIVED', 'PROCESSING'))::int AS pending
           FROM source_files WHERE batch_id = $1`,
        [params.data.batchId],
      );
      const counts = states.rows[0];
      if (!counts || counts.total === 0) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "Le lot ne contient aucun document." });
      }
      if (counts.pending > 0) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: `${counts.pending} document(s) sont encore en cours de traitement.`,
        });
      }

      await client.query(
        "UPDATE batches SET status = 'CLOSED', closed_at = now() WHERE id = $1",
        [params.data.batchId],
      );
      const summary = await consolidateBatch(client, params.data.batchId);
      await client.query(
        "UPDATE batches SET status = 'COMPLETED' WHERE id = $1",
        [params.data.batchId],
      );
      await client.query("COMMIT");
      return { batch: { id: params.data.batchId, status: "COMPLETED" }, summary };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
