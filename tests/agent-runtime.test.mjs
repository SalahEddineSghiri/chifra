import assert from "node:assert/strict";
import test from "node:test";
import {
  enforcePlan,
  humanReviewReasons,
  requiresComplexPlan,
  runAgentGraph,
} from "../dist/server/agent-runtime.js";
import { completeExplanation, LlmResponseError } from "../dist/server/llm.js";

const complexFacts = {
  batchStatus: "COMPLETED",
  sourceCount: 108,
  unreadableSourceCount: 3,
  failedSourceCount: 0,
  documentCount: 105,
  reviewDocumentCount: 2,
  reconciliationAvailable: true,
  reconciliationReviewCount: 19,
  auditAvailable: true,
  auditAnomalyCount: 40,
};

test("le routeur conserve les outils obligatoires et les motifs humains", () => {
  assert.equal(requiresComplexPlan(complexFacts), true);
  const plan = enforcePlan({ actions: ["EXPLAIN"], reason: "Plan proposé." }, complexFacts);
  assert.deepEqual(plan.actions, [
    "READ_RECONCILIATION", "READ_AUDIT", "ESCALATE_HUMAN", "EXPLAIN",
  ]);
  assert.equal(humanReviewReasons(complexFacts).length, 4);
});

test("une preuve omise reçoit un constat système et une preuve inventée reste refusée", () => {
  const evidence = [
    { id: "INGESTION", kind: "INGESTION", status: "READY", message: "source", proofId: null },
    { id: "AUDIT:preuve", kind: "AUDIT", status: "ANOMALY", message: "audit", proofId: "preuve" },
  ];
  const completed = completeExplanation(evidence, {
    overview: "Des preuves sont disponibles.",
    findings: [{
      evidenceId: "INGESTION",
      explanation: "La source est traçable.",
      recommendedAction: "Consulter la source.",
    }],
    limitations: [],
  });
  assert.deepEqual(completed.findings.map((item) => item.evidenceId), ["INGESTION", "AUDIT:preuve"]);
  assert.match(completed.findings[1].explanation, /sans explication générée validée/u);
  assert.throws(() => completeExplanation(evidence, {
    overview: "Des preuves sont disponibles.",
    findings: [{
      evidenceId: "PREUVE_INVENTEE",
      explanation: "Une preuve serait présente.",
      recommendedAction: "Consulter la source.",
    }],
    limitations: [],
  }), LlmResponseError);
});

test("le graphe exécute les cinq rôles et rattache l'explication aux preuves", async () => {
  const records = [];
  let planCalls = 0;
  let explanationCalls = 0;
  const state = await runAgentGraph({
    runId: "10000000-0000-4000-8000-000000000001",
    batchId: "10000000-0000-4000-8000-000000000002",
  }, {
    llm: {
      async plan() {
        planCalls += 1;
        return {
          output: { actions: ["EXPLAIN"], reason: "Les ambiguïtés demandent une revue." },
          task: "COMPLEX_PLAN", model: "gpt-complex-test", selectionReason: "test",
          cached: false, durationMs: 4, tokenUsage: { input: 1, output: 1 },
        };
      },
      async explain({ evidence }) {
        explanationCalls += 1;
        return {
          output: {
            overview: "Des preuves déterministes demandent une revue.",
            findings: evidence.map((item) => ({
              evidenceId: item.id,
              explanation: "Cette preuve est conservée et traçable.",
              recommendedAction: "Vérifier la source associée.",
            })),
            limitations: ["Aucune décision humaine n'est encore enregistrée."],
          },
          task: "EVIDENCE_EXPLANATION", model: "gpt-routine-test", selectionReason: "test",
          cached: false, durationMs: 3, tokenUsage: { input: 1, output: 1 },
        };
      },
    },
    async loadFacts() { return complexFacts; },
    async loadReconciliation() {
      return { id: "RECONCILIATION:proof", kind: "RECONCILIATION", status: "REVIEW_REQUIRED", message: "preuve", proofId: "proof" };
    },
    async loadAudit() {
      return { id: "AUDIT:proof", kind: "AUDIT", status: "ANOMALY", message: "preuve", proofId: "proof" };
    },
    async record(_runId, step, _state, event) { records.push({ step, event }); },
  });

  assert.equal(planCalls, 1);
  assert.equal(explanationCalls, 1);
  assert.deepEqual(records.map((item) => item.step), [
    "INGESTOR", "ORCHESTRATOR", "RECONCILER", "AUDITOR", "EXPLAINER",
  ]);
  assert.equal(state.evidence.length, 3);
  assert.equal(state.explanation.findings.length, 3);
  assert.equal(state.humanReasons.length, 4);
  assert.equal(records.every((item) => item.event.payload !== undefined), true);
});
