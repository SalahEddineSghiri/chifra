import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Queue, Worker } from "bullmq";
import type { Pool } from "pg";
import { z } from "zod";
import { extractPdfText, type PdfOutcome } from "./pdf.js";
import { redisConnection, SOURCE_QUEUE, type SourceJob } from "./queue.js";

const jobSchema = z.strictObject({ sourceId: z.uuid() });

type ClaimedSource = { storage_key: string };

async function saveOutcome(pool: Pool, sourceId: string, outcome: PdfOutcome) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const extractionId = randomUUID();
    const text = outcome.status === "SUCCEEDED" ? outcome.text : null;
    const reason = outcome.status === "SUCCEEDED" ? null : outcome.reason;
    const result = await client.query<{ id: string }>(
      `INSERT INTO source_extractions (
         id, source_id, method, method_version, status, text_content, failure_reason
       ) VALUES ($1, $2, 'PDF_TEXT', 'v1', $3, $4, $5)
       ON CONFLICT (source_id, method, method_version) DO UPDATE
         SET status = EXCLUDED.status, text_content = EXCLUDED.text_content,
             failure_reason = EXCLUDED.failure_reason
       RETURNING id`,
      [extractionId, sourceId, outcome.status, text, reason],
    );
    const storedId = result.rows[0]?.id;
    if (!storedId) throw new Error("Extraction non enregistrée");

    await client.query("DELETE FROM source_extraction_segments WHERE extraction_id = $1", [storedId]);
    if (outcome.status === "SUCCEEDED") {
      for (const [index, segment] of outcome.segments.entries()) {
        await client.query(
          `INSERT INTO source_extraction_segments (
             id, extraction_id, segment_index, page_number, text_content
           ) VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), storedId, index + 1, segment.page, segment.text],
        );
      }
    }

    const sourceStatus = outcome.status === "SUCCEEDED" ? "DONE" : outcome.status;
    await client.query("UPDATE source_files SET status = $2 WHERE id = $1", [sourceId, sourceStatus]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function processSource(pool: Pool, sourceDir: string, sourceId: string) {
  const claim = await pool.query<ClaimedSource>(
    `UPDATE source_files SET status = 'PROCESSING'
      WHERE id = $1 AND status = 'RECEIVED' AND media_type = 'application/pdf'
      RETURNING storage_key`,
    [sourceId],
  );
  const storageKey = claim.rows[0]?.storage_key;
  if (!storageKey) return;

  let outcome: PdfOutcome;
  if (!/^[0-9a-f-]{36}\.pdf$/.test(storageKey)) {
    outcome = { status: "FAILED", reason: "Clé de stockage invalide." };
  } else {
    try {
      outcome = await extractPdfText(join(sourceDir, storageKey));
    } catch {
      outcome = { status: "FAILED", reason: "Lecture du PDF impossible." };
    }
  }
  await saveOutcome(pool, sourceId, outcome);
}

async function enqueuePending(pool: Pool, queue: Queue<SourceJob>) {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM source_files
      WHERE status = 'RECEIVED' AND media_type = 'application/pdf'
      ORDER BY created_at LIMIT 100`,
  );
  for (const row of result.rows) {
    await queue.add("extract", { sourceId: row.id }, {
      jobId: row.id, removeOnComplete: true, removeOnFail: true,
    });
  }
}

export async function startSourceWorker(pool: Pool, queue: Queue<SourceJob>, sourceDir: string) {
  const concurrency = Number(process.env.WORKER_CONCURRENCY ?? "2");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("WORKER_CONCURRENCY doit être entre 1 et 4");
  }

  await pool.query(
    `UPDATE source_files SET status = 'RECEIVED'
      WHERE status = 'PROCESSING' AND media_type = 'application/pdf'`,
  );
  const worker = new Worker<SourceJob>(
    SOURCE_QUEUE,
    async (job) => {
      const data = jobSchema.parse(job.data);
      await processSource(pool, sourceDir, data.sourceId);
    },
    { connection: redisConnection(), concurrency },
  );
  worker.on("failed", (job, error) => {
    console.error(JSON.stringify({ sourceId: job?.data.sourceId, error: error.name }));
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
