import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { buildApp } from "../dist/server/app.js";
import { createSourceQueue } from "../dist/server/queue.js";
import { startSourceWorker } from "../dist/server/worker.js";

const mediaType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function multipartFile(content, filename) {
  const boundary = `chiffra-${randomUUID()}`;
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test("upload XLSX, worker et provenance tabulaire en PostgreSQL", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "chiffra-xlsx-"));
  const pool = new Pool();
  const queue = createSourceQueue();
  const app = buildApp(pool, queue, sourceDir);
  const closeWorker = await startSourceWorker(pool, queue, sourceDir);
  const content = await readFile(new URL("./fixtures/purchases.xlsx", import.meta.url));

  try {
    const created = await app.inject({
      method: "POST", url: "/api/batches", payload: { name: `Lot XLSX ${randomUUID()}` },
    });
    const batchId = created.json().batch.id;
    const send = () => app.inject({
      method: "POST", url: `/api/batches/${batchId}/sources`,
      ...multipartFile(content, "achats-test.xlsx"),
    });
    const uploaded = await send();
    assert.equal(uploaded.statusCode, 202, uploaded.body);
    const sourceId = uploaded.json().source.id;

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = await pool.query("SELECT status FROM source_files WHERE id = $1", [sourceId]);
      if (["DONE", "FAILED", "NON_TRAITE"].includes(status.rows[0]?.status)) break;
      await sleep(100);
    }

    const listed = await app.inject({ method: "GET", url: `/api/batches/${batchId}/sources` });
    assert.equal(listed.statusCode, 200, listed.body);
    const source = listed.json().sources.find((item) => item.id === sourceId);
    assert.equal(source.status, "DONE");
    assert.equal(source.extractionMethod, "TABULAR");
    assert.deepEqual(source.extractions[0].rows, [2, 3, 4]);
    assert.equal(source.tabularRecords.length, 3);
    assert.equal(source.tabularRecords[0].fields.invoiceNumber.value, "FT-TEST-001");
    assert.equal(source.tabularRecords[0].fields.amountTtc.value, "1200.00");
    assert.equal(source.tabularRecords[0].fields.amountTtc.rawValue, "1200");

    const stored = await pool.query(
      `SELECT count(*)::int AS records,
              min(segment.row_number)::int AS first_row,
              max(segment.row_number)::int AS last_row
         FROM source_tabular_records record
         JOIN source_extraction_segments segment
           ON segment.extraction_id = record.extraction_id
          AND segment.row_number = record.row_number
        WHERE record.source_id = $1`,
      [sourceId],
    );
    assert.deepEqual(stored.rows[0], { records: 3, first_row: 2, last_row: 4 });
    assert.equal((await send()).statusCode, 409);
  } finally {
    await closeWorker();
    await app.close();
    await queue.close();
    await pool.end();
    await rm(sourceDir, { recursive: true, force: true });
  }
});
