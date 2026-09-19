import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type { Pool } from "pg";
import { z } from "zod";
import {
  BatchNotCompletedError,
  BatchNotFoundError,
  getCurrentReconciliation,
} from "./reconciliation-store.js";
import { getReconciliationJob, requestReconciliation } from "./reconciliation-jobs.js";
import type { QueueJob } from "./queue.js";

const paramsSchema = z.strictObject({ batchId: z.uuid() });

export function registerReconciliationRoutes(
  app: FastifyInstance,
  pool: Pool,
  queue: Queue<QueueJob>,
) {
  app.get("/api/batches/:batchId/reconciliation", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identifiant de lot invalide." });
    const batch = await pool.query<{ status: string }>(
      "SELECT status FROM batches WHERE id = $1", [params.data.batchId],
    );
    if (batch.rowCount === 0) return reply.code(404).send({ error: "Lot introuvable." });
    return {
      batchStatus: batch.rows[0]?.status,
      job: await getReconciliationJob(pool, params.data.batchId),
      reconciliation: await getCurrentReconciliation(pool, params.data.batchId),
    };
  });

  app.post("/api/batches/:batchId/reconciliation", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identifiant de lot invalide." });
    try {
      const result = await requestReconciliation(pool, queue, params.data.batchId);
      return reply.code(result.job.status === "COMPLETED" ? 200 : 202).send({
        batchStatus: "COMPLETED",
        job: result.job,
        reconciliation: await getCurrentReconciliation(pool, params.data.batchId),
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
