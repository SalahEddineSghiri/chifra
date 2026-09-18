import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../dist/server/app.js";

test("création et lecture d'un lot persistent dans PostgreSQL", async () => {
  const pool = new Pool();
  const writer = buildApp(pool);
  const reader = buildApp(pool);
  const name = `Lot test ${randomUUID()}`;

  try {
    const invalid = await writer.inject({
      method: "POST",
      url: "/api/batches",
      payload: { name: "   " },
    });
    assert.equal(invalid.statusCode, 400);

    const forbiddenStatus = await writer.inject({
      method: "POST",
      url: "/api/batches",
      payload: { name, status: "COMPLETED" },
    });
    assert.equal(forbiddenStatus.statusCode, 400);

    const created = await writer.inject({
      method: "POST",
      url: "/api/batches",
      payload: { name },
    });
    assert.equal(created.statusCode, 201);
    const batch = created.json().batch;
    assert.equal(batch.name, name);
    assert.equal(batch.status, "OPEN");

    const stored = await pool.query("SELECT name, status FROM batches WHERE id = $1", [batch.id]);
    assert.equal(stored.rows[0]?.name, name);
    assert.equal(stored.rows[0]?.status, "OPEN");

    const listed = await reader.inject({ method: "GET", url: "/api/batches" });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json().batches.some((item) => item.id === batch.id && item.name === name));

    const health = await reader.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
  } finally {
    await writer.close();
    await reader.close();
    await pool.end();
  }
});
