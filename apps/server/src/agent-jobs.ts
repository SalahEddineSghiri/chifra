import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { Pool } from "pg";
import { AGENT_GRAPH_VERSION } from "./agent-runtime.js";
import { getAgentRun, type AgentRunView } from "./agent-store.js";
import { enqueueAgent, type QueueJob } from "./queue.js";
import { BatchNotCompletedError, BatchNotFoundError } from "./reconciliation-store.js";

export class AgentPrerequisiteError extends Error {}

export async function requestAgentRun(
  pool: Pool,
  queue: Queue<QueueJob>,
  batchId: string,
  referenceVersion: string,
): Promise<AgentRunView> {
  const client = await pool.connect();
  let runId: string | null = null;
  let enqueue = false;
  try {
    await client.query("BEGIN");
    const batch = await client.query<{ status: string }>(
      "SELECT status FROM batches WHERE id = $1 FOR UPDATE", [batchId],
    );
    if (batch.rowCount === 0) throw new BatchNotFoundError("Lot introuvable.");
    if (batch.rows[0]?.status !== "COMPLETED") {
      throw new BatchNotCompletedError("Le lot doit être consolidé avant l'analyse agentique.");
    }
    const proofs = await client.query<{ reconciliation: boolean; audit: boolean }>(
      `SELECT
         EXISTS (SELECT 1 FROM reconciliation_runs WHERE batch_id = $1 AND is_current = true) AS reconciliation,
         EXISTS (SELECT 1 FROM audit_runs WHERE batch_id = $1 AND reference_version = $2) AS audit`,
      [batchId, referenceVersion],
    );
    if (!proofs.rows[0]?.reconciliation || !proofs.rows[0]?.audit) {
      throw new AgentPrerequisiteError(
        "Exécutez d'abord le rapprochement et les contrôles déterministes.",
      );
    }
    const inserted = await client.query<{ id: string; status: string }>(
      `INSERT INTO agent_runs (id, batch_id, graph_version, status)
       VALUES ($1, $2, $3, 'PENDING')
       ON CONFLICT (batch_id, graph_version) DO NOTHING
       RETURNING id, status`,
      [randomUUID(), batchId, AGENT_GRAPH_VERSION],
    );
    let row = inserted.rows[0];
    if (!row) {
      const existing = await client.query<{ id: string; status: string }>(
        "SELECT id, status FROM agent_runs WHERE batch_id = $1 AND graph_version = $2",
        [batchId, AGENT_GRAPH_VERSION],
      );
      row = existing.rows[0];
    }
    if (!row) throw new Error("Demande agentique sans travail persistant.");
    runId = row.id;
    if (row.status === "FAILED") {
      await client.query(
        `UPDATE agent_runs SET status = 'PENDING', failure_reason = NULL,
           current_step = NULL, started_at = NULL, completed_at = NULL
         WHERE id = $1`,
        [runId],
      );
      enqueue = true;
    } else {
      enqueue = row.status === "PENDING" || row.status === "PROCESSING";
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (!runId) throw new Error("Identifiant agentique absent.");
  if (enqueue) await enqueueAgent(queue, runId, batchId);
  const view = await getAgentRun(pool, batchId);
  if (!view) throw new Error("Analyse agentique persistée mais introuvable.");
  return view;
}
