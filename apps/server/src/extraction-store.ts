import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ProcessingOutcome } from "./extraction.js";
import { extractInvoiceObservations } from "./observations.js";

export async function saveExtractionOutcome(
  pool: Pool,
  sourceId: string,
  outcome: ProcessingOutcome,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const extractionIds = new Map<string, string>();
    for (const extraction of outcome.attempts) {
      const extractionId = randomUUID();
      const text = extraction.status === "SUCCEEDED"
        ? extraction.segments.map((segment) => segment.text).join("\n\n")
        : null;
      const result = await client.query<{ id: string }>(
        `INSERT INTO source_extractions (
           id, source_id, method, method_version, status, text_content, failure_reason
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source_id, method, method_version) DO UPDATE
           SET status = EXCLUDED.status, text_content = EXCLUDED.text_content,
               failure_reason = EXCLUDED.failure_reason
         RETURNING id`,
        [extractionId, sourceId, extraction.method, extraction.version,
          extraction.status, text, extraction.reason],
      );
      const storedId = result.rows[0]?.id;
      if (!storedId) throw new Error("Extraction non enregistrée");
      extractionIds.set(`${extraction.method}:${extraction.version}`, storedId);
      await client.query("DELETE FROM source_extraction_segments WHERE extraction_id = $1", [storedId]);
      for (const [index, segment] of extraction.segments.entries()) {
        await client.query(
          `INSERT INTO source_extraction_segments (
             id, extraction_id, segment_index, page_number, text_content
           ) VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), storedId, index + 1, segment.page, segment.text],
        );
      }
    }

    await client.query("DELETE FROM source_observations WHERE source_id = $1", [sourceId]);
    if (outcome.selectedSegments.length > 0) {
      const observations = extractInvoiceObservations(outcome.selectedSegments);
      const first = outcome.selectedSegments[0];
      if (!first) throw new Error("Segment sélectionné absent");
      const primaryId = extractionIds.get(`${first.method}:${first.version}`);
      if (!primaryId) throw new Error("Extraction primaire absente");
      await client.query(
        `INSERT INTO source_observations (
           source_id, extraction_id, parser_version, status, fields
         ) VALUES ($1, $2, 'labels-v1', $3, $4::jsonb)`,
        [sourceId, primaryId, observations.status, JSON.stringify(observations.fields)],
      );
      for (const extractionId of new Set(outcome.selectedSegments.map((segment) => {
        const id = extractionIds.get(`${segment.method}:${segment.version}`);
        if (!id) throw new Error("Provenance d'extraction absente");
        return id;
      }))) {
        await client.query(
          "INSERT INTO source_observation_inputs (source_id, extraction_id) VALUES ($1, $2)",
          [sourceId, extractionId],
        );
      }
    }

    await client.query(
      "UPDATE source_files SET status = $2, status_reason = $3 WHERE id = $1",
      [sourceId, outcome.status, outcome.reason],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
