import { END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import type { AgentExplanation, AgentLlm, AgentPlan, ExplanationEvidence, LlmInvocation } from "./llm.js";

export const AGENT_GRAPH_VERSION = "chiffra-agent-v1";

const actionSchema = z.enum([
  "READ_RECONCILIATION", "READ_AUDIT", "ESCALATE_HUMAN", "EXPLAIN",
]);
const evidenceSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["RECONCILIATION", "AUDIT", "INGESTION"]),
  status: z.string(),
  message: z.string(),
  proofId: z.string().nullable(),
});
const factsSchema = z.strictObject({
  batchStatus: z.string(),
  sourceCount: z.number().int().nonnegative(),
  unreadableSourceCount: z.number().int().nonnegative(),
  failedSourceCount: z.number().int().nonnegative(),
  documentCount: z.number().int().nonnegative(),
  reviewDocumentCount: z.number().int().nonnegative(),
  reconciliationAvailable: z.boolean(),
  reconciliationReviewCount: z.number().int().nonnegative(),
  auditAvailable: z.boolean(),
  auditAnomalyCount: z.number().int().nonnegative(),
});
const planSchema = z.strictObject({ actions: z.array(actionSchema), reason: z.string() });
const explanationSchema = z.strictObject({
  overview: z.string(),
  findings: z.array(z.strictObject({
    evidenceId: z.string(), explanation: z.string(), recommendedAction: z.string(),
  })),
  limitations: z.array(z.string()),
});
const stateSchema = z.strictObject({
  runId: z.string().uuid(),
  batchId: z.string().uuid(),
  facts: factsSchema.nullable(),
  plan: planSchema.nullable(),
  evidence: z.array(evidenceSchema),
  explanation: explanationSchema.nullable(),
  humanReasons: z.array(z.string()),
});

export type AgentFacts = z.infer<typeof factsSchema>;
export type AgentState = z.infer<typeof stateSchema>;
export type AgentRole = "ORCHESTRATOR" | "INGESTOR" | "RECONCILER" | "AUDITOR" | "EXPLAINER";
export type AgentEvent = {
  role: AgentRole;
  eventType: "TOOL_EXECUTED" | "LLM_CALLED" | "CACHE_HIT" | "TRANSITION";
  task: string;
  model?: string;
  selectionReason?: string;
  durationMs?: number;
  tokenUsage?: { input: number | null; output: number | null };
  payload: Record<string, unknown>;
};

export interface AgentRuntimeDependencies {
  llm: AgentLlm;
  loadFacts(batchId: string): Promise<AgentFacts>;
  loadReconciliation(batchId: string): Promise<ExplanationEvidence | null>;
  loadAudit(batchId: string): Promise<ExplanationEvidence | null>;
  record(runId: string, step: string, state: AgentState, event: AgentEvent): Promise<void>;
}

export function requiresComplexPlan(facts: AgentFacts): boolean {
  return facts.unreadableSourceCount > 0 || facts.failedSourceCount > 0
    || facts.reviewDocumentCount > 0 || facts.reconciliationReviewCount > 0
    || facts.auditAnomalyCount > 0;
}

function requiredActions(facts: AgentFacts): AgentPlan["actions"] {
  const actions: AgentPlan["actions"] = [];
  if (facts.reconciliationAvailable) actions.push("READ_RECONCILIATION");
  if (facts.auditAvailable) actions.push("READ_AUDIT");
  if (requiresComplexPlan(facts)) actions.push("ESCALATE_HUMAN");
  actions.push("EXPLAIN");
  return actions;
}

export function enforcePlan(proposed: AgentPlan | null, facts: AgentFacts): AgentPlan {
  const required = requiredActions(facts);
  return {
    actions: required,
    reason: proposed?.reason ?? "Parcours déterministe fondé sur les preuves disponibles.",
  };
}

export function humanReviewReasons(facts: AgentFacts): string[] {
  const reasons: string[] = [];
  if (facts.unreadableSourceCount > 0) reasons.push(`${facts.unreadableSourceCount} source(s) illisible(s) à examiner.`);
  if (facts.failedSourceCount > 0) reasons.push(`${facts.failedSourceCount} source(s) en erreur technique.`);
  if (facts.reviewDocumentCount > 0) reasons.push(`${facts.reviewDocumentCount} pièce(s) avec champs ambigus ou incomplets.`);
  if (facts.reconciliationReviewCount > 0) reasons.push(`${facts.reconciliationReviewCount} rapprochement(s) ambigu(s).`);
  if (facts.auditAnomalyCount > 0) reasons.push(`${facts.auditAnomalyCount} anomalie(s) issue(s) des règles déterministes.`);
  return reasons;
}

function llmEvent(role: AgentRole, invocation: LlmInvocation<unknown>): AgentEvent {
  return {
    role,
    eventType: invocation.cached ? "CACHE_HIT" : "LLM_CALLED",
    task: invocation.task,
    model: invocation.model,
    selectionReason: invocation.selectionReason,
    durationMs: invocation.durationMs,
    tokenUsage: invocation.tokenUsage,
    payload: { validated: true },
  };
}

export async function runAgentGraph(
  initial: { runId: string; batchId: string },
  dependencies: AgentRuntimeDependencies,
): Promise<AgentState> {
  async function persist(step: string, state: AgentState, event: AgentEvent) {
    const validated = stateSchema.parse(state);
    await dependencies.record(state.runId, step, validated, event);
    return validated;
  }

  const graph = new StateGraph(stateSchema)
    .addNode("ingestor", async (state) => {
      const facts = await dependencies.loadFacts(state.batchId);
      const evidence: ExplanationEvidence[] = [{
        id: "INGESTION",
        kind: "INGESTION",
        status: facts.unreadableSourceCount > 0 || facts.failedSourceCount > 0 ? "REVIEW_REQUIRED" : "READY",
        message: `Sources ${facts.sourceCount}; illisibles ${facts.unreadableSourceCount}; erreurs techniques ${facts.failedSourceCount}.`,
        proofId: null,
      }];
      const next = { ...state, facts, evidence };
      return persist("INGESTOR", next, {
        role: "INGESTOR", eventType: "TOOL_EXECUTED", task: "LOAD_VALIDATED_FACTS",
        payload: { sourceCount: facts.sourceCount, documentCount: facts.documentCount },
      });
    })
    .addNode("orchestrator", async (state) => {
      const facts = factsSchema.parse(state.facts);
      let proposed: AgentPlan | null = null;
      let event: AgentEvent = {
        role: "ORCHESTRATOR", eventType: "TRANSITION", task: "DETERMINISTIC_PLAN",
        payload: { complex: false },
      };
      if (requiresComplexPlan(facts)) {
        const invocation = await dependencies.llm.plan({
          batchStatus: facts.batchStatus,
          sourceCount: facts.sourceCount,
          unreadableSourceCount: facts.unreadableSourceCount,
          reviewDocumentCount: facts.reviewDocumentCount,
          reconciliationReviewCount: facts.reconciliationReviewCount,
          auditAnomalyCount: facts.auditAnomalyCount,
          availableTools: ["READ_RECONCILIATION", "READ_AUDIT", "ESCALATE_HUMAN", "EXPLAIN"],
        });
        proposed = invocation.output;
        event = llmEvent("ORCHESTRATOR", invocation);
      }
      const plan = enforcePlan(proposed, facts);
      const humanReasons = humanReviewReasons(facts);
      return persist("ORCHESTRATOR", { ...state, plan, humanReasons }, event);
    })
    .addNode("reconciler", async (state) => {
      const enabled = state.plan?.actions.includes("READ_RECONCILIATION") ?? false;
      const proof = enabled ? await dependencies.loadReconciliation(state.batchId) : null;
      const evidence = proof ? [...state.evidence, proof] : state.evidence;
      return persist("RECONCILER", { ...state, evidence }, {
        role: "RECONCILER", eventType: enabled ? "TOOL_EXECUTED" : "TRANSITION",
        task: enabled ? "READ_RECONCILIATION_PROOF" : "SKIP_RECONCILIATION_PROOF",
        payload: { executed: enabled, proofId: proof?.proofId ?? null },
      });
    })
    .addNode("auditor", async (state) => {
      const enabled = state.plan?.actions.includes("READ_AUDIT") ?? false;
      const proof = enabled ? await dependencies.loadAudit(state.batchId) : null;
      const evidence = proof ? [...state.evidence, proof] : state.evidence;
      return persist("AUDITOR", { ...state, evidence }, {
        role: "AUDITOR", eventType: enabled ? "TOOL_EXECUTED" : "TRANSITION",
        task: enabled ? "READ_AUDIT_PROOF" : "SKIP_AUDIT_PROOF",
        payload: { executed: enabled, proofId: proof?.proofId ?? null },
      });
    })
    .addNode("explainer", async (state) => {
      if (state.evidence.length === 0) throw new Error("Aucune preuve disponible pour l'explication.");
      const invocation: LlmInvocation<AgentExplanation> = await dependencies.llm.explain({ evidence: state.evidence });
      const next = { ...state, explanation: invocation.output };
      return persist("EXPLAINER", next, llmEvent("EXPLAINER", invocation));
    })
    .addEdge(START, "ingestor")
    .addEdge("ingestor", "orchestrator")
    .addEdge("orchestrator", "reconciler")
    .addEdge("reconciler", "auditor")
    .addEdge("auditor", "explainer")
    .addEdge("explainer", END)
    .compile();

  const state = await graph.invoke({
    runId: initial.runId,
    batchId: initial.batchId,
    facts: null,
    plan: null,
    evidence: [],
    explanation: null,
    humanReasons: [],
  });
  return stateSchema.parse(state);
}
