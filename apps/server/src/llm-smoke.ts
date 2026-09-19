import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createAzureAgentLlm } from "./llm.js";

const pool = new Pool();
const llm = createAzureAgentLlm(pool);
const nonce = randomUUID();

try {
  const plan = await llm.plan({
    batchStatus: "COMPLETED",
    sourceCount: Date.now(),
    unreadableSourceCount: 1,
    reviewDocumentCount: 0,
    reconciliationReviewCount: 0,
    auditAnomalyCount: 0,
    availableTools: ["ESCALATE_HUMAN", "EXPLAIN"],
  });
  const explanation = await llm.explain({
    evidence: [{
      id: `SMOKE:${nonce}`,
      kind: "INGESTION",
      status: "REVIEW_REQUIRED",
      message: "Une source illisible nécessite une vérification humaine.",
      proofId: null,
    }],
  });
  console.log(JSON.stringify({
    complex: { model: plan.model, validated: true, cached: plan.cached, durationMs: plan.durationMs },
    routine: { model: explanation.model, validated: true, cached: explanation.cached, durationMs: explanation.durationMs },
  }));
} finally {
  await pool.end();
}
