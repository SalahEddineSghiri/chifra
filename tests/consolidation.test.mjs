import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../dist/server/app.js";
import { createSourceQueue } from "../dist/server/queue.js";

function fields(values) {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }]));
}

async function insertSource(pool, batchId, filename, mediaType = "application/pdf", status = "DONE") {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO source_files (
       id, batch_id, content_sha256, original_filename, media_type,
       size_bytes, storage_key, status
     ) VALUES ($1, $2, $3, $4, $5, 100, $6, $7)`,
    [id, batchId, createHash("sha256").update(id).digest("hex"), filename,
      mediaType, `${id}.${mediaType === "application/pdf" ? "pdf" : "xlsx"}`, status],
  );
  return id;
}

async function insertObservation(pool, sourceId, values) {
  const extractionId = randomUUID();
  await pool.query(
    `INSERT INTO source_extractions (
       id, source_id, method, method_version, status, text_content
     ) VALUES ($1, $2, 'PDF_TEXT', 'test-v1', 'SUCCEEDED', 'fixture')`,
    [extractionId, sourceId],
  );
  await pool.query(
    `INSERT INTO source_observations (
       source_id, extraction_id, parser_version, status, fields
     ) VALUES ($1, $2, 'test-v1', 'COMPLETE', $3::jsonb)`,
    [sourceId, extractionId, JSON.stringify(fields(values))],
  );
}

async function insertTabularRecord(pool, sourceId, extractionId, rowNumber, externalId, values) {
  await pool.query(
    `INSERT INTO source_tabular_records (
       id, source_id, extraction_id, row_number, external_document_id, status, fields
     ) VALUES ($1, $2, $3, $4, $5, 'COMPLETE', $6::jsonb)`,
    [randomUUID(), sourceId, extractionId, rowNumber, externalId,
      JSON.stringify(fields({ externalDocumentId: externalId, ...values }))],
  );
}

const first = {
  invoiceNumber: "FT-001", supplierName: "FOURNISSEUR ALPHA",
  supplierIce: "001234567890123", customerIce: "009999999999999",
  issuedOn: "2026-04-01", account: null, printedVatRate: "20.00",
  amountHt: "1000.00", vatAmount: "200.00", amountTtc: "1200.00",
};
const second = {
  invoiceNumber: "FT-002", supplierName: "FOURNISSEUR BETA",
  supplierIce: "009876543210987", customerIce: "009999999999999",
  issuedOn: "2026-04-02", account: null, printedVatRate: "20.00",
  amountHt: "500.00", vatAmount: "100.00", amountTtc: "600.00",
};

test("fermeture du lot, liaison XLSX/PDF et conflits sans double comptage", async () => {
  const pool = new Pool();
  const queue = createSourceQueue();
  const app = buildApp(pool, queue, "/tmp/chiffra-unused");
  try {
    const created = await app.inject({
      method: "POST", url: "/api/batches", payload: { name: `Consolidation ${randomUUID()}` },
    });
    const batchId = created.json().batch.id;
    const firstSource = await insertSource(pool, batchId, "DOC-001.pdf");
    const secondSource = await insertSource(pool, batchId, "DOC-002.pdf");
    await insertObservation(pool, firstSource, first);
    await insertObservation(pool, secondSource, second);

    const xlsxSource = await insertSource(
      pool, batchId, "achats.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const extractionId = randomUUID();
    await pool.query(
      `INSERT INTO source_extractions (
         id, source_id, method, method_version, status, text_content
       ) VALUES ($1, $2, 'TABULAR', 'test-v1', 'SUCCEEDED', 'fixture')`,
      [extractionId, xlsxSource],
    );
    await insertTabularRecord(pool, xlsxSource, extractionId, 2, "DOC-001", {
      ...first, account: "6125", customerIce: undefined,
    });
    await insertTabularRecord(pool, xlsxSource, extractionId, 3, "DOC-002", {
      ...second, account: "6136", customerIce: undefined, amountTtc: "610.00",
    });
    await insertTabularRecord(pool, xlsxSource, extractionId, 4, "DOC-003", {
      invoiceNumber: "AV-003", supplierName: "FOURNISSEUR ALPHA",
      supplierIce: "001234567890123", issuedOn: "2026-04-03", account: "6125",
      printedVatRate: "20.00", amountHt: "-100.00", vatAmount: "-20.00",
      amountTtc: "-120.00",
    });

    const closed = await app.inject({ method: "POST", url: `/api/batches/${batchId}/close` });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.deepEqual(closed.json().summary, {
      sourceCount: 3,
      nonTraiteCount: 0,
      failedCount: 0,
      documentCount: 3,
      readyCount: 2,
      reviewRequiredCount: 1,
      confirmedLinks: 1,
      openConflicts: 1,
    });

    const listed = await app.inject({ method: "GET", url: `/api/batches/${batchId}/documents` });
    assert.equal(listed.statusCode, 200, listed.body);
    const data = listed.json();
    assert.equal(data.batchStatus, "COMPLETED");
    const exact = data.documents.find((document) => document.externalDocumentId === "DOC-001");
    assert.equal(exact.status, "READY");
    assert.equal(exact.amountTtc, "1200.00");
    assert.deepEqual(exact.sources.map((source) => source.relationStatus).sort(), [
      "CONFIRMED", "PRIMARY",
    ]);
    const conflict = data.documents.find((document) => document.externalDocumentId === "DOC-002");
    assert.equal(conflict.status, "REVIEW_REQUIRED");
    assert.deepEqual(conflict.conflicts.map((item) => ({
      field: item.fieldName, left: item.documentValue, right: item.tabularValue,
    })), [{ field: "amountTtc", left: "600.00", right: "610.00" }]);
    const credit = data.documents.find((document) => document.externalDocumentId === "DOC-003");
    assert.equal(credit.kind, "CREDIT");
    assert.equal(credit.amountTtc, "-120.00");

    const repeated = await app.inject({ method: "POST", url: `/api/batches/${batchId}/close` });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.deepEqual(repeated.json().summary, closed.json().summary);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS count FROM accounting_documents WHERE batch_id = $1", [batchId],
    )).rows[0]?.count, 3);

    const uploadAfterClose = await app.inject({
      method: "POST", url: `/api/batches/${batchId}/sources`,
    });
    assert.equal(uploadAfterClose.statusCode, 409);
    const bankAfterClose = await app.inject({
      method: "POST", url: `/api/batches/${batchId}/bank-statements`,
    });
    assert.equal(bankAfterClose.statusCode, 409);
  } finally {
    await app.close();
    await queue.close();
    await pool.end();
  }
});

test("un lot ne se ferme pas pendant un traitement", async () => {
  const pool = new Pool();
  const queue = createSourceQueue();
  const app = buildApp(pool, queue, "/tmp/chiffra-unused");
  try {
    const created = await app.inject({
      method: "POST", url: "/api/batches", payload: { name: `Lot actif ${randomUUID()}` },
    });
    const batchId = created.json().batch.id;
    await insertSource(pool, batchId, "en-cours.pdf", "application/pdf", "PROCESSING");
    const response = await app.inject({ method: "POST", url: `/api/batches/${batchId}/close` });
    assert.equal(response.statusCode, 409);
    assert.match(response.json().error, /encore en cours/);
    assert.equal((await pool.query(
      "SELECT status FROM batches WHERE id = $1", [batchId],
    )).rows[0]?.status, "OPEN");
  } finally {
    await app.close();
    await queue.close();
    await pool.end();
  }
});
