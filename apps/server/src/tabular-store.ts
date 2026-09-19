import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { XLSX_PARSER_VERSION, type XlsxOutcome } from "./xlsx.js";

export async function saveTabularOutcome(pool: Pool, sourceId: string, outcome: XlsxOutcome) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const extractionId = randomUUID();
    const text = outcome.status === "DONE"
      ? JSON.stringify(outcome.records.map((record) => record.rawValues))
      : null;
    const extraction = await client.query<{ id: string }>(
      `INSERT INTO source_extractions (
         id, source_id, method, method_version, status, text_content, failure_reason
       ) VALUES ($1, $2, 'TABULAR', $3, $4, $5, $6)
       ON CONFLICT (source_id, method, method_version) DO UPDATE
         SET status = EXCLUDED.status, text_content = EXCLUDED.text_content,
             failure_reason = EXCLUDED.failure_reason
       RETURNING id`,
      [extractionId, sourceId, XLSX_PARSER_VERSION,
        outcome.status === "DONE" ? "SUCCEEDED" : "NON_TRAITE",
        text, outcome.reason],
    );
    const storedExtractionId = extraction.rows[0]?.id;
    if (!storedExtractionId) throw new Error("Extraction XLSX non enregistrée");
    await client.query("DELETE FROM source_extraction_segments WHERE extraction_id = $1", [storedExtractionId]);
    await client.query("DELETE FROM source_tabular_records WHERE source_id = $1", [sourceId]);
    await client.query("DELETE FROM source_observations WHERE source_id = $1", [sourceId]);

    if (outcome.status === "DONE") {
      for (const [index, record] of outcome.records.entries()) {
        await client.query(
          `INSERT INTO source_extraction_segments (
             id, extraction_id, segment_index, row_number, text_content
           ) VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), storedExtractionId, index + 1, record.rowNumber,
            JSON.stringify(record.rawValues)],
        );
        await client.query(
          `INSERT INTO source_tabular_records (
             id, source_id, extraction_id, row_number, external_document_id, status, fields
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [randomUUID(), sourceId, storedExtractionId, record.rowNumber,
            record.externalDocumentId, record.status, JSON.stringify(record.fields)],
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
