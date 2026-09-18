import { Pool } from "pg";
import { buildApp } from "./app.js";

const pool = new Pool();
const app = buildApp(pool);

app.addHook("onClose", async () => {
  await pool.end();
});

app.listen({ host: "0.0.0.0", port: 3000 }).catch(async (error: unknown) => {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
});
