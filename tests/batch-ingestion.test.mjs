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

function assemblePdf(objects) {
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let length = parts[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n"),
    ]);
    parts.push(part);
    length += part.length;
  }
  const xrefOffset = length;
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) trailer += `${String(offset).padStart(10, "0")} 00000 n \n`;
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(trailer)]);
}

function makePdf(index) {
  const content = `BT /F1 14 Tf 72 720 Td (FACTURE N LOT-${String(index).padStart(3, "0")}) Tj ET`;
  return assemblePdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`),
  ]);
}

function makeImagePdf(jpeg) {
  const content = "q 612 0 0 612 0 90 cm /Im0 Do Q";
  return assemblePdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>"),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1800 /Height 1300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`),
  ]);
}

function multipartFile(content, filename, mediaType) {
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

async function upload(app, batchId, content, filename, mediaType) {
  const response = await app.inject({
    method: "POST", url: `/api/batches/${batchId}/sources`,
    ...multipartFile(content, filename, mediaType),
  });
  assert.equal(response.statusCode, 202, response.body);
}

test("un lot mixte de 50 documents est traité jusqu'aux états terminaux", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "chiffra-batch-50-"));
  const pool = new Pool();
  const queue = createSourceQueue();
  const app = buildApp(pool, queue, sourceDir);
  const closeWorker = await startSourceWorker(pool, queue, sourceDir);
  const jpeg = await readFile(new URL("./fixtures/ocr-invoice.jpg", import.meta.url));

  try {
    const created = await app.inject({
      method: "POST", url: "/api/batches", payload: { name: `Lot mixte 50 ${randomUUID()}` },
    });
    assert.equal(created.statusCode, 201);
    const batchId = created.json().batch.id;

    for (let index = 1; index <= 48; index += 1) {
      await upload(app, batchId, makePdf(index), `facture-${index}.pdf`, "application/pdf");
    }
    await upload(app, batchId, jpeg, "facture-photo.jpg", "image/jpeg");
    await upload(app, batchId, makeImagePdf(jpeg), "facture-scan.pdf", "application/pdf");

    let states;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      states = await pool.query(
        `SELECT status, count(*)::int AS count FROM source_files
          WHERE batch_id = $1 GROUP BY status ORDER BY status`,
        [batchId],
      );
      const pending = states.rows.some((row) => ["RECEIVED", "PROCESSING"].includes(row.status));
      if (!pending && states.rows.reduce((total, row) => total + row.count, 0) === 50) break;
      await sleep(200);
    }

    assert.deepEqual(states?.rows, [{ status: "DONE", count: 50 }]);
    const methods = await pool.query(
      `SELECT method, count(*)::int AS count FROM source_extractions se
        JOIN source_files sf ON sf.id = se.source_id
       WHERE sf.batch_id = $1 AND se.status = 'SUCCEEDED'
       GROUP BY method ORDER BY method`,
      [batchId],
    );
    assert.deepEqual(methods.rows, [
      { method: "OCR", count: 2 },
      { method: "PDF_TEXT", count: 48 },
    ]);
  } finally {
    await closeWorker();
    await app.close();
    await queue.close();
    await pool.end();
    await rm(sourceDir, { recursive: true, force: true });
  }
});
