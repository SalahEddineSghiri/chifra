import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";

const baseUrl = process.env.BASE_URL ?? "http://web_e2e";

async function json(response) {
  if (!response.ok) {
    assert.fail(`${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function waitForReconciliation(batchId) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const current = await json(await fetch(
      `${baseUrl}/api/batches/${batchId}/reconciliation`,
    ));
    if (current.job?.status === "FAILED") {
      assert.fail(current.job.failureReason ?? "Rapprochement en échec");
    }
    if (current.job?.status === "COMPLETED" && current.reconciliation) return current;
    await sleep(100);
  }
  assert.fail("Délai dépassé pendant le rapprochement");
}

test("parcours OCR, XLSX et relevé CSV via Nginx, API, worker et PostgreSQL", async () => {
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
  form.append("file", new Blob([jpeg], { type: "image/jpeg" }), "TST-001.jpg");
  const uploaded = await json(await fetch(`${baseUrl}/api/batches/${batchId}/sources`, {
    method: "POST", body: form,
  }));

  let source;
  for (let attempt = 0; attempt < 1200; attempt += 1) {
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
  assert.equal(source.observationStatus, "COMPLETE", JSON.stringify(source, null, 2));
  assert.match(source.textPreview, /FOURNISSEUR EXEMPLE/u);
  assert.equal(source.observations.supplierName.value, "FOURNISSEUR EXEMPLE");
  assert.equal(source.observations.invoiceNumber.value, "FA-2026-0001");
  assert.equal(source.observations.invoiceNumber.rawValue, "FA-2026-0001");
  assert.equal(source.observations.issuedOn.value, "2026-01-01");
  assert.equal(source.observations.amountHt.value, "7800.00");
  assert.equal(source.observations.amountHt.rawValue, "7800.00");
  assert.deepEqual(source.observations.amountHt.normalization, []);
  assert.equal(source.observations.vatAmount.value, "1560.00");
  assert.equal(source.observations.amountTtc.value, "9360.00");

  const xlsx = await readFile(new URL("./fixtures/purchases.xlsx", import.meta.url));
  const xlsxForm = new FormData();
  xlsxForm.append("file", new Blob([xlsx], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), "achats-e2e.xlsx");
  const xlsxUploaded = await json(await fetch(`${baseUrl}/api/batches/${batchId}/sources`, {
    method: "POST", body: xlsxForm,
  }));
  let xlsxSource;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const listed = await json(await fetch(`${baseUrl}/api/batches/${batchId}/sources`));
    xlsxSource = listed.sources.find((item) => item.id === xlsxUploaded.source.id);
    if (["DONE", "FAILED", "NON_TRAITE"].includes(xlsxSource?.status)) break;
    await sleep(100);
  }
  assert.equal(xlsxSource?.status, "DONE");
  assert.equal(xlsxSource.extractionMethod, "TABULAR");
  assert.equal(xlsxSource.tabularRecords.length, 3);
  assert.equal(xlsxSource.tabularRecords[1].fields.amountHt.rawValue, "250.5");
  assert.equal(xlsxSource.tabularRecords[1].fields.amountHt.value, "250.50");

  const csv = await readFile(new URL("./fixtures/bank-statement.csv", import.meta.url));
  const bankForm = new FormData();
  bankForm.append("file", new Blob([csv], { type: "text/csv" }), "releve-e2e.csv");
  const imported = await json(await fetch(`${baseUrl}/api/batches/${batchId}/bank-statements`, {
    method: "POST", body: bankForm,
  }));
  assert.equal(imported.statement.rowCount, 3);
  const bankList = await json(await fetch(`${baseUrl}/api/batches/${batchId}/bank-statements`));
  assert.equal(bankList.statements[0].lines[0].debitMad, "120.00");
  assert.equal(bankList.statements[0].lines[0].rawValues.debit_mad, "120.0");
  assert.equal(bankList.statements[0].lines[1].classification, "SALARY");
  assert.equal(bankList.statements[0].lines[2].balanceConsistent, false);

  const closed = await json(await fetch(`${baseUrl}/api/batches/${batchId}/close`, {
    method: "POST",
  }));
  assert.equal(closed.batch.status, "COMPLETED");
  assert.equal(closed.summary.sourceCount, 2);
  assert.equal(closed.summary.documentCount, 3);
  assert.equal(closed.summary.readyCount, 2);
  assert.equal(closed.summary.reviewRequiredCount, 1);
  assert.equal(closed.summary.confirmedLinks, 0);
  assert.equal(closed.summary.openConflicts, 7);
  const documents = await json(await fetch(`${baseUrl}/api/batches/${batchId}/documents`));
  assert.equal(documents.batchStatus, "COMPLETED");
  const reviewed = documents.documents.find((document) => document.externalDocumentId === "TST-001");
  assert.equal(reviewed.status, "REVIEW_REQUIRED");
  assert.equal(reviewed.sources.length, 2);
  assert.equal(reviewed.conflicts.length, 7);
  assert.ok(reviewed.conflicts.some((conflict) => conflict.fieldName === "amountTtc"));

  await json(await fetch(
    `${baseUrl}/api/batches/${batchId}/reconciliation`, { method: "POST" },
  ));
  const reconciliation = await waitForReconciliation(batchId);
  assert.equal(reconciliation.reconciliation.engineVersion, "reconciliation-v1");
  assert.equal(reconciliation.reconciliation.lines.length, 3);
  assert.equal(reconciliation.reconciliation.lines[0].status, "REVIEW_REQUIRED");
  assert.equal(reconciliation.reconciliation.lines[0].allocations.length, 0);
  assert.equal(reconciliation.reconciliation.lines[1].status, "EXCLUDED");
  assert.equal(reconciliation.reconciliation.lines[2].status, "EXCLUDED");
  assert.equal(reconciliation.reconciliation.summary.fullyMatchedLines, 0);
  assert.equal(reconciliation.reconciliation.summary.eligiblePaymentLines, 1);
  assert.equal(reconciliation.reconciliation.summary.matchRatePercent, "0.00");

  const reconciliationBatch = await json(await fetch(`${baseUrl}/api/batches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Lot E2E EX-03 ${randomUUID()}` }),
  }));
  const reconciliationBatchId = reconciliationBatch.batch.id;
  const reconciliationXlsxForm = new FormData();
  reconciliationXlsxForm.append("file", new Blob([xlsx], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), "achats-ex03.xlsx");
  const reconciliationXlsx = await json(await fetch(
    `${baseUrl}/api/batches/${reconciliationBatchId}/sources`,
    { method: "POST", body: reconciliationXlsxForm },
  ));
  let reconciliationXlsxSource;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const listed = await json(await fetch(
      `${baseUrl}/api/batches/${reconciliationBatchId}/sources`,
    ));
    reconciliationXlsxSource = listed.sources.find(
      (item) => item.id === reconciliationXlsx.source.id,
    );
    if (["DONE", "FAILED", "NON_TRAITE"].includes(reconciliationXlsxSource?.status)) break;
    await sleep(100);
  }
  assert.equal(reconciliationXlsxSource?.status, "DONE");
  const reconciliationCsv = await readFile(
    new URL("./fixtures/reconciliation-bank.csv", import.meta.url),
  );
  const reconciliationBankForm = new FormData();
  reconciliationBankForm.append(
    "file", new Blob([reconciliationCsv], { type: "text/csv" }), "releve-ex03.csv",
  );
  await json(await fetch(
    `${baseUrl}/api/batches/${reconciliationBatchId}/bank-statements`,
    { method: "POST", body: reconciliationBankForm },
  ));
  await json(await fetch(`${baseUrl}/api/batches/${reconciliationBatchId}/close`, {
    method: "POST",
  }));
  await json(await fetch(
    `${baseUrl}/api/batches/${reconciliationBatchId}/reconciliation`, { method: "POST" },
  ));
  const matched = await waitForReconciliation(reconciliationBatchId);
  assert.deepEqual(matched.reconciliation.lines.map((line) => line.status), [
    "PARTIALLY_ALLOCATED", "FULLY_MATCHED", "FULLY_MATCHED",
  ]);
  assert.equal(matched.reconciliation.summary.fullyMatchedLines, 2);
  assert.equal(matched.reconciliation.summary.partiallyAllocatedLines, 1);
  assert.equal(matched.reconciliation.summary.matchRatePercent, "66.67");
  assert.equal(matched.reconciliation.lines.flatMap((line) => line.allocations).length, 3);
  const repeatedReconciliation = await fetch(
    `${baseUrl}/api/batches/${reconciliationBatchId}/reconciliation`, { method: "POST" },
  );
  assert.equal(repeatedReconciliation.status, 200);
  assert.equal((await repeatedReconciliation.json()).reconciliation.id, matched.reconciliation.id);

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
    assert.equal(stored.rows[0]?.method_version, "tesseract-5-best-e12c65a91594-fra-ara-eng-psm6-oem1-v3");
    assert.equal(stored.rows[0]?.page_number, 1);
    assert.equal(stored.rows[0]?.confidence_percent, null);
    assert.equal(stored.rows[0]?.observation_inputs, 1);
    const xlsxStored = await pool.query(
      "SELECT count(*)::int AS records FROM source_tabular_records WHERE source_id = $1",
      [xlsxUploaded.source.id],
    );
    assert.equal(xlsxStored.rows[0]?.records, 3);
    const bankStored = await pool.query(
      `SELECT count(*)::int AS lines FROM bank_lines bl
        JOIN bank_statements bs ON bs.id = bl.statement_id WHERE bs.batch_id = $1`,
      [batchId],
    );
    assert.equal(bankStored.rows[0]?.lines, 3);
    const consolidated = await pool.query(
      `SELECT count(*)::int AS documents,
              count(*) FILTER (WHERE status = 'REVIEW_REQUIRED')::int AS reviews
         FROM accounting_documents WHERE batch_id = $1`,
      [batchId],
    );
    assert.deepEqual(consolidated.rows[0], { documents: 3, reviews: 1 });
    const reconciliationStored = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM reconciliation_runs WHERE batch_id = $1) AS runs,
         (SELECT count(*)::int FROM calculation_proofs cp
           JOIN reconciliation_runs rr ON rr.id = cp.run_id WHERE rr.batch_id = $1) AS proofs,
         (SELECT count(*)::int FROM payment_allocations pa
           JOIN reconciliation_runs rr ON rr.id = pa.run_id WHERE rr.batch_id = $1) AS allocations`,
      [batchId],
    );
    assert.deepEqual(reconciliationStored.rows[0], { runs: 1, proofs: 1, allocations: 0 });
    const matchedStored = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM reconciliation_runs WHERE batch_id = $1) AS runs,
         (SELECT count(*)::int FROM payment_allocations pa
           JOIN reconciliation_runs rr ON rr.id = pa.run_id WHERE rr.batch_id = $1) AS allocations`,
      [reconciliationBatchId],
    );
    assert.deepEqual(matchedStored.rows[0], { runs: 1, allocations: 3 });
  } finally {
    await pool.end();
  }
});
