import type { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { getAuditJob, requestAudit } from "./audit-jobs.js";
import { getAudit } from "./audit-store.js";
import type { QueueJob } from "./queue.js";
import type { ReferenceData } from "./reference-data.js";
import { BatchNotCompletedError, BatchNotFoundError } from "./reconciliation-store.js";

const paramsSchema = z.strictObject({ batchId: z.uuid() });

export function registerAuditRoutes(
  app: FastifyInstance,
  pool: Pool,
  queue: Queue<QueueJob>,
  reference: ReferenceData,
) {
  app.get("/api/batches/:batchId/audit", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identifiant de lot invalide." });
    const batch = await pool.query<{ status: string }>(
      "SELECT status FROM batches WHERE id = $1", [params.data.batchId],
    );
    if (batch.rowCount === 0) return reply.code(404).send({ error: "Lot introuvable." });
    return {
      batchStatus: batch.rows[0]?.status,
      reference: {
        version: reference.version,
        accountCount: reference.accounts.size,
        supplierCount: reference.suppliers.length,
        hashes: reference.hashes,
      },
      job: await getAuditJob(pool, params.data.batchId, reference.version),
      audit: await getAudit(pool, params.data.batchId, reference.version),
    };
  });

  app.post("/api/batches/:batchId/audit", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identifiant de lot invalide." });
    try {
      const job = await requestAudit(pool, queue, params.data.batchId, reference);
      return reply.code(job.status === "COMPLETED" ? 200 : 202).send({
        batchStatus: "COMPLETED",
        reference: {
          version: reference.version,
          accountCount: reference.accounts.size,
          supplierCount: reference.suppliers.length,
          hashes: reference.hashes,
        },
        job,
        audit: await getAudit(pool, params.data.batchId, reference.version),
      });
    } catch (error) {
      if (error instanceof BatchNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      if (error instanceof BatchNotCompletedError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });
}
