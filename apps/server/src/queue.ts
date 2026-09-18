import { Queue } from "bullmq";

export const SOURCE_QUEUE = "source-extraction";
export const SOURCE_JOB_ATTEMPTS = 3;
export type SourceJob = { sourceId: string };

export function redisConnection() {
  return { host: process.env.REDIS_HOST ?? "redis", port: 6379 };
}

export function createSourceQueue() {
  return new Queue<SourceJob>(SOURCE_QUEUE, { connection: redisConnection() });
}

export async function enqueueSource(queue: Queue<SourceJob>, sourceId: string) {
  await queue.add("extract", { sourceId }, {
    jobId: sourceId,
    attempts: SOURCE_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  });
}
