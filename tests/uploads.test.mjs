import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Pool } from "pg";
import { buildApp } from "../dist/server/app.js";
import { createSourceQueue, enqueueSource } from "../dist/server/queue.js";
import { startSourceWorker } from "../dist/server/worker.js";

const run = promisify(execFile);

function makePdf(text) {
  const lines = Array.isArray(text) ? text : text ? [text] : [];
  const content = lines.length
    ? `BT /F1 14 Tf 72 720 Td ${lines.map((line, index) => `${index ? "0 -18 Td " : ""}(${line}) Tj`).join(" ")} ET`
    : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  return assemblePdf(objects.map((object) => Buffer.from(object)));
}

function makeImagePdf(jpeg, width, height) {
  const content = "q 612 0 0 612 0 90 cm /Im0 Do Q";
  return assemblePdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>"),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`),
  ]);
}

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
  parts.push(Buffer.from(trailer));
  return Buffer.concat(parts);
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

async function waitForStatus(pool, sourceId, expected) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
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

async function upload(app, batchId, content, filename, mediaType) {
  const response = await app.inject({
    method: "POST",
    url: `/api/batches/${batchId}/sources`,
    ...multipartFile(content, filename, mediaType),
  });
  assert.equal(response.statusCode, 202, response.body);
  return response.json().source.id;
}

function assertComplete(source) {
  assert.equal(source.observationStatus, "COMPLETE", JSON.stringify({
    filename: source.filename,
    text: source.textPreview,
    fields: source.observations,
    extractions: source.extractions,
  }, null, 2));
}

async function readSource(app, batchId, sourceId) {
  const response = await app.inject({ method: "GET", url: `/api/batches/${batchId}/sources` });
  assert.equal(response.statusCode, 200);
  return response.json().sources.find((item) => item.id === sourceId);
}

test("OCR PDF/JPG français et anglais, limites arabes, erreurs et reprise", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "chiffra-sources-"));
  const pool = new Pool();
  const queue = createSourceQueue();
  const app = buildApp(pool, queue, sourceDir);
  let closeWorker = await startSourceWorker(pool, queue, sourceDir);
  const invoiceJpeg = await readFile(new URL("./fixtures/ocr-invoice.jpg", import.meta.url));
  const ambiguousJpeg = await readFile(new URL("./fixtures/ocr-ambiguous.jpg", import.meta.url));
  const arabicJpeg = await readFile(new URL("./fixtures/ocr-arabic.jpg", import.meta.url));
  const mixedJpeg = await readFile(new URL("./fixtures/ocr-mixed.jpg", import.meta.url));
  const blankJpeg = await readFile(new URL("./fixtures/ocr-blank.jpg", import.meta.url));

  try {
    const created = await app.inject({
      method: "POST", url: "/api/batches", payload: { name: `Lot sources ${randomUUID()}` },
    });
    assert.equal(created.statusCode, 201);
    const batchId = created.json().batch.id;

    const oversizedJpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
      0x00, 0x01, 0xff, 0xff, 0x03, 0x01, 0x11, 0x00,
      0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
    ]);
    const oversized = await app.inject({
      method: "POST", url: `/api/batches/${batchId}/sources`,
      ...multipartFile(oversizedJpeg, "trop-large.jpg", "image/jpeg"),
    });
    assert.equal(oversized.statusCode, 415);

    const nativeId = await upload(
      app, batchId,
      makePdf(["FOURNISSEUR EXEMPLE", "ICE 005678901000091", "Total HT 7800.00"]),
      "native.pdf", "application/pdf",
    );
    await waitForStatus(pool, nativeId, "DONE");
    const native = await readSource(app, batchId, nativeId);
    assert.deepEqual(native.extractions.map((item) => item.method), ["PDF_TEXT"]);
    assert.match(native.textPreview, /FOURNISSEUR EXEMPLE/);

    const jpgId = await upload(app, batchId, invoiceJpeg, "facture.jpg", "image/jpeg");
    await waitForStatus(pool, jpgId, "DONE");
    const jpg = await readSource(app, batchId, jpgId);
    assert.equal(jpg.mediaType, "image/jpeg");
    assert.deepEqual(jpg.extractions.map((item) => item.method), ["OCR"]);
    assertComplete(jpg);
    assert.equal(jpg.observations.amountTtc.value, "9360.00");
    assert.equal(jpg.observations.amountTtc.rawValue, "9360.00");
    assert.equal(jpg.observations.amountTtc.page, 1);
    assert.equal(jpg.observations.amountTtc.extractionMethod, "OCR");
    assert.equal(jpg.observations.amountTtc.extractionVersion, "tesseract-5-best-e12c65a91594-fra-ara-eng-psm6-oem1-v3");
    assert.deepEqual(jpg.observations.amountTtc.normalization, []);
    assert.equal(jpg.observations.supplierIce.value, "005678901000091");
    assert.equal(jpg.observations.issuedOn.value, "2026-01-01");
    if (jpg.observations.issuedOn.rawValue !== "2026-01-01") {
      assert.ok(jpg.observations.issuedOn.normalization.includes(
        "DATE_COMPONENT_ZERO_PADDED",
      ));
    }
    const confidence = await pool.query(
      `SELECT confidence_percent FROM source_extraction_segments
        WHERE extraction_id = (SELECT id FROM source_extractions
          WHERE source_id = $1 AND method = 'OCR')`,
      [jpgId],
    );
    assert.equal(confidence.rows[0]?.confidence_percent, null);

    const scanId = await upload(
      app, batchId, makeImagePdf(invoiceJpeg, 1800, 1300), "scan.pdf", "application/pdf",
    );
    await waitForStatus(pool, scanId, "DONE");
    const scan = await readSource(app, batchId, scanId);
    assert.deepEqual(scan.extractions.map((item) => [item.method, item.status]), [
      ["PDF_TEXT", "NON_TRAITE"], ["OCR", "SUCCEEDED"],
    ]);
    assert.equal(scan.observations.invoiceNumber.value, "FA-2026-0001");
    assert.equal(scan.observations.amountHt.value, "7800.00");

    const englishPdfPath = join(sourceDir, "english-fixture.pdf");
    const englishImagePrefix = join(sourceDir, "english-fixture");
    await writeFile(englishPdfPath, makePdf([
      "SUPPLIER EXAMPLE",
      "ICE 005678901000091",
      "INVOICE N EN-2026-0001",
      "Date 2026-01-05",
      "ICE customer 001987654000073",
      "Total excl tax 7800.00",
      "VAT 20% 1560.00",
      "Total incl tax 9360.00",
    ]));
    await run("pdftoppm", [
      "-scale-to", "2600", "-singlefile", "-jpeg", englishPdfPath, englishImagePrefix,
    ]);
    const englishJpeg = await readFile(`${englishImagePrefix}.jpg`);
    const englishId = await upload(
      app, batchId, englishJpeg, "english-invoice.jpg", "image/jpeg",
    );
    await waitForStatus(pool, englishId, "DONE");
    const english = await readSource(app, batchId, englishId);
    assertComplete(english);
    assert.match(english.textPreview, /SUPPLIER EXAMPLE/);
    assert.equal(english.observations.invoiceNumber.value, "EN-2026-0001");
    assert.equal(english.observations.amountHt.value, "7800.00");
    assert.equal(english.observations.vatAmount.value, "1560.00");
    assert.equal(english.observations.amountTtc.value, "9360.00");

    const arabicId = await upload(
      app, batchId, arabicJpeg, "facture-arabe.jpg", "image/jpeg",
    );
    await waitForStatus(pool, arabicId, "DONE");
    const arabic = await readSource(app, batchId, arabicId);
    assert.match(arabic.textPreview, /شركة المثال العربية/u);
    assert.equal(arabic.observationStatus, "PARTIAL");
    assert.equal(arabic.observations.supplierName.value, "شركة المثال العربية");
    assert.equal(arabic.observations.supplierIce.value, "005678901000091");
    assert.equal(arabic.observations.customerIce.value, "001987654000073");
    assert.equal(arabic.observations.invoiceNumber.value, null);
    assert.equal(arabic.observations.issuedOn.value, "2026-01-03");
    assert.equal(arabic.observations.amountHt.value, "7800.00");
    assert.equal(arabic.observations.vatAmount.value, null);
    assert.equal(arabic.observations.amountTtc.value, "9360.00");
    assert.equal(arabic.observations.printedVatRate.value, null);
    assert.equal(arabic.observations.amountHt.rawValue, "7800.00");
    assert.deepEqual(arabic.observations.amountHt.normalization, []);

    const arabicScanId = await upload(
      app, batchId, makeImagePdf(arabicJpeg, 2600, 2100),
      "scan-arabe.pdf", "application/pdf",
    );
    await waitForStatus(pool, arabicScanId, "DONE");
    const arabicScan = await readSource(app, batchId, arabicScanId);
    assert.deepEqual(arabicScan.extractions.map((item) => [item.method, item.status]), [
      ["PDF_TEXT", "NON_TRAITE"], ["OCR", "SUCCEEDED"],
    ]);
    assert.equal(arabicScan.observationStatus, "PARTIAL");
    assert.equal(arabicScan.observations.invoiceNumber.value, null);
    assert.equal(arabicScan.observations.amountTtc.value, "9360.00");

    const mixedId = await upload(
      app, batchId, mixedJpeg, "facture-mixte.jpg", "image/jpeg",
    );
    await waitForStatus(pool, mixedId, "DONE");
    const mixed = await readSource(app, batchId, mixedId);
    assert.match(mixed.textPreview, /وثيقة مختلطة/u);
    assert.equal(mixed.observationStatus, "PARTIAL");
    assert.equal(mixed.observations.supplierName.value, null);
    assert.equal(mixed.observations.supplierIce.value, null);
    assert.equal(mixed.observations.invoiceNumber.value, "MX-2026-0001");
    assert.equal(mixed.observations.issuedOn.value, "2026-01-04");
    assert.equal(mixed.observations.amountHt.value, "7800.00");
    assert.equal(mixed.observations.vatAmount.value, "1560.00");
    assert.equal(mixed.observations.amountTtc.value, "9360.00");

    const ambiguousId = await upload(
      app, batchId, ambiguousJpeg, "ambigue.jpg", "image/jpeg",
    );
    await waitForStatus(pool, ambiguousId, "DONE");
    const ambiguous = await readSource(app, batchId, ambiguousId);
    assert.equal(ambiguous.observationStatus, "PARTIAL");
    assert.equal(ambiguous.observations.amountHt.value, null);
    assert.match(ambiguous.observations.amountHt.missingReason, /Plusieurs valeurs/);
    assert.deepEqual(ambiguous.observations.amountHt.candidates.map((item) => item.value), [
      "7800.00", "7900.00",
    ]);
    assert.equal(ambiguous.observations.amountHt.reviewRequired, true);
    assert.equal(ambiguous.observations.amountTtc.value, "9000.00");

    const blankId = await upload(app, batchId, blankJpeg, "illisible.jpg", "image/jpeg");
    await waitForStatus(pool, blankId, "NON_TRAITE");
    const blank = await readSource(app, batchId, blankId);
    assert.match(blank.failureReason, /illisible/);
    assert.equal(blank.observations, null);

    await closeWorker();
    const technicalJpeg = Buffer.concat([invoiceJpeg, Buffer.from([0])]);
    const technicalId = await upload(
      app, batchId, technicalJpeg, "erreur-technique.jpg", "image/jpeg",
    );
    const technicalFile = await pool.query(
      "SELECT storage_key FROM source_files WHERE id = $1", [technicalId],
    );
    await rm(join(sourceDir, technicalFile.rows[0].storage_key));
    closeWorker = await startSourceWorker(pool, queue, sourceDir);
    await waitForStatus(pool, technicalId, "FAILED");
    const technical = await readSource(app, batchId, technicalId);
    assert.match(technical.failureReason, /Erreur technique OCR après 3 tentatives/);
    assert.equal(technical.extractions.at(-1).status, "FAILED");
    let failedJob;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      failedJob = await queue.getJob(technicalId);
      if (failedJob && await failedJob.getState() === "failed") break;
      await sleep(100);
    }
    assert.ok(failedJob);
    assert.equal(await failedJob.getState(), "failed");
    assert.equal(failedJob.attemptsMade, 3);

    const beforeReplay = await pool.query(
      "SELECT count(*)::int AS count FROM source_extractions WHERE source_id = $1", [jpgId],
    );
    await enqueueSource(queue, jpgId);
    await sleep(500);
    const afterReplay = await pool.query(
      "SELECT count(*)::int AS count FROM source_extractions WHERE source_id = $1", [jpgId],
    );
    assert.equal(afterReplay.rows[0]?.count, beforeReplay.rows[0]?.count);

    await closeWorker();
    await pool.query("UPDATE source_files SET status = 'PROCESSING' WHERE id = $1", [jpgId]);
    closeWorker = await startSourceWorker(pool, queue, sourceDir);
    await waitForStatus(pool, jpgId, "DONE");
    const afterRestart = await pool.query(
      `SELECT count(*)::int AS extractions,
              (SELECT count(*)::int FROM source_observation_inputs WHERE source_id = $1) AS inputs
         FROM source_extractions WHERE source_id = $1`,
      [jpgId],
    );
    assert.equal(afterRestart.rows[0]?.extractions, 1);
    assert.equal(afterRestart.rows[0]?.inputs, 1);

    await closeWorker();
    await pool.query(
      "UPDATE source_observations SET parser_version = 'labels-v2' WHERE source_id = $1",
      [jpgId],
    );
    closeWorker = await startSourceWorker(pool, queue, sourceDir);
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      const reparsed = await readSource(app, batchId, jpgId);
      if (reparsed.observationVersion === "labels-v4" && reparsed.status === "DONE") break;
      await sleep(100);
    }
    const reparsed = await readSource(app, batchId, jpgId);
    assert.equal(reparsed.observationVersion, "labels-v4");
    const afterParserReplay = await pool.query(
      "SELECT count(*)::int AS count FROM source_extractions WHERE source_id = $1",
      [jpgId],
    );
    assert.equal(afterParserReplay.rows[0]?.count, 1);

    await closeWorker();
    await pool.query(
      "UPDATE source_extractions SET method_version = 'legacy-ocr-test' WHERE source_id = $1 AND method = 'OCR'",
      [jpgId],
    );
    closeWorker = await startSourceWorker(pool, queue, sourceDir);
    await waitForStatus(pool, jpgId, "DONE");
    const upgraded = await readSource(app, batchId, jpgId);
    assertComplete(upgraded);
    assert.equal(upgraded.observations.amountTtc.extractionVersion,
      "tesseract-5-best-e12c65a91594-fra-ara-eng-psm6-oem1-v3");
    const readUpgradeHistory = () => pool.query(
      `SELECT se.method_version,
              (SELECT count(*)::int FROM source_observation_inputs soi
                WHERE soi.extraction_id = se.id) AS inputs
         FROM source_extractions se WHERE se.source_id = $1 ORDER BY se.method_version`,
      [jpgId],
    );
    const upgradeHistory = await readUpgradeHistory();
    assert.deepEqual(upgradeHistory.rows, [
      { method_version: "legacy-ocr-test", inputs: 0 },
      { method_version: "tesseract-5-best-e12c65a91594-fra-ara-eng-psm6-oem1-v3", inputs: 1 },
    ]);
    await closeWorker();
    closeWorker = await startSourceWorker(pool, queue, sourceDir);
    await enqueueSource(queue, jpgId);
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      if (!await queue.getJob(jpgId)) break;
      await sleep(100);
    }
    assert.equal(await queue.getJob(jpgId), undefined);
    await closeWorker();
    assert.deepEqual((await readUpgradeHistory()).rows, upgradeHistory.rows);
    const nativeAfterUpgrade = await readSource(app, batchId, nativeId);
    assert.deepEqual(nativeAfterUpgrade.extractions, native.extractions);

    await pool.query(
      `UPDATE source_extractions SET method_version = 'tesseract-5-fra-eng-v1'
        WHERE source_id = $1 AND method = 'OCR'`,
      [blankId],
    );
    closeWorker = await startSourceWorker(pool, queue, sourceDir);
    let upgradedBlank;
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      upgradedBlank = await pool.query(
        `SELECT sf.status,
                count(*) FILTER (
                  WHERE se.method = 'OCR' AND se.method_version = 'tesseract-5-best-e12c65a91594-fra-ara-eng-psm6-oem1-v3'
                )::int AS current_ocr
           FROM source_files sf
           LEFT JOIN source_extractions se ON se.source_id = sf.id
          WHERE sf.id = $1 GROUP BY sf.status`,
        [blankId],
      );
      if (upgradedBlank.rows[0]?.status === "NON_TRAITE"
        && upgradedBlank.rows[0]?.current_ocr === 1) break;
      await sleep(100);
    }
    assert.equal(upgradedBlank?.rows[0]?.status, "NON_TRAITE");
    assert.equal(upgradedBlank?.rows[0]?.current_ocr, 1);

    const duplicate = await app.inject({
      method: "POST", url: `/api/batches/${batchId}/sources`,
      ...multipartFile(invoiceJpeg, "copie.jpg", "image/jpeg"),
    });
    assert.equal(duplicate.statusCode, 409);
  } finally {
    await closeWorker();
    await app.close();
    await queue.close();
    await pool.end();
    await rm(sourceDir, { recursive: true, force: true });
  }
});
