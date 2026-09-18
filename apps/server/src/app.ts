import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

const createBatchSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
});

type BatchRow = {
  id: string;
  name: string | null;
  status: string;
  created_at: Date;
};

function serializeBatch(row: BatchRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

export function buildApp(pool: Pool) {
  const app = Fastify({ logger: true, bodyLimit: 16 * 1024 });

  app.get("/api/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });

  app.get("/api/batches", async () => {
    const result = await pool.query<BatchRow>(
      "SELECT id, name, status, created_at FROM batches ORDER BY created_at DESC, id DESC LIMIT 100",
    );
    return { batches: result.rows.map(serializeBatch) };
  });

  app.post("/api/batches", async (request, reply) => {
    const parsed = createBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Nom de lot requis (1 à 120 caractères)." });
    }

    const result = await pool.query<BatchRow>(
      "INSERT INTO batches (id, name) VALUES ($1, $2) RETURNING id, name, status, created_at",
      [randomUUID(), parsed.data.name],
    );
    const batch = result.rows[0];
    if (!batch) throw new Error("Création du lot sans résultat PostgreSQL");
    return reply.code(201).send({ batch: serializeBatch(batch) });
  });

  return app;
}
