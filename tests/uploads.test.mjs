import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { buildApp } from "../dist/server/app.js";
import { createSourceQueue } from "../dist/server/queue.js";
import { startSourceWorker } from "../dist/server/worker.js";

function makePdf(text) {
  const content = text ? `BT /F1 14 Tf 72 720 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

function multipartPdf(pdf) {
  const boundary = `chiffra-${randomUUID()}`;
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function waitForStatus(pool, sourceId, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query("SELECT status FROM source_files WHERE id = $1", [sourceId]);
    const status = result.rows[0]?.status;
    if (status === expected) return;
    if (status === "FAILED" || status === "NON_TRAITE" || status === "DONE") {
      assert.equal(status, expected);
    }
    await sleep(100);
  }
  assert.fail(`Délai dépassé pour le statut ${expected}`);
}

test("upload PDF, extraction réelle et document sans texte explicite", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "chiffra-sources-"));
  const pool = new Pool();
  const queue = createSourceQueue();
  const app = buildApp(pool, queue, sourceDir);
  const closeWorker = await startSourceWorker(pool, queue, sourceDir);

  try {
    const created = await app.inject({
      method: "POST", url: "/api/batches", payload: { name: `Lot PDF ${randomUUID()}` },
    });
    assert.equal(created.statusCode, 201);
    const batchId = created.json().batch.id;

    const pdf = makePdf("CHIFFRA_TEXTE_TEST");
    const uploaded = await app.inject({
      method: "POST", url: `/api/batches/${batchId}/sources`, ...multipartPdf(pdf),
    });
    assert.equal(uploaded.statusCode, 202, uploaded.body);
    const sourceId = uploaded.json().source.id;
    await waitForStatus(pool, sourceId, "DONE");

    const listed = await app.inject({
      method: "GET", url: `/api/batches/${batchId}/sources`,
    });
    assert.equal(listed.statusCode, 200);
    const source = listed.json().sources.find((item) => item.id === sourceId);
    assert.equal(source.extractionStatus, "SUCCEEDED");
    assert.match(source.textPreview, /CHIFFRA_TEXTE_TEST/);
    const segments = await pool.query(
      "SELECT page_number, text_content, confidence_percent FROM source_extraction_segments WHERE extraction_id = (SELECT id FROM source_extractions WHERE source_id = $1)",
      [sourceId],
    );
    assert.equal(segments.rows[0]?.page_number, 1);
    assert.match(segments.rows[0]?.text_content, /CHIFFRA_TEXTE_TEST/);
    assert.equal(segments.rows[0]?.confidence_percent, null);

    const duplicate = await app.inject({
      method: "POST", url: `/api/batches/${batchId}/sources`, ...multipartPdf(pdf),
    });
    assert.equal(duplicate.statusCode, 409);

    const blank = await app.inject({
      method: "POST", url: `/api/batches/${batchId}/sources`, ...multipartPdf(makePdf("")),
    });
    assert.equal(blank.statusCode, 202, blank.body);
    const blankId = blank.json().source.id;
    await waitForStatus(pool, blankId, "NON_TRAITE");
    const all = await app.inject({ method: "GET", url: `/api/batches/${batchId}/sources` });
    const blankSource = all.json().sources.find((item) => item.id === blankId);
    assert.match(blankSource.failureReason, /OCR requis/);
    assert.equal(blankSource.textPreview, null);
  } finally {
    await closeWorker();
    await app.close();
    await queue.close();
    await pool.end();
    await rm(sourceDir, { recursive: true, force: true });
  }
});
