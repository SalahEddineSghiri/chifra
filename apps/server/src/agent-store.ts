import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { AGENT_GRAPH_VERSION, runAgentGraph, type AgentEvent, type AgentFacts, type AgentState } from "./agent-runtime.js";
import { getAudit } from "./audit-store.js";
import type { AgentLlm, ExplanationEvidence } from "./llm.js";
import { getCurrentReconciliation } from "./reconciliation-store.js";

type AgentRunRow = {
  id: string;
  batch_id: string;
  graph_version: string;
  status: "PENDING" | "PROCESSING" | "WAITING_HUMAN" | "COMPLETED" | "FAILED";
  current_step: string | null;
  failure_reason: string | null;
  plan: unknown;
  explanation: unknown;
  requires_human: boolean;
  human_reasons: unknown;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

type AgentEventRow = {
  id: string;
  sequence: number;
  role: string;
  event_type: string;
  task: string;
  model: string | null;
  selection_reason: string | null;
  duration_ms: number | null;
  token_usage: unknown;
  payload: unknown;
  created_at: Date;
};

const reasonsSchema = z.array(z.string());

export type AgentRunView = {
  id: string;
  batchId: string;
  graphVersion: string;
  status: AgentRunRow["status"];
  currentStep: string | null;
  failureReason: string | null;
  plan: unknown;
  explanation: unknown;
  requiresHuman: boolean;
  humanReasons: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  events: Array<{
    id: string;
    sequence: number;
    role: string;
    eventType: string;
    task: string;
    model: string | null;
    selectionReason: string | null;
    durationMs: number | null;
    tokenUsage: unknown;
    payload: unknown;
    createdAt: string;
  }>;
};

function serialize(row: AgentRunRow, events: AgentEventRow[]): AgentRunView {
  return {
    id: row.id,
    batchId: row.batch_id,
    graphVersion: row.graph_version,
    status: row.status,
    currentStep: row.current_step,
    failureReason: row.failure_reason,
    plan: row.plan,
    explanation: row.explanation,
    requiresHuman: row.requires_human,
    humanReasons: reasonsSchema.parse(row.human_reasons),
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    events: events.map((event) => ({
      id: event.id,
      sequence: event.sequence,
      role: event.role,
      eventType: event.event_type,
      task: event.task,
      model: event.model,
      selectionReason: event.selection_reason,
      durationMs: event.duration_ms,
      tokenUsage: event.token_usage,
      payload: event.payload,
      createdAt: event.created_at.toISOString(),
    })),
  };
}

export async function getAgentRun(pool: Pool, batchId: string): Promise<AgentRunView | null> {
  const result = await pool.query<AgentRunRow>(
    `SELECT id, batch_id, graph_version, status, current_step, failure_reason,
            plan, explanation, requires_human, human_reasons,
            created_at, started_at, completed_at
       FROM agent_runs WHERE batch_id = $1 AND graph_version = $2`,
    [batchId, AGENT_GRAPH_VERSION],
  );
  const row = result.rows[0];
  if (!row) return null;
  const events = await pool.query<AgentEventRow>(
    `SELECT id, sequence, role, event_type, task, model, selection_reason,
            duration_ms, token_usage, payload, created_at
       FROM agent_events WHERE run_id = $1 ORDER BY sequence`,
    [row.id],
  );
  return serialize(row, events.rows);
}

export async function loadAgentFacts(pool: Pool, batchId: string): Promise<AgentFacts> {
  const result = await pool.query<{
    batch_status: string;
    source_count: number;
    unreadable_source_count: number;
    failed_source_count: number;
    document_count: number;
    review_document_count: number;
    reconciliation_summary: Record<string, unknown> | null;
    audit_summary: Record<string, unknown> | null;
  }>(
    `SELECT b.status AS batch_status,
            (SELECT count(*)::int FROM source_files sf WHERE sf.batch_id = b.id) AS source_count,
            (SELECT count(*)::int FROM source_files sf WHERE sf.batch_id = b.id AND sf.status = 'NON_TRAITE') AS unreadable_source_count,
            (SELECT count(*)::int FROM source_files sf WHERE sf.batch_id = b.id AND sf.status = 'FAILED') AS failed_source_count,
            (SELECT count(*)::int FROM accounting_documents ad WHERE ad.batch_id = b.id) AS document_count,
            (SELECT count(*)::int FROM accounting_documents ad WHERE ad.batch_id = b.id AND ad.status = 'REVIEW_REQUIRED') AS review_document_count,
            (SELECT rr.summary FROM reconciliation_runs rr WHERE rr.batch_id = b.id AND rr.is_current = true LIMIT 1) AS reconciliation_summary,
            (SELECT ar.summary FROM audit_runs ar WHERE ar.batch_id = b.id ORDER BY ar.created_at DESC LIMIT 1) AS audit_summary
       FROM batches b WHERE b.id = $1`,
    [batchId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Lot introuvable pour l'analyse agentique.");
  const reconciliationReviewCount = Number(row.reconciliation_summary?.reviewRequiredLines ?? 0);
  const auditAnomalyCount = Number(row.audit_summary?.anomalyCount ?? 0);
  return {
    batchStatus: row.batch_status,
    sourceCount: row.source_count,
    unreadableSourceCount: row.unreadable_source_count,
    failedSourceCount: row.failed_source_count,
    documentCount: row.document_count,
    reviewDocumentCount: row.review_document_count,
    reconciliationAvailable: row.reconciliation_summary !== null,
    reconciliationReviewCount,
    auditAvailable: row.audit_summary !== null,
    auditAnomalyCount,
  };
}

async function record(
  pool: Pool,
  runId: string,
  step: string,
  state: AgentState,
  event: AgentEvent,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM agent_runs WHERE id = $1 FOR UPDATE", [runId]);
    const sequenceResult = await client.query<{ sequence: number }>(
      "SELECT COALESCE(max(sequence), 0)::int + 1 AS sequence FROM agent_events WHERE run_id = $1",
      [runId],
    );
    const sequence = sequenceResult.rows[0]?.sequence ?? 1;
    await client.query(
      `INSERT INTO agent_events (
         id, run_id, sequence, role, event_type, task, model, selection_reason,
         duration_ms, token_usage, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)`,
      [randomUUID(), runId, sequence, event.role, event.eventType, event.task,
        event.model ?? null, event.selectionReason ?? null, event.durationMs ?? null,
        event.tokenUsage ? JSON.stringify(event.tokenUsage) : null, JSON.stringify(event.payload)],
    );
    await client.query(
      `INSERT INTO agent_checkpoints (id, run_id, step, state)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (run_id, step) DO UPDATE SET state = EXCLUDED.state, created_at = now()`,
      [randomUUID(), runId, step, JSON.stringify(state)],
    );
    await client.query(
      "UPDATE agent_runs SET current_step = $2, plan = $3::jsonb WHERE id = $1",
      [runId, step, state.plan ? JSON.stringify(state.plan) : null],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function reconciliationEvidence(summary: Record<string, unknown>, proofId: string): ExplanationEvidence {
  return {
    id: `RECONCILIATION:${proofId}`,
    kind: "RECONCILIATION",
    status: Number(summary.reviewRequiredLines ?? 0) > 0 ? "REVIEW_REQUIRED" : "CALCULATED",
    message: `Résumé déterministe du rapprochement : ${JSON.stringify(summary)}.`,
    proofId,
  };
}

function auditEvidence(summary: Record<string, unknown>, proofId: string): ExplanationEvidence {
  return {
    id: `AUDIT:${proofId}`,
    kind: "AUDIT",
    status: Number(summary.anomalyCount ?? 0) > 0 ? "ANOMALY" : "CALCULATED",
    message: `Résumé déterministe des contrôles : ${JSON.stringify(summary)}.`,
    proofId,
  };
}

export async function executeAgentRun(
  pool: Pool,
  runId: string,
  batchId: string,
  referenceVersion: string,
  llm: AgentLlm,
): Promise<AgentState> {
  const finalState = await runAgentGraph({ runId, batchId }, {
    llm,
    loadFacts: (id) => loadAgentFacts(pool, id),
    async loadReconciliation(id) {
      const value = await getCurrentReconciliation(pool, id);
      return value ? reconciliationEvidence(value.summary, value.proofId) : null;
    },
    async loadAudit(id) {
      const value = await getAudit(pool, id, referenceVersion);
      return value ? auditEvidence(value.summary, value.id) : null;
    },
    record: (id, step, state, event) => record(pool, id, step, state, event),
  });
  const requiresHuman = finalState.humanReasons.length > 0;
  await pool.query(
    `UPDATE agent_runs
        SET status = $2, current_step = 'COMPLETED', failure_reason = NULL,
            plan = $3::jsonb, explanation = $4::jsonb,
            requires_human = $5, human_reasons = $6::jsonb, completed_at = now()
      WHERE id = $1`,
    [runId, requiresHuman ? "WAITING_HUMAN" : "COMPLETED",
      JSON.stringify(finalState.plan), JSON.stringify(finalState.explanation),
      requiresHuman, JSON.stringify(finalState.humanReasons)],
  );
  return finalState;
}

export async function recordAgentError(
  pool: Pool,
  runId: string,
  attempt: number,
  finalAttempt: boolean,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM agent_runs WHERE id = $1 FOR UPDATE", [runId]);
    const sequenceResult = await client.query<{ sequence: number }>(
      "SELECT COALESCE(max(sequence), 0)::int + 1 AS sequence FROM agent_events WHERE run_id = $1",
      [runId],
    );
    await client.query(
      `INSERT INTO agent_events (
         id, run_id, sequence, role, event_type, task, payload
       ) VALUES ($1, $2, $3, 'RUNTIME', 'ERROR', 'AGENT_ATTEMPT_FAILED', $4::jsonb)`,
      [randomUUID(), runId, sequenceResult.rows[0]?.sequence ?? 1,
        JSON.stringify({ attempt, finalAttempt })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
