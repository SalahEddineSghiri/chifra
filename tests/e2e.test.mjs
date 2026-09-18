import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";

const baseUrl = process.env.BASE_URL ?? "http://web_e2e";

async function json(response) {
  assert.ok(response.ok, `${response.status} ${await response.text()}`);
  return response.json();
}

test("parcours JPG complet via Nginx, API, worker et PostgreSQL", async () => {
  const home = await fetch(baseUrl);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<div id="root"><\/div>/);
  assert.deepEqual(await json(await fetch(`${baseUrl}/api/health`)), { status: "ok" });

  const created = await json(await fetch(`${baseUrl}/api/batches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Lot E2E OCR ${randomUUID()}` }),
  }));
  const batchId = created.batch.id;
  const jpeg = await readFile(new URL("./fixtures/ocr-invoice.jpg", import.meta.url));
  const form = new FormData();
  form.append("file", new Blob([jpeg], { type: "image/jpeg" }), "facture-e2e.jpg");
  const uploaded = await json(await fetch(`${baseUrl}/api/batches/${batchId}/sources`, {
    method: "POST", body: form,
  }));

  let source;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const listed = await json(await fetch(`${baseUrl}/api/batches/${batchId}/sources`));
    source = listed.sources.find((item) => item.id === uploaded.source.id);
    if (source?.status === "DONE") break;
    if (["FAILED", "NON_TRAITE"].includes(source?.status)) {
      assert.fail(`Statut OCR inattendu : ${source.status} ${source.failureReason ?? ""}`);
    }
    await sleep(100);
  }
  assert.equal(source?.status, "DONE");
  assert.equal(source.extractionMethod, "OCR");
  assert.equal(source.observationStatus, "COMPLETE");
  assert.equal(source.observations.invoiceNumber.value, "FA-2026-0001");
  assert.equal(source.observations.amountHt.value, "7800.00");
  assert.equal(source.observations.vatAmount.value, "1560.00");
  assert.equal(source.observations.amountTtc.value, "9360.00");

  const pool = new Pool();
  try {
    const stored = await pool.query(
      `SELECT sf.media_type, sf.status, se.method, se.method_version,
              seg.page_number, seg.confidence_percent,
              (SELECT count(*)::int FROM source_observation_inputs soi
                WHERE soi.source_id = sf.id) AS observation_inputs
         FROM source_files sf
         JOIN source_extractions se ON se.source_id = sf.id
         JOIN source_extraction_segments seg ON seg.extraction_id = se.id
        WHERE sf.id = $1`,
      [uploaded.source.id],
    );
    assert.equal(stored.rows[0]?.media_type, "image/jpeg");
    assert.equal(stored.rows[0]?.status, "DONE");
    assert.equal(stored.rows[0]?.method, "OCR");
    assert.equal(stored.rows[0]?.method_version, "tesseract-5-fra-eng-v1");
    assert.equal(stored.rows[0]?.page_number, 1);
    assert.equal(stored.rows[0]?.confidence_percent, null);
    assert.equal(stored.rows[0]?.observation_inputs, 1);
  } finally {
    await pool.end();
  }
});
