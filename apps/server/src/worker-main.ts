import { Pool } from "pg";
import { createSourceQueue } from "./queue.js";
import { startSourceWorker } from "./worker.js";

const pool = new Pool();
const queue = createSourceQueue();
const closeWorker = await startSourceWorker(
  pool, queue, process.env.SOURCE_DIR ?? "/data/sources",
);

async function stop() {
  await closeWorker();
  await queue.close();
  await pool.end();
}

process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
