import type { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { AgentPrerequisiteError, requestAgentRun } from "./agent-jobs.js";
import { getAgentRun } from "./agent-store.js";
import type { QueueJob } from "./queue.js";
import { BatchNotCompletedError, BatchNotFoundError } from "./reconciliation-store.js";

const paramsSchema = z.strictObject({ batchId: z.uuid() });

export function registerAgentRoutes(
  app: FastifyInstance,
  pool: Pool,
  queue: Queue<QueueJob>,
  referenceVersion: string,
) {
  app.get("/api/batches/:batchId/agent-analysis", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identifiant de lot invalide." });
    const batch = await pool.query<{ status: string }>("SELECT status FROM batches WHERE id = $1", [params.data.batchId]);
    if (!batch.rows[0]) return reply.code(404).send({ error: "Lot introuvable." });
    return { batchStatus: batch.rows[0].status, run: await getAgentRun(pool, params.data.batchId) };
  });

  app.post("/api/batches/:batchId/agent-analysis", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identifiant de lot invalide." });
    try {
      const run = await requestAgentRun(pool, queue, params.data.batchId, referenceVersion);
      return reply.code(202).send({ batchStatus: "COMPLETED", run });
    } catch (error) {
      if (error instanceof BatchNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof BatchNotCompletedError || error instanceof AgentPrerequisiteError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });
}
