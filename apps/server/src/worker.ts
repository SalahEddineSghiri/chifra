import { join } from "node:path";
import { Queue, Worker, type Job } from "bullmq";
import type { Pool } from "pg";
import { z } from "zod";
import {
  extractionAttempt, extractSourceContent, PDF_TEXT_VERSION, SourceTechnicalError,
} from "./extraction.js";
import { saveExtractionOutcome } from "./extraction-store.js";
import { OCR_VERSION } from "./ocr.js";
import { OBSERVATION_PARSER_VERSION } from "./observations.js";
import {
  enqueueSource, redisConnection, SOURCE_JOB_ATTEMPTS, SOURCE_QUEUE, type SourceJob,
} from "./queue.js";

const jobSchema = z.strictObject({ sourceId: z.uuid() });
const SUPPORTED_MEDIA = ["application/pdf", "image/jpeg"] as const;
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
  const extension = source.media_type === "application/pdf" ? "pdf" : "jpg";
  if (!new RegExp(`^[0-9a-f-]{36}\\.${extension}$`).test(source.storage_key)) {
    throw new SourceTechnicalError(
      source.media_type === "application/pdf" ? "PDF_TEXT" : "OCR",
      [], "Clé de stockage invalide après 3 tentatives.",
    );
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

async function runJob(pool: Pool, sourceDir: string, job: Job<SourceJob>) {
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

async function enqueuePending(pool: Pool, queue: Queue<SourceJob>) {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM source_files
      WHERE status = 'RECEIVED' AND media_type = ANY($1::text[])
      ORDER BY created_at LIMIT 100`,
    [SUPPORTED_MEDIA],
  );
  for (const row of result.rows) await enqueueSource(queue, row.id);
}

export async function startSourceWorker(pool: Pool, queue: Queue<SourceJob>, sourceDir: string) {
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
    [SUPPORTED_MEDIA, OBSERVATION_PARSER_VERSION, OCR_VERSION],
  );
  const worker = new Worker<SourceJob>(
    SOURCE_QUEUE,
    async (job) => runJob(pool, sourceDir, job),
    { connection: redisConnection(), concurrency },
  );
  worker.on("failed", (job, error) => {
    console.error(JSON.stringify({
      sourceId: job?.data.sourceId,
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
