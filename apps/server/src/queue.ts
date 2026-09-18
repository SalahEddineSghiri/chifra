import { Queue } from "bullmq";

export const SOURCE_QUEUE = "source-pdf-text";
export type SourceJob = { sourceId: string };

export function redisConnection() {
  return { host: process.env.REDIS_HOST ?? "redis", port: 6379 };
}

export function createSourceQueue() {
  return new Queue<SourceJob>(SOURCE_QUEUE, { connection: redisConnection() });
}
