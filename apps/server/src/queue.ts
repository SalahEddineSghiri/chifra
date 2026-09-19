import { Queue } from "bullmq";

export const SOURCE_QUEUE = "source-extraction";
export const SOURCE_JOB_ATTEMPTS = 3;
export const AGENT_JOB_ATTEMPTS = 2;
export type SourceJob = { sourceId: string };
export type ReconciliationJob = { reconciliationJobId: string; batchId: string };
export type AuditJob = { auditJobId: string; batchId: string };
export type AgentJob = { agentRunId: string; batchId: string };
export type QueueJob = SourceJob | ReconciliationJob | AuditJob | AgentJob;

export function redisConnection() {
  return { host: process.env.REDIS_HOST ?? "redis", port: 6379 };
}

export function createSourceQueue() {
  return new Queue<QueueJob>(SOURCE_QUEUE, { connection: redisConnection() });
}

export async function enqueueSource(queue: Queue<QueueJob>, sourceId: string) {
  await queue.add("extract", { sourceId }, {
    jobId: sourceId,
    attempts: SOURCE_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  });
}

export async function enqueueReconciliation(
  queue: Queue<QueueJob>,
  reconciliationJobId: string,
  batchId: string,
) {
  await queue.add("reconcile", { reconciliationJobId, batchId }, {
    jobId: `reconciliation-${reconciliationJobId}`,
    attempts: SOURCE_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  });
}

export async function enqueueAudit(queue: Queue<QueueJob>, auditJobId: string, batchId: string) {
  await queue.add("audit", { auditJobId, batchId }, {
    jobId: `audit-${auditJobId}`,
    attempts: SOURCE_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  });
}

export async function enqueueAgent(queue: Queue<QueueJob>, agentRunId: string, batchId: string) {
  const jobId = `agent-${agentRunId}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed" || state === "completed") await existing.remove();
    else return;
  }
  await queue.add("agent-analysis", { agentRunId, batchId }, {
    jobId,
    attempts: AGENT_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  });
}
