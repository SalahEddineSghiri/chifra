import { Pool } from "pg";
import { z } from "zod";
import { replayReconciliationProof } from "./reconciliation-proof.js";

const proofId = z.uuid().parse(process.argv[2]);
const pool = new Pool();
try {
  const result = await replayReconciliationProof(pool, proofId);
  console.log(JSON.stringify(result));
  if (!result.verified) process.exitCode = 1;
} finally {
  await pool.end();
}
