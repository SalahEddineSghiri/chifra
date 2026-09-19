import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { Pool } from "pg";
import { AUDIT_ENGINE_VERSION } from "./audit-engine.js";
import { enqueueAudit, type QueueJob } from "./queue.js";
import type { ReferenceData } from "./reference-data.js";
import { BatchNotCompletedError, BatchNotFoundError } from "./reconciliation-store.js";

type JobRow = {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  failure_reason: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

export type AuditJobView = {
  id: string;
  status: JobRow["status"];
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

function serialize(row: JobRow): AuditJobView {
  return {
    id: row.id,
    status: row.status,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

export async function getAuditJob(
  pool: Pool,
  batchId: string,
  referenceVersion: string,
): Promise<AuditJobView | null> {
  const result = await pool.query<JobRow>(
    `SELECT id, status, failure_reason, created_at, started_at, completed_at
       FROM audit_jobs
      WHERE batch_id = $1 AND engine_version = $2 AND reference_version = $3`,
    [batchId, AUDIT_ENGINE_VERSION, referenceVersion],
  );
  return result.rows[0] ? serialize(result.rows[0]) : null;
}

export async function requestAudit(
  pool: Pool,
  queue: Queue<QueueJob>,
  batchId: string,
  reference: ReferenceData,
): Promise<AuditJobView> {
  const client = await pool.connect();
  let row: JobRow | undefined;
  try {
    await client.query("BEGIN");
    const batch = await client.query<{ status: string }>(
      "SELECT status FROM batches WHERE id = $1 FOR UPDATE", [batchId],
    );
    if (batch.rowCount === 0) throw new BatchNotFoundError("Lot introuvable.");
    if (batch.rows[0]?.status !== "COMPLETED") {
      throw new BatchNotCompletedError("Le lot doit être fermé et consolidé avant l'audit.");
    }
    const inserted = await client.query<JobRow>(
      `INSERT INTO audit_jobs (
         id, batch_id, engine_version, reference_version, status
       ) VALUES ($1, $2, $3, $4, 'PENDING')
       ON CONFLICT (batch_id, engine_version, reference_version) DO NOTHING
       RETURNING id, status, failure_reason, created_at, started_at, completed_at`,
      [randomUUID(), batchId, AUDIT_ENGINE_VERSION, reference.version],
    );
    row = inserted.rows[0];
    if (!row) {
      const existing = await client.query<JobRow>(
        `SELECT id, status, failure_reason, created_at, started_at, completed_at
           FROM audit_jobs
          WHERE batch_id = $1 AND engine_version = $2 AND reference_version = $3`,
        [batchId, AUDIT_ENGINE_VERSION, reference.version],
      );
      row = existing.rows[0];
    }
    if (!row) throw new Error("Demande d'audit sans travail persistant");
    if (row.status === "FAILED") {
      const retried = await client.query<JobRow>(
        `UPDATE audit_jobs
            SET status = 'PENDING', failure_reason = NULL,
                started_at = NULL, completed_at = NULL
          WHERE id = $1
          RETURNING id, status, failure_reason, created_at, started_at, completed_at`,
        [row.id],
      );
      row = retried.rows[0];
    }
    if (!row) throw new Error("Relance d'audit sans travail persistant");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (row.status === "PENDING" || row.status === "PROCESSING") {
    await enqueueAudit(queue, row.id, batchId);
  }
  return serialize(row);
}
