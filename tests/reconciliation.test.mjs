import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../dist/server/app.js";
import { createSourceQueue } from "../dist/server/queue.js";
import { replayReconciliationProof } from "../dist/server/reconciliation-proof.js";
import { startSourceWorker } from "../dist/server/worker.js";
import { setTimeout as sleep } from "node:timers/promises";

test("API de rapprochement transactionnelle, prouvée et idempotente", async () => {
  const pool = new Pool();
  const queue = createSourceQueue();
  const app = buildApp(pool, queue, "/tmp/chiffra-unused");
  const batchId = randomUUID();
  const documentId = randomUUID();
  const statementId = randomUUID();
  const firstLineId = randomUUID();
  const secondLineId = randomUUID();
  let closeWorker;
  try {
    await pool.query(
      "INSERT INTO batches (id, name, status, closed_at) VALUES ($1, 'EX-03', 'COMPLETED', now())",
      [batchId],
    );
    await pool.query(
      `INSERT INTO accounting_documents (
         id, batch_id, consolidation_version, kind, status, invoice_number,
         supplier_name, issued_on, amount_ht, vat_amount, amount_ttc
       ) VALUES ($1, $2, 'test-v1', 'INVOICE', 'READY', 'FA-001',
                 'INFOTECH MAROC', '2026-01-01', 1000, 200, 1200)`,
      [documentId, batchId],
    );
    await pool.query(
      `INSERT INTO bank_statements (
         id, batch_id, content_sha256, original_filename, parser_version, raw_content, row_count
       ) VALUES ($1, $2, $3, 'releve.csv', 'test-v1', 'fixture', 2)`,
      [statementId, batchId, createHash("sha256").update(statementId).digest("hex")],
    );
    await pool.query(
      `INSERT INTO bank_lines (
         id, statement_id, line_number, booked_on, label, debit_mad, credit_mad,
         balance_mad, classification, balance_consistent, raw_values
       ) VALUES
         ($1, $3, 2, '2026-01-10', 'VIR INFOTECH MAROC FA-001 ACOMPTE', 450, 0,
          1550, 'PURCHASE_CANDIDATE', NULL, '{}'::jsonb),
         ($2, $3, 3, '2026-01-20', 'VIR INFOTECH MAROC FA-001 SOLDE', 750, 0,
          800, 'PURCHASE_CANDIDATE', true, '{}'::jsonb)`,
      [firstLineId, secondLineId, statementId],
    );

    const [first, concurrent] = await Promise.all([
      app.inject({ method: "POST", url: `/api/batches/${batchId}/reconciliation` }),
      app.inject({ method: "POST", url: `/api/batches/${batchId}/reconciliation` }),
    ]);
    assert.equal(first.statusCode, 202, first.body);
    assert.equal(concurrent.statusCode, 202, concurrent.body);
    assert.equal(first.json().job.id, concurrent.json().job.id);
    closeWorker = await startSourceWorker(pool, queue, "/tmp/chiffra-unused");
    let response;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await app.inject({
        method: "GET", url: `/api/batches/${batchId}/reconciliation`,
      });
      assert.equal(current.statusCode, 200, current.body);
      response = current.json();
      if (["COMPLETED", "FAILED"].includes(response.job?.status)) break;
      await sleep(50);
    }
    assert.equal(response?.job?.status, "COMPLETED", JSON.stringify(response));
    assert.equal(response.reconciliation.summary.eligiblePaymentLines, 2);
    assert.equal(response.reconciliation.summary.fullyMatchedLines, 1);
    assert.equal(response.reconciliation.summary.partiallyAllocatedLines, 1);
    assert.equal(response.reconciliation.summary.matchRatePercent, "50.00");
    assert.deepEqual(response.reconciliation.lines.map((line) => line.status), [
      "PARTIALLY_ALLOCATED", "FULLY_MATCHED",
    ]);
    assert.deepEqual(response.reconciliation.lines.map((line) => line.allocatedAmountMad), [
      "450.00", "750.00",
    ]);
    assert.equal(response.reconciliation.documents[0].paidAmountMad, "1200.00");
    assert.equal(response.reconciliation.documents[0].residualMad, "0.00");

    const listed = await app.inject({
      method: "GET", url: `/api/batches/${batchId}/reconciliation`,
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().reconciliation.id, response.reconciliation.id);
    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM reconciliation_runs WHERE batch_id = $1) AS runs,
         (SELECT count(*)::int FROM payment_allocations WHERE run_id IN
           (SELECT id FROM reconciliation_runs WHERE batch_id = $1)) AS allocations,
         (SELECT count(*)::int FROM calculation_proofs WHERE run_id IN
           (SELECT id FROM reconciliation_runs WHERE batch_id = $1)) AS proofs`,
      [batchId],
    );
    assert.deepEqual(counts.rows[0], { runs: 1, allocations: 2, proofs: 1 });
    const proof = await pool.query(
      `SELECT tool_name, tool_version,
              jsonb_array_length(input_payload->'bankLines') AS input_lines,
              jsonb_array_length(output_payload->'lines') AS output_lines
         FROM calculation_proofs WHERE run_id = $1`,
      [response.reconciliation.id],
    );
    assert.deepEqual(proof.rows[0], {
      tool_name: "deterministic-reconciliation",
      tool_version: "reconciliation-v1",
      input_lines: 2,
      output_lines: 2,
    });
    assert.deepEqual(await replayReconciliationProof(pool, response.reconciliation.proofId), {
      proofId: response.reconciliation.proofId,
      toolName: "deterministic-reconciliation",
      toolVersion: "reconciliation-v1",
      rulesVersion: "payment-matching-rules-v1",
      verified: true,
    });
  } finally {
    if (closeWorker) await closeWorker();
    await app.close();
    await queue.close();
    await pool.end();
  }
});

test("un lot ouvert ne peut pas lancer EX-03", async () => {
  const pool = new Pool();
  const queue = createSourceQueue();
  const app = buildApp(pool, queue, "/tmp/chiffra-unused");
  const batchId = randomUUID();
  try {
    await pool.query("INSERT INTO batches (id, name) VALUES ($1, 'Ouvert')", [batchId]);
    const response = await app.inject({
      method: "POST", url: `/api/batches/${batchId}/reconciliation`,
    });
    assert.equal(response.statusCode, 409);
    assert.match(response.json().error, /fermé et consolidé/);
  } finally {
    await app.close();
    await queue.close();
    await pool.end();
  }
});
