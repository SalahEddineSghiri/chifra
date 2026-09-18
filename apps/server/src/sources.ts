import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import type { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { SourceJob } from "./queue.js";

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const sourceParamsSchema = z.strictObject({ batchId: z.uuid() });

type SourceRow = {
  id: string;
  original_filename: string;
  status: string;
  created_at: Date;
  extraction_status: string | null;
  extraction_method: string | null;
  failure_reason: string | null;
  text_preview: string | null;
};

export function registerSourceRoutes(
  app: FastifyInstance,
  pool: Pool,
  queue: Queue<SourceJob>,
  sourceDir: string,
) {
  app.register(multipart, { limits: { files: 1, parts: 1, fileSize: MAX_FILE_BYTES } });

  app.get("/api/batches/:batchId/sources", async (request, reply) => {
    const params = sourceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identifiant de lot invalide." });

    const batch = await pool.query("SELECT 1 FROM batches WHERE id = $1", [params.data.batchId]);
    if (batch.rowCount === 0) return reply.code(404).send({ error: "Lot introuvable." });

    const result = await pool.query<SourceRow>(
      `SELECT sf.id, sf.original_filename, sf.status, sf.created_at,
              se.status AS extraction_status, se.method AS extraction_method,
              se.failure_reason, left(se.text_content, 2000) AS text_preview
         FROM source_files sf
         LEFT JOIN LATERAL (
           SELECT status, method, failure_reason, text_content
             FROM source_extractions
            WHERE source_id = sf.id
            ORDER BY created_at DESC, id DESC LIMIT 1
         ) se ON true
        WHERE sf.batch_id = $1
        ORDER BY sf.created_at DESC, sf.id DESC`,
      [params.data.batchId],
    );

    return {
      sources: result.rows.map((row) => ({
        id: row.id,
        filename: row.original_filename,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        extractionStatus: row.extraction_status,
        extractionMethod: row.extraction_method,
        failureReason: row.failure_reason,
        textPreview: row.text_preview,
      })),
    };
  });

  app.post("/api/batches/:batchId/sources", async (request, reply) => {
    const params = sourceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identifiant de lot invalide." });

    const batch = await pool.query<{ status: string }>(
      "SELECT status FROM batches WHERE id = $1", [params.data.batchId],
    );
    if (batch.rowCount === 0) return reply.code(404).send({ error: "Lot introuvable." });
    if (batch.rows[0]?.status !== "OPEN") {
      return reply.code(409).send({ error: "Le lot n'accepte plus de fichiers." });
    }

    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "Fichier PDF requis." });

    const sourceId = randomUUID();
    const storageKey = `${sourceId}.pdf`;
    const temporaryPath = join(sourceDir, `${sourceId}.upload`);
    const storedPath = join(sourceDir, storageKey);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    let moved = false;
    let persisted = false;

    await mkdir(sourceDir, { recursive: true });
    try {
      const hashStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(file.file, hashStream, createWriteStream(temporaryPath, { flags: "wx" }));
      } catch (error) {
        if (file.file.truncated) {
          return reply.code(413).send({ error: "PDF trop volumineux (15 Mo maximum)." });
        }
        throw error;
      }
      if (file.file.truncated || sizeBytes > MAX_FILE_BYTES) {
        return reply.code(413).send({ error: "PDF trop volumineux (15 Mo maximum)." });
      }

      const filename = basename(file.filename.replaceAll("\\", "/")).trim();
      const handle = await open(temporaryPath, "r");
      const signature = Buffer.alloc(5);
      try {
        await handle.read(signature, 0, 5, 0);
      } finally {
        await handle.close();
      }
      if (sizeBytes === 0 || file.mimetype !== "application/pdf"
        || !filename.toLowerCase().endsWith(".pdf") || filename.length > 255
        || /[\x00-\x1f]/.test(filename)
        || signature.toString("ascii") !== "%PDF-") {
        return reply.code(415).send({ error: "Fichier PDF valide requis." });
      }

      await rename(temporaryPath, storedPath);
      moved = true;
      const result = await pool.query<{ id: string }>(
        `INSERT INTO source_files (
           id, batch_id, content_sha256, original_filename,
           media_type, size_bytes, storage_key
         ) VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6)
         ON CONFLICT (batch_id, content_sha256) DO NOTHING RETURNING id`,
        [sourceId, params.data.batchId, hash.digest("hex"), filename, sizeBytes, storageKey],
      );
      if (result.rowCount === 0) {
        return reply.code(409).send({ error: "Ce fichier existe déjà dans ce lot." });
      }
      persisted = true;

      try {
        await queue.add("extract", { sourceId }, { jobId: sourceId, removeOnComplete: true });
      } catch (error) {
        app.log.error({ err: error, sourceId }, "Envoi à la queue différé");
      }
      return reply.code(202).send({ source: { id: sourceId, status: "RECEIVED" } });
    } finally {
      await rm(temporaryPath, { force: true });
      if (moved && !persisted) await rm(storedPath, { force: true });
    }
  });
}
