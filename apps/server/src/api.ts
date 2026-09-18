import { Pool } from "pg";
import { buildApp } from "./app.js";
import { createSourceQueue } from "./queue.js";

const pool = new Pool();
const queue = createSourceQueue();
const app = buildApp(pool, queue, process.env.SOURCE_DIR ?? "/data/sources");

app.addHook("onClose", async () => {
  await queue.close();
  await pool.end();
});

app.listen({ host: "0.0.0.0", port: 3000 }).catch(async (error: unknown) => {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
});
