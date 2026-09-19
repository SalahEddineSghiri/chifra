import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { readJpegDimensions } from "./jpeg.js";
import { enqueueSource, type SourceJob } from "./queue.js";

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const sourceParamsSchema = z.strictObject({ batchId: z.uuid() });

type SourceRow = {
  id: string;
  original_filename: string;
  media_type: string;
  status: string;
  status_reason: string | null;
  created_at: Date;
  extraction_status: string | null;
  extraction_method: string | null;
  failure_reason: string | null;
  text_preview: string | null;
  observation_status: string | null;
  observation_version: string | null;
  observations: unknown | null;
  extractions: unknown;
};

export function registerSourceRoutes(
  app: FastifyInstance,
  pool: Pool,
  queue: Queue<SourceJob>,
  sourceDir: string,
) {
  app.get("/api/batches/:batchId/sources", async (request, reply) => {
    const params = sourceParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identifiant de lot invalide." });

    const batch = await pool.query("SELECT 1 FROM batches WHERE id = $1", [params.data.batchId]);
    if (batch.rowCount === 0) return reply.code(404).send({ error: "Lot introuvable." });

    const result = await pool.query<SourceRow>(
      `SELECT sf.id, sf.original_filename, sf.media_type, sf.status, sf.status_reason,
              sf.created_at,
              se.status AS extraction_status, se.method AS extraction_method,
              se.failure_reason, left(se.text_content, 2000) AS text_preview,
              so.status AS observation_status, so.parser_version AS observation_version,
              so.fields AS observations,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'method', history.method,
                  'version', history.method_version,
                  'status', history.status,
                  'reason', history.failure_reason,
                  'pages', COALESCE(pages.page_numbers, '[]'::jsonb)
                ) ORDER BY history.created_at,
                  CASE history.method WHEN 'PDF_TEXT' THEN 1 WHEN 'OCR' THEN 2 ELSE 3 END,
                  history.id)
                  FROM source_extractions history
                  LEFT JOIN LATERAL (
                    SELECT jsonb_agg(segment.page_number ORDER BY segment.page_number) AS page_numbers
                      FROM source_extraction_segments segment
                     WHERE segment.extraction_id = history.id
                  ) pages ON true
                 WHERE history.source_id = sf.id
              ), '[]'::jsonb) AS extractions
         FROM source_files sf
         LEFT JOIN LATERAL (
           SELECT status, method, failure_reason, text_content
             FROM source_extractions
            WHERE source_id = sf.id
            ORDER BY created_at DESC,
              CASE method WHEN 'OCR' THEN 2 WHEN 'PDF_TEXT' THEN 1 ELSE 0 END DESC,
              id DESC LIMIT 1
         ) se ON true
         LEFT JOIN source_observations so ON so.source_id = sf.id
        WHERE sf.batch_id = $1
        ORDER BY sf.created_at DESC, sf.id DESC`,
      [params.data.batchId],
    );

    return {
      sources: result.rows.map((row) => ({
        id: row.id,
        filename: row.original_filename,
        mediaType: row.media_type,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        extractionStatus: row.extraction_status,
        extractionMethod: row.extraction_method,
        failureReason: row.status_reason ?? row.failure_reason,
        textPreview: row.text_preview,
        observationStatus: row.observation_status,
        observationVersion: row.observation_version,
        observations: row.observations,
        extractions: row.extractions,
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
    if (!file) return reply.code(400).send({ error: "Fichier PDF ou JPG requis." });

    const sourceId = randomUUID();
    const temporaryPath = join(sourceDir, `${sourceId}.upload`);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    let moved = false;
    let persisted = false;
    let storedPath: string | null = null;

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
          return reply.code(413).send({ error: "Fichier trop volumineux (15 Mo maximum)." });
        }
        throw error;
      }
      if (file.file.truncated || sizeBytes > MAX_FILE_BYTES) {
        return reply.code(413).send({ error: "Fichier trop volumineux (15 Mo maximum)." });
      }

      const filename = basename(file.filename.replaceAll("\\", "/")).trim();
      const handle = await open(temporaryPath, "r");
      const signature = Buffer.alloc(5);
      try {
        await handle.read(signature, 0, 5, 0);
      } finally {
        await handle.close();
      }
      const lowerName = filename.toLowerCase();
      const isPdf = file.mimetype === "application/pdf" && lowerName.endsWith(".pdf")
        && signature.toString("ascii") === "%PDF-";
      const isJpeg = file.mimetype === "image/jpeg"
        && (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg"))
        && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
      if (sizeBytes === 0 || filename.length > 255 || /[\x00-\x1f]/.test(filename)
        || (!isPdf && !isJpeg)) {
        return reply.code(415).send({ error: "Fichier PDF ou JPG valide requis." });
      }
      if (isJpeg && await readJpegDimensions(temporaryPath) === null) {
        return reply.code(415).send({
          error: "Image JPEG invalide ou dimensions supérieures aux limites autorisées.",
        });
      }

      const mediaType = isPdf ? "application/pdf" : "image/jpeg";
      const storageKey = `${sourceId}.${isPdf ? "pdf" : "jpg"}`;
      storedPath = join(sourceDir, storageKey);

      await rename(temporaryPath, storedPath);
      moved = true;
      const result = await pool.query<{ id: string }>(
        `INSERT INTO source_files (
           id, batch_id, content_sha256, original_filename,
           media_type, size_bytes, storage_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (batch_id, content_sha256) DO NOTHING RETURNING id`,
        [sourceId, params.data.batchId, hash.digest("hex"), filename,
          mediaType, sizeBytes, storageKey],
      );
      if (result.rowCount === 0) {
        return reply.code(409).send({ error: "Ce fichier existe déjà dans ce lot." });
      }
      persisted = true;

      try {
        await enqueueSource(queue, sourceId);
      } catch (error) {
        app.log.error({ err: error, sourceId }, "Envoi à la queue différé");
      }
      return reply.code(202).send({ source: { id: sourceId, status: "RECEIVED" } });
    } finally {
      await rm(temporaryPath, { force: true });
      if (moved && !persisted && storedPath) await rm(storedPath, { force: true });
    }
  });
}
