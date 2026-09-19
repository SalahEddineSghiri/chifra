import { join } from "node:path";
import { Queue, Worker, type Job } from "bullmq";
import type { Pool } from "pg";
import { z } from "zod";
import {
  extractionAttempt, extractSourceContent, PDF_TEXT_VERSION, SourceTechnicalError,
} from "./extraction.js";
import { saveExtractionOutcome } from "./extraction-store.js";
import { saveTabularOutcome } from "./tabular-store.js";
import { extractXlsx, XLSX_PARSER_VERSION } from "./xlsx.js";
import { OCR_VERSION } from "./ocr.js";
import { OBSERVATION_PARSER_VERSION } from "./observations.js";
import {
  enqueueReconciliation, enqueueSource, redisConnection, SOURCE_JOB_ATTEMPTS, SOURCE_QUEUE,
  type QueueJob, type ReconciliationJob,
} from "./queue.js";
import { runReconciliation } from "./reconciliation-store.js";

const jobSchema = z.strictObject({ sourceId: z.uuid() });
const reconciliationJobSchema = z.strictObject({
  reconciliationJobId: z.uuid(),
  batchId: z.uuid(),
});
const DOCUMENT_MEDIA = ["application/pdf", "image/jpeg"] as const;
const XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SUPPORTED_MEDIA = [...DOCUMENT_MEDIA, XLSX_MEDIA] as const;
type ClaimedSource = { storage_key: string; media_type: string };

async function claimSource(pool: Pool, sourceId: string): Promise<ClaimedSource | null> {
  const result = await pool.query<ClaimedSource>(
    `UPDATE source_files SET status = 'PROCESSING', status_reason = NULL
      WHERE id = $1 AND status = 'RECEIVED' AND media_type = ANY($2::text[])
      RETURNING storage_key, media_type`,
    [sourceId, SUPPORTED_MEDIA],
  );
  return result.rows[0] ?? null;
}

async function processSource(pool: Pool, sourceDir: string, sourceId: string) {
  const source = await claimSource(pool, sourceId);
  if (!source) return;
  const extension = source.media_type === "application/pdf" ? "pdf"
    : source.media_type === "image/jpeg" ? "jpg" : "xlsx";
  if (!new RegExp(`^[0-9a-f-]{36}\\.${extension}$`).test(source.storage_key)) {
    if (source.media_type === XLSX_MEDIA) throw new Error("Clé de stockage XLSX invalide");
    throw new SourceTechnicalError(
      source.media_type === "application/pdf" ? "PDF_TEXT" : "OCR",
      [], "Clé de stockage invalide après 3 tentatives.",
    );
  }
  if (source.media_type === XLSX_MEDIA) {
    const outcome = await extractXlsx(join(sourceDir, source.storage_key));
    await saveTabularOutcome(pool, sourceId, outcome);
    return;
  }
  const outcome = await extractSourceContent(
    source.media_type, join(sourceDir, source.storage_key),
  );
  await saveExtractionOutcome(pool, sourceId, outcome);
}

async function releaseForRetry(pool: Pool, sourceId: string) {
  await pool.query(
    "UPDATE source_files SET status = 'RECEIVED', status_reason = NULL WHERE id = $1 AND status = 'PROCESSING'",
    [sourceId],
  );
}

async function runSourceJob(pool: Pool, sourceDir: string, job: Job<QueueJob>) {
  const data = jobSchema.parse(job.data);
  try {
    await processSource(pool, sourceDir, data.sourceId);
  } catch (error) {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? SOURCE_JOB_ATTEMPTS);
    if (error instanceof SourceTechnicalError && finalAttempt) {
      await saveExtractionOutcome(pool, data.sourceId, {
        status: "FAILED",
        reason: error.publicReason,
        attempts: error.attempts.length > 0 ? error.attempts : [
          extractionAttempt(
            error.method,
            error.method === "OCR" ? OCR_VERSION : PDF_TEXT_VERSION,
            "FAILED",
            [],
            error.publicReason,
          ),
        ],
        selectedSegments: [],
      });
    } else if (finalAttempt) {
      await pool.query(
        `UPDATE source_files
            SET status = 'FAILED', status_reason = 'Erreur technique interne après 3 tentatives.'
          WHERE id = $1 AND status = 'PROCESSING'`,
        [data.sourceId],
      );
    } else {
      await releaseForRetry(pool, data.sourceId);
    }
    throw error;
  }
}

async function runReconciliationJob(pool: Pool, job: Job<QueueJob>) {
  const data: ReconciliationJob = reconciliationJobSchema.parse(job.data);
  const claimed = await pool.query(
    `UPDATE reconciliation_jobs
        SET status = 'PROCESSING', failure_reason = NULL, started_at = COALESCE(started_at, now())
      WHERE id = $1 AND batch_id = $2 AND status IN ('PENDING', 'PROCESSING')
      RETURNING id`,
    [data.reconciliationJobId, data.batchId],
  );
  if (claimed.rowCount === 0) return;
  try {
    await runReconciliation(pool, data.batchId, data.reconciliationJobId);
    await pool.query(
      `UPDATE reconciliation_jobs
          SET status = 'COMPLETED', completed_at = now(), failure_reason = NULL
        WHERE id = $1`,
      [data.reconciliationJobId],
    );
  } catch (error) {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? SOURCE_JOB_ATTEMPTS);
    await pool.query(
      `UPDATE reconciliation_jobs
          SET status = $2, failure_reason = $3,
              completed_at = CASE WHEN $2 = 'FAILED' THEN now() ELSE NULL END
        WHERE id = $1`,
      [data.reconciliationJobId, finalAttempt ? "FAILED" : "PENDING",
        finalAttempt ? "Erreur technique interne après 3 tentatives." : null],
    );
    throw error;
  }
}

async function runJob(pool: Pool, sourceDir: string, job: Job<QueueJob>) {
  if (job.name === "reconcile") {
    await runReconciliationJob(pool, job);
    return;
  }
  await runSourceJob(pool, sourceDir, job);
}

async function enqueuePending(pool: Pool, queue: Queue<QueueJob>) {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM source_files
      WHERE status = 'RECEIVED' AND media_type = ANY($1::text[])
      ORDER BY created_at LIMIT 100`,
    [SUPPORTED_MEDIA],
  );
  for (const row of result.rows) await enqueueSource(queue, row.id);
  const reconciliationJobs = await pool.query<{ id: string; batch_id: string }>(
    `SELECT id, batch_id FROM reconciliation_jobs
      WHERE status = 'PENDING' ORDER BY created_at LIMIT 100`,
  );
  for (const row of reconciliationJobs.rows) {
    await enqueueReconciliation(queue, row.id, row.batch_id);
  }
}

export async function startSourceWorker(pool: Pool, queue: Queue<QueueJob>, sourceDir: string) {
  const concurrency = Number(process.env.WORKER_CONCURRENCY ?? "2");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("WORKER_CONCURRENCY doit être entre 1 et 4");
  }

  await pool.query(
    `UPDATE source_files SET status = 'RECEIVED', status_reason = NULL
      WHERE status = 'PROCESSING' AND media_type = ANY($1::text[])`,
    [SUPPORTED_MEDIA],
  );
  await pool.query(
    `UPDATE source_files sf SET status = 'RECEIVED', status_reason = NULL
      WHERE sf.status = 'NON_TRAITE' AND sf.media_type = 'application/pdf'
        AND EXISTS (
          SELECT 1 FROM source_extractions se
          WHERE se.source_id = sf.id AND se.method = 'PDF_TEXT'
            AND se.failure_reason LIKE '%OCR requis%'
        )`,
  );
  await pool.query(
    `UPDATE source_files sf SET status = 'RECEIVED', status_reason = NULL
      WHERE sf.status = 'NON_TRAITE' AND sf.media_type = ANY($1::text[])
        AND EXISTS (
          SELECT 1 FROM source_extractions se
          WHERE se.source_id = sf.id AND se.method = 'OCR'
        )
        AND NOT EXISTS (
          SELECT 1 FROM source_extractions se
          WHERE se.source_id = sf.id AND se.method = 'OCR' AND se.method_version = $2
        )`,
    [SUPPORTED_MEDIA, OCR_VERSION],
  );
  await pool.query(
    `UPDATE source_files sf SET status = 'RECEIVED', status_reason = NULL
      WHERE sf.status = 'DONE' AND sf.media_type = ANY($1::text[])
        AND EXISTS (
          SELECT 1 FROM source_extractions se
          WHERE se.source_id = sf.id AND se.status = 'SUCCEEDED'
        )
        AND NOT EXISTS (
          SELECT 1 FROM source_observations so
          WHERE so.source_id = sf.id AND so.parser_version = $2
            AND NOT EXISTS (
              SELECT 1 FROM source_observation_inputs soi
              JOIN source_extractions se ON se.id = soi.extraction_id
              WHERE soi.source_id = sf.id AND se.method = 'OCR'
                AND se.method_version <> $3
            )
        )`,
    [DOCUMENT_MEDIA, OBSERVATION_PARSER_VERSION, OCR_VERSION],
  );
  await pool.query(
    `UPDATE source_files sf SET status = 'RECEIVED', status_reason = NULL
       FROM batches b
      WHERE sf.batch_id = b.id AND b.status = 'OPEN'
        AND sf.media_type = $1 AND sf.status IN ('DONE', 'NON_TRAITE', 'FAILED')
        AND NOT EXISTS (
          SELECT 1 FROM source_extractions se
          WHERE se.source_id = sf.id AND se.method = 'TABULAR' AND se.method_version = $2
        )`,
    [XLSX_MEDIA, XLSX_PARSER_VERSION],
  );
  await pool.query(
    `UPDATE reconciliation_jobs
        SET status = 'PENDING', failure_reason = NULL, completed_at = NULL
      WHERE status = 'PROCESSING'`,
  );
  const worker = new Worker<QueueJob>(
    SOURCE_QUEUE,
    async (job) => runJob(pool, sourceDir, job),
    { connection: redisConnection(), concurrency },
  );
  worker.on("failed", (job, error) => {
    console.error(JSON.stringify({
      jobId: job?.id,
      attempt: job?.attemptsMade,
      error: error.name,
    }));
  });

  await enqueuePending(pool, queue);
  const timer = setInterval(() => {
    void enqueuePending(pool, queue).catch((error: unknown) => {
      console.error(JSON.stringify({ operation: "enqueuePending", error: String(error) }));
    });
  }, 30_000);

  return async () => {
    clearInterval(timer);
    await worker.close();
  };
}
