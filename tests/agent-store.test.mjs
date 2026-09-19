import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { executeAgentRun, getAgentRun } from "../dist/server/agent-store.js";
import { AGENT_GRAPH_VERSION } from "../dist/server/agent-runtime.js";

test("le graphe persiste outils, checkpoints, modèles et escalade humaine", async () => {
  const pool = new Pool();
  const batchId = randomUUID();
  const reconciliationJobId = randomUUID();
  const reconciliationRunId = randomUUID();
  const reconciliationProofId = randomUUID();
  const auditJobId = randomUUID();
  const auditRunId = randomUUID();
  const agentRunId = randomUUID();
  try {
    await pool.query("INSERT INTO batches (id, name, status, closed_at) VALUES ($1, 'Agent', 'COMPLETED', now())", [batchId]);
    await pool.query(
      `INSERT INTO reconciliation_jobs (id, batch_id, engine_version, status)
       VALUES ($1, $2, 'reconciliation-v1', 'COMPLETED')`,
      [reconciliationJobId, batchId],
    );
    const reconciliationSummary = {
      eligiblePaymentLines: 1, fullyMatchedLines: 0, partiallyAllocatedLines: 0,
      reviewRequiredLines: 1, unmatchedLines: 0, excludedLines: 0,
      waitingLines: 0, matchRatePercent: "0.00",
    };
    await pool.query(
      `INSERT INTO reconciliation_runs (id, job_id, batch_id, engine_version, status, summary)
       VALUES ($1, $2, $3, 'reconciliation-v1', 'COMPLETED', $4::jsonb)`,
      [reconciliationRunId, reconciliationJobId, batchId, JSON.stringify(reconciliationSummary)],
    );
    await pool.query(
      `INSERT INTO calculation_proofs (id, run_id, tool_name, tool_version, input_payload, output_payload)
       VALUES ($1, $2, 'deterministic-reconciliation', 'reconciliation-v1', $3::jsonb, '{}'::jsonb)`,
      [reconciliationProofId, reconciliationRunId, JSON.stringify({ metadata: {}, documentSources: [] })],
    );
    await pool.query(
      `INSERT INTO audit_jobs (id, batch_id, engine_version, reference_version, status)
       VALUES ($1, $2, 'audit-v2', 'chiffra-reference-v1', 'COMPLETED')`,
      [auditJobId, batchId],
    );
    const auditSummary = {
      documentCount: 1, passedDocumentCount: 0, anomalousDocumentCount: 1,
      nonEvaluableDocumentCount: 0, anomalyCount: 1,
      nonEvaluableCheckCount: 0, anomaliesByFamily: { VAT: 1 },
    };
    await pool.query(
      `INSERT INTO audit_runs (
         id, job_id, batch_id, engine_version, rules_version, reference_version,
         reference_hashes, summary, input_payload, output_payload
       ) VALUES ($1, $2, $3, 'audit-v2', 'fiscal-rules-v1', 'chiffra-reference-v1',
                 '{}'::jsonb, $4::jsonb, '{}'::jsonb, '{}'::jsonb)`,
      [auditRunId, auditJobId, batchId, JSON.stringify(auditSummary)],
    );
    await pool.query(
      `INSERT INTO agent_runs (id, batch_id, graph_version, status, started_at)
       VALUES ($1, $2, $3, 'PROCESSING', now())`,
      [agentRunId, batchId, AGENT_GRAPH_VERSION],
    );

    const llm = {
      async plan() {
        return {
          output: { actions: ["EXPLAIN"], reason: "Une revue doit être planifiée." },
          task: "COMPLEX_PLAN", model: "complex-test", selectionReason: "test",
          cached: false, durationMs: 2, tokenUsage: { input: 1, output: 1 },
        };
      },
      async explain({ evidence }) {
        return {
          output: {
            overview: "Les preuves calculées exigent une intervention.",
            findings: evidence.map((item) => ({
              evidenceId: item.id,
              explanation: "La preuve est disponible et traçable.",
              recommendedAction: "Examiner la source avant décision.",
            })),
            limitations: ["La décision humaine reste absente."],
          },
          task: "EVIDENCE_EXPLANATION", model: "routine-test", selectionReason: "test",
          cached: false, durationMs: 2, tokenUsage: { input: 1, output: 1 },
        };
      },
    };

    await executeAgentRun(pool, agentRunId, batchId, "chiffra-reference-v1", llm);
    const view = await getAgentRun(pool, batchId);
    assert.equal(view.status, "WAITING_HUMAN");
    assert.equal(view.requiresHuman, true);
    assert.equal(view.events.length, 5);
    assert.deepEqual(view.events.map((event) => event.role), [
      "INGESTOR", "ORCHESTRATOR", "RECONCILER", "AUDITOR", "EXPLAINER",
    ]);
    assert.equal(view.events.find((event) => event.role === "RECONCILER").payload.proofId, reconciliationProofId);
    assert.equal(view.events.find((event) => event.role === "AUDITOR").payload.proofId, auditRunId);
    const checkpoints = await pool.query(
      "SELECT count(*)::int AS count FROM agent_checkpoints WHERE run_id = $1",
      [agentRunId],
    );
    assert.equal(checkpoints.rows[0].count, 5);
  } finally {
    await pool.end();
  }
});
