import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  BANK_CSV_VERSION, BankCsvError, parseBankStatementCsv, type ParsedBankLine,
} from "./bank-csv.js";

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const paramsSchema = z.strictObject({ batchId: z.uuid() });

type StatementRow = {
  id: string;
  original_filename: string;
  parser_version: string;
  row_count: number;
  created_at: Date;
};
type LineRow = {
  id: string;
  statement_id: string;
  line_number: number;
  booked_on: string;
  label: string;
  debit_mad: string;
  credit_mad: string;
  balance_mad: string;
  classification: string;
  balance_consistent: boolean | null;
  raw_values: Record<string, string>;
};

function serializeLine(row: LineRow) {
  return {
    id: row.id,
    lineNumber: row.line_number,
    bookedOn: row.booked_on,
    label: row.label,
    debitMad: row.debit_mad,
    creditMad: row.credit_mad,
    balanceMad: row.balance_mad,
    classification: row.classification,
    balanceConsistent: row.balance_consistent,
    rawValues: row.raw_values,
  };
}

export function registerBankStatementRoutes(app: FastifyInstance, pool: Pool) {
  app.get("/api/batches/:batchId/bank-statements", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identifiant de lot invalide." });
    const batch = await pool.query("SELECT 1 FROM batches WHERE id = $1", [params.data.batchId]);
    if (batch.rowCount === 0) return reply.code(404).send({ error: "Lot introuvable." });

    const statements = await pool.query<StatementRow>(
      `SELECT id, original_filename, parser_version, row_count, created_at
         FROM bank_statements WHERE batch_id = $1 ORDER BY created_at DESC, id DESC`,
      [params.data.batchId],
    );
    const lines = await pool.query<LineRow>(
      `SELECT bl.id, bl.statement_id, bl.line_number, bl.booked_on::text, bl.label,
              bl.debit_mad::text, bl.credit_mad::text, bl.balance_mad::text,
              bl.classification, bl.balance_consistent, bl.raw_values
         FROM bank_lines bl
         JOIN bank_statements bs ON bs.id = bl.statement_id
        WHERE bs.batch_id = $1 ORDER BY bs.created_at DESC, bl.line_number`,
      [params.data.batchId],
    );
    return {
      statements: statements.rows.map((statement) => ({
        id: statement.id,
        filename: statement.original_filename,
        parserVersion: statement.parser_version,
        rowCount: statement.row_count,
        createdAt: statement.created_at.toISOString(),
        lines: lines.rows.filter((line) => line.statement_id === statement.id).map(serializeLine),
      })),
    };
  });

  app.post("/api/batches/:batchId/bank-statements", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Identifiant de lot invalide." });
    const batch = await pool.query<{ status: string }>(
      "SELECT status FROM batches WHERE id = $1", [params.data.batchId],
    );
    if (batch.rowCount === 0) return reply.code(404).send({ error: "Lot introuvable." });
    if (batch.rows[0]?.status !== "OPEN") {
      return reply.code(409).send({ error: "Le lot n'accepte plus de relevés." });
    }

    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "Fichier CSV requis." });
    const filename = basename(file.filename.replaceAll("\\", "/")).trim();
    const acceptedMime = new Set(["text/csv", "text/plain", "application/vnd.ms-excel"]);
    if (filename.length < 1 || filename.length > 255 || /[\x00-\x1f]/.test(filename)
      || !filename.toLowerCase().endsWith(".csv") || !acceptedMime.has(file.mimetype)) {
      return reply.code(415).send({ error: "Relevé CSV valide requis." });
    }
    const content = await file.toBuffer();
    if (content.length < 1 || content.length > MAX_CSV_BYTES) {
      return reply.code(413).send({ error: "Relevé CSV limité à 2 Mo." });
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      return reply.code(422).send({ error: "Le relevé doit être encodé en UTF-8." });
    }
    let lines: ParsedBankLine[];
    try {
      lines = parseBankStatementCsv(text);
    } catch (error) {
      if (error instanceof BankCsvError) return reply.code(422).send({ error: error.message });
      throw error;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const statementId = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO bank_statements (
           id, batch_id, content_sha256, original_filename, parser_version, raw_content, row_count
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (batch_id, content_sha256) DO NOTHING RETURNING id`,
        [statementId, params.data.batchId, createHash("sha256").update(content).digest("hex"),
          filename, BANK_CSV_VERSION, text, lines.length],
      );
      if (inserted.rowCount === 0) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "Ce relevé existe déjà dans ce lot." });
      }
      for (const line of lines) {
        await client.query(
          `INSERT INTO bank_lines (
             id, statement_id, line_number, booked_on, label, debit_mad, credit_mad,
             balance_mad, classification, balance_consistent, raw_values
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
          [randomUUID(), statementId, line.lineNumber, line.bookedOn, line.label,
            line.debitMad, line.creditMad, line.balanceMad, line.classification,
            line.balanceConsistent, JSON.stringify(line.rawValues)],
        );
      }
      await client.query("COMMIT");
      return reply.code(201).send({
        statement: { id: statementId, filename, parserVersion: BANK_CSV_VERSION, rowCount: lines.length },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
