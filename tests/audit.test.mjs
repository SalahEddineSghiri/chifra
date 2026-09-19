import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../dist/server/app.js";
import { createSourceQueue } from "../dist/server/queue.js";
import { startSourceWorker } from "../dist/server/worker.js";
import { replayAuditProof } from "../dist/server/audit-proof.js";
import { loadReferenceData } from "../dist/server/reference-data.js";

test("audit asynchrone, référentiels réels, preuve et idempotence", async () => {
  const pool = new Pool();
  const queue = createSourceQueue();
  const app = buildApp(pool, queue, "/tmp/chiffra-unused");
  const batchId = randomUUID();
  const normalId = randomUUID();
  const anomalyId = randomUUID();
  let closeWorker;
  try {
    await pool.query(
      "INSERT INTO batches (id, name, status, closed_at) VALUES ($1, 'Audit', 'COMPLETED', now())",
      [batchId],
    );
    await pool.query(
      `INSERT INTO accounting_documents (
         id, batch_id, consolidation_version, kind, status, invoice_number,
         supplier_name, supplier_ice, customer_ice, issued_on, account,
         printed_vat_rate, amount_ht, vat_amount, amount_ttc
       ) VALUES
         ($1, $3, 'test-v1', 'INVOICE', 'READY', 'FA-NORMAL',
          'INFOTECH MAROC', '005678901000091', '001987654000073', '2026-03-01',
          '6132', 20, 7800, 1560, 9360),
         ($2, $3, 'test-v1', 'INVOICE', 'READY', 'FA-TVA',
          'INFOTECH MAROC', '005678901000091', '001987654000073', '2026-03-15',
          '6132', 7, 1000, 70, 1070)`,
      [normalId, anomalyId, batchId],
    );

    const [first, concurrent] = await Promise.all([
      app.inject({ method: "POST", url: `/api/batches/${batchId}/audit` }),
      app.inject({ method: "POST", url: `/api/batches/${batchId}/audit` }),
    ]);
    assert.equal(first.statusCode, 202, first.body);
    assert.equal(concurrent.statusCode, 202, concurrent.body);
    assert.equal(first.json().job.id, concurrent.json().job.id);
    closeWorker = await startSourceWorker(pool, queue, "/tmp/chiffra-unused");
    let response;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await app.inject({ method: "GET", url: `/api/batches/${batchId}/audit` });
      assert.equal(current.statusCode, 200, current.body);
      response = current.json();
      if (["COMPLETED", "FAILED"].includes(response.job?.status)) break;
      await sleep(50);
    }
    assert.equal(response?.job?.status, "COMPLETED", JSON.stringify(response));
    assert.equal(response.reference.accountCount, 13);
    assert.equal(response.reference.supplierCount, 15);
    assert.equal(response.audit.referenceVersion, "chiffra-reference-v1");
    assert.deepEqual(response.audit.summary, {
      documentCount: 2,
      passedDocumentCount: 1,
      anomalousDocumentCount: 1,
      nonEvaluableDocumentCount: 0,
      anomalyCount: 2,
      nonEvaluableCheckCount: 0,
      anomaliesByFamily: { VAT: 2 },
    });
    const anomaly = response.audit.documents.find((item) => item.documentId === anomalyId);
    assert.equal(anomaly.supplierReference.account, "6132");
    assert.equal(anomaly.checks.find((item) => item.code === "INTERNAL_VAT").status, "PASS");
    assert.equal(
      anomaly.checks.find((item) => item.code === "REFERENCE_VAT_AMOUNT").differenceMad,
      "-130.00",
    );

    const repeated = await app.inject({ method: "POST", url: `/api/batches/${batchId}/audit` });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().audit.id, response.audit.id);
    const stored = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM audit_jobs WHERE batch_id = $1) AS jobs,
         (SELECT count(*)::int FROM audit_runs WHERE batch_id = $1) AS runs,
         (SELECT count(*)::int FROM document_audit_results dar
           JOIN audit_runs ar ON ar.id = dar.run_id WHERE ar.batch_id = $1) AS results`,
      [batchId],
    );
    assert.deepEqual(stored.rows[0], { jobs: 1, runs: 1, results: 2 });
    const proof = await pool.query(
      `SELECT engine_version, rules_version, reference_version,
              jsonb_array_length(input_payload->'documents') AS input_documents,
              jsonb_array_length(output_payload->'documents') AS output_documents
         FROM audit_runs WHERE id = $1`,
      [response.audit.id],
    );
    assert.deepEqual(proof.rows[0], {
      engine_version: "audit-v1",
      rules_version: "fiscal-rules-v1",
      reference_version: "chiffra-reference-v1",
      input_documents: 2,
      output_documents: 2,
    });
    assert.deepEqual(await replayAuditProof(pool, response.audit.id, loadReferenceData()), {
      proofId: response.audit.id,
      engineVersion: "audit-v1",
      rulesVersion: "fiscal-rules-v1",
      referenceVersion: "chiffra-reference-v1",
      verified: true,
    });
  } finally {
    if (closeWorker) await closeWorker();
    await app.close();
    await queue.close();
    await pool.end();
  }
});
