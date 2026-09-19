import { Queue } from "bullmq";

export const SOURCE_QUEUE = "source-extraction";
export const SOURCE_JOB_ATTEMPTS = 3;
export type SourceJob = { sourceId: string };
export type ReconciliationJob = { reconciliationJobId: string; batchId: string };
export type QueueJob = SourceJob | ReconciliationJob;

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
