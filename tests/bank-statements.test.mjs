import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../dist/server/app.js";
import { createSourceQueue } from "../dist/server/queue.js";

function multipartFile(content, filename, mediaType) {
  const boundary = `chiffra-${randomUUID()}`;
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test("import CSV bancaire atomique, exact et idempotent", async () => {
  const pool = new Pool();
  const queue = createSourceQueue();
  const app = buildApp(pool, queue, "/tmp/chiffra-bank-unused");
  const csv = await readFile(new URL("./fixtures/bank-statement.csv", import.meta.url));

  try {
    const created = await app.inject({
      method: "POST", url: "/api/batches", payload: { name: `Lot banque ${randomUUID()}` },
    });
    assert.equal(created.statusCode, 201);
    const batchId = created.json().batch.id;
    const upload = () => app.inject({
      method: "POST", url: `/api/batches/${batchId}/bank-statements`,
      ...multipartFile(csv, "releve-test.csv", "text/csv"),
    });

    const imported = await upload();
    assert.equal(imported.statusCode, 201, imported.body);
    assert.equal(imported.json().statement.rowCount, 3);
    assert.equal(imported.json().statement.parserVersion, "bank-csv-v1");

    const listed = await app.inject({
      method: "GET", url: `/api/batches/${batchId}/bank-statements`,
    });
    assert.equal(listed.statusCode, 200);
    const [statement] = listed.json().statements;
    assert.equal(statement.filename, "releve-test.csv");
    assert.equal(statement.lines[0].label, "VIR FOURNISSEUR, EXEMPLE");
    assert.equal(statement.lines[0].debitMad, "120.00");
    assert.equal(statement.lines[0].rawValues.debit_mad, "120.0");
    assert.equal(statement.lines[0].classification, "PURCHASE_CANDIDATE");
    assert.equal(statement.lines[0].balanceConsistent, null);
    assert.equal(statement.lines[1].classification, "SALARY");
    assert.equal(statement.lines[1].balanceConsistent, true);
    assert.equal(statement.lines[2].classification, "CLIENT_RECEIPT");
    assert.equal(statement.lines[2].balanceConsistent, false);

    assert.equal((await upload()).statusCode, 409);

    const invalid = Buffer.from([
      "date,libelle,debit_mad,credit_mad,solde_mad",
      "2026-01-08,VIR INVALIDE,10.00,5.00,826.00",
    ].join("\n"));
    const rejected = await app.inject({
      method: "POST", url: `/api/batches/${batchId}/bank-statements`,
      ...multipartFile(invalid, "invalide.csv", "text/csv"),
    });
    assert.equal(rejected.statusCode, 422);
    assert.match(rejected.json().error, /un seul montant débit ou crédit/);

    const stored = await pool.query(
      `SELECT count(*)::int AS statements,
              (SELECT count(*)::int FROM bank_lines bl
                JOIN bank_statements bs ON bs.id = bl.statement_id
               WHERE bs.batch_id = $1) AS lines,
              bool_and(raw_content LIKE 'date,libelle,%') AS raw_preserved
         FROM bank_statements WHERE batch_id = $1`,
      [batchId],
    );
    assert.deepEqual(stored.rows[0], { statements: 1, lines: 3, raw_preserved: true });
  } finally {
    await app.close();
    await queue.close();
    await pool.end();
  }
});
