import { Pool } from "pg";
import { z } from "zod";
import { replayAuditProof } from "./audit-proof.js";
import { loadReferenceData } from "./reference-data.js";

const proofId = z.uuid().parse(process.argv[2]);
const pool = new Pool();
try {
  const result = await replayAuditProof(pool, proofId, loadReferenceData());
  console.log(JSON.stringify(result));
  if (!result.verified) process.exitCode = 1;
} finally {
  await pool.end();
}
