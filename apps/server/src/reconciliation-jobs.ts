import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { Pool } from "pg";
import { RECONCILIATION_ENGINE_VERSION } from "./reconciliation-engine.js";
import { enqueueReconciliation, type QueueJob } from "./queue.js";
import { BatchNotCompletedError, BatchNotFoundError } from "./reconciliation-store.js";

type JobRow = {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  failure_reason: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

export type ReconciliationJobView = {
  id: string;
  status: JobRow["status"];
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

function serializeJob(row: JobRow): ReconciliationJobView {
  return {
    id: row.id,
    status: row.status,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

export async function getReconciliationJob(
  pool: Pool,
  batchId: string,
): Promise<ReconciliationJobView | null> {
  const result = await pool.query<JobRow>(
    `SELECT id, status, failure_reason, created_at, started_at, completed_at
       FROM reconciliation_jobs
      WHERE batch_id = $1 AND engine_version = $2`,
    [batchId, RECONCILIATION_ENGINE_VERSION],
  );
  return result.rows[0] ? serializeJob(result.rows[0]) : null;
}

export async function requestReconciliation(
  pool: Pool,
  queue: Queue<QueueJob>,
  batchId: string,
): Promise<{ created: boolean; job: ReconciliationJobView }> {
  const client = await pool.connect();
  let created = false;
  let row: JobRow | undefined;
  try {
    await client.query("BEGIN");
    const batch = await client.query<{ status: string }>(
      "SELECT status FROM batches WHERE id = $1 FOR UPDATE", [batchId],
    );
    if (batch.rowCount === 0) throw new BatchNotFoundError("Lot introuvable.");
    if (batch.rows[0]?.status !== "COMPLETED") {
      throw new BatchNotCompletedError("Le lot doit être fermé et consolidé avant le rapprochement.");
    }
    const jobId = randomUUID();
    const inserted = await client.query<JobRow>(
      `INSERT INTO reconciliation_jobs (id, batch_id, engine_version, status)
       VALUES ($1, $2, $3, 'PENDING')
       ON CONFLICT (batch_id, engine_version) DO NOTHING
       RETURNING id, status, failure_reason, created_at, started_at, completed_at`,
      [jobId, batchId, RECONCILIATION_ENGINE_VERSION],
    );
    created = inserted.rowCount === 1;
    if (created) row = inserted.rows[0];
    else {
      const existing = await client.query<JobRow>(
        `SELECT id, status, failure_reason, created_at, started_at, completed_at
           FROM reconciliation_jobs WHERE batch_id = $1 AND engine_version = $2`,
        [batchId, RECONCILIATION_ENGINE_VERSION],
      );
      row = existing.rows[0];
    }
    if (!row) throw new Error("Demande de rapprochement sans travail persistant");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (row.status === "PENDING" || row.status === "PROCESSING") {
    await enqueueReconciliation(queue, row.id, batchId);
  }
  return { created, job: serializeJob(row) };
}
