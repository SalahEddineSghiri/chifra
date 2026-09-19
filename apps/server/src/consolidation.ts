import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { Decimal } from "decimal.js";
import type { PoolClient } from "pg";

export const CONSOLIDATION_VERSION = "documents-v1";

type Fields = Record<string, unknown>;
type Values = {
  invoiceNumber: string | null;
  supplierName: string | null;
  supplierIce: string | null;
  customerIce: string | null;
  issuedOn: string | null;
  account: string | null;
  printedVatRate: string | null;
  amountHt: string | null;
  vatAmount: string | null;
  amountTtc: string | null;
};
type SourceRow = {
  id: string;
  original_filename: string;
  source_status: string;
  observation_status: string | null;
  fields: Fields | null;
};
type TabularRow = {
  id: string;
  source_id: string;
  status: string;
  external_document_id: string | null;
  fields: Fields;
};
type Candidate = SourceRow & { documentId: string | null; values: Values | null };
type Difference = {
  fieldName: keyof Values;
  documentValue: string | null;
  tabularValue: string | null;
  reason: "VALUE_MISMATCH" | "MISSING_COMPARABLE_VALUE";
};

export type ConsolidationSummary = {
  sourceCount: number;
  nonTraiteCount: number;
  failedCount: number;
  documentCount: number;
  readyCount: number;
  reviewRequiredCount: number;
  confirmedLinks: number;
  openConflicts: number;
};

function fieldValue(fields: Fields | null, name: string): string | null {
  if (!fields) return null;
  const field = fields[name];
  if (!field || typeof field !== "object") return null;
  const value = (field as Record<string, unknown>).value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function valuesFrom(fields: Fields | null): Values {
  return {
    invoiceNumber: fieldValue(fields, "invoiceNumber"),
    supplierName: fieldValue(fields, "supplierName"),
    supplierIce: fieldValue(fields, "supplierIce"),
    customerIce: fieldValue(fields, "customerIce"),
    issuedOn: fieldValue(fields, "issuedOn"),
    account: fieldValue(fields, "account"),
    printedVatRate: fieldValue(fields, "printedVatRate"),
    amountHt: fieldValue(fields, "amountHt"),
    vatAmount: fieldValue(fields, "vatAmount"),
    amountTtc: fieldValue(fields, "amountTtc"),
  };
}

function sourceReference(filename: string): string {
  return basename(filename, extname(filename)).trim().toLocaleUpperCase("fr-FR");
}

function textKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleUpperCase("fr-FR");
}

function sameValue(fieldName: keyof Values, left: string, right: string): boolean {
  if (["amountHt", "vatAmount", "amountTtc", "printedVatRate"].includes(fieldName)) {
    try {
      return new Decimal(left).eq(new Decimal(right));
    } catch {
      return false;
    }
  }
  if (fieldName === "invoiceNumber" || fieldName === "supplierName") {
    return textKey(left) === textKey(right);
  }
  return left === right;
}

function compareRepresentations(document: Values, tabular: Values): Difference[] {
  const required: (keyof Values)[] = [
    "invoiceNumber", "supplierName", "issuedOn", "amountHt", "vatAmount", "amountTtc",
  ];
  const optional: (keyof Values)[] = ["supplierIce", "printedVatRate"];
  const differences: Difference[] = [];
  for (const fieldName of required) {
    const documentValue = document[fieldName];
    const tabularValue = tabular[fieldName];
    if (documentValue === null || tabularValue === null) {
      differences.push({
        fieldName, documentValue, tabularValue, reason: "MISSING_COMPARABLE_VALUE",
      });
    } else if (!sameValue(fieldName, documentValue, tabularValue)) {
      differences.push({ fieldName, documentValue, tabularValue, reason: "VALUE_MISMATCH" });
    }
  }
  for (const fieldName of optional) {
    const documentValue = document[fieldName];
    const tabularValue = tabular[fieldName];
    if (documentValue !== null && tabularValue !== null
      && !sameValue(fieldName, documentValue, tabularValue)) {
      differences.push({ fieldName, documentValue, tabularValue, reason: "VALUE_MISMATCH" });
    }
  }
  return differences;
}

function documentStatus(values: Values): "READY" | "REVIEW_REQUIRED" {
  return [values.invoiceNumber, values.supplierName, values.issuedOn,
    values.amountHt, values.vatAmount, values.amountTtc].every((value) => value !== null)
    ? "READY" : "REVIEW_REQUIRED";
}

function documentKind(amountTtc: string | null): "INVOICE" | "CREDIT" | "UNDETERMINED" {
  if (amountTtc === null) return "UNDETERMINED";
  try {
    return new Decimal(amountTtc).isNegative() ? "CREDIT" : "INVOICE";
  } catch {
    return "UNDETERMINED";
  }
}

async function insertDocument(
  client: PoolClient,
  batchId: string,
  values: Values,
  externalDocumentId: string | null,
  forcedReview = false,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO accounting_documents (
       id, batch_id, consolidation_version, external_document_id, kind, status,
       invoice_number, supplier_name, supplier_ice, customer_ice, issued_on, account,
       printed_vat_rate, amount_ht, vat_amount, amount_ttc
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [id, batchId, CONSOLIDATION_VERSION, externalDocumentId, documentKind(values.amountTtc),
      forcedReview ? "REVIEW_REQUIRED" : documentStatus(values),
      values.invoiceNumber, values.supplierName, values.supplierIce, values.customerIce,
      values.issuedOn, values.account, values.printedVatRate, values.amountHt,
      values.vatAmount, values.amountTtc],
  );
  return id;
}

async function insertRelation(
  client: PoolClient,
  documentId: string,
  sourceId: string,
  tabularRecordId: string | null,
  status: "PRIMARY" | "CONFIRMED" | "CONFLICT_CANDIDATE",
) {
  await client.query(
    `INSERT INTO accounting_document_sources (
       id, document_id, source_id, tabular_record_id, relation_status
     ) VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), documentId, sourceId, tabularRecordId, status],
  );
}

async function insertConflict(
  client: PoolClient,
  batchId: string,
  documentId: string,
  tabularRecordId: string | null,
  candidateSourceId: string | null,
  fieldName: string,
  documentValue: string | null,
  tabularValue: string | null,
  reason: "VALUE_MISMATCH" | "MISSING_COMPARABLE_VALUE"
    | "SOURCE_WITHOUT_OBSERVATIONS" | "AMBIGUOUS_SOURCE_IDENTIFIER",
) {
  await client.query(
    `INSERT INTO accounting_document_conflicts (
       id, batch_id, document_id, tabular_record_id, candidate_source_id,
       field_name, document_value, tabular_value, reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), batchId, documentId, tabularRecordId, candidateSourceId,
      fieldName, documentValue, tabularValue, reason],
  );
}

export async function summarizeConsolidation(
  client: PoolClient,
  batchId: string,
): Promise<ConsolidationSummary> {
  const result = await client.query<ConsolidationSummary>(
    `SELECT
       (SELECT count(*)::int FROM source_files WHERE batch_id = $1) AS "sourceCount",
       (SELECT count(*)::int FROM source_files WHERE batch_id = $1 AND status = 'NON_TRAITE') AS "nonTraiteCount",
       (SELECT count(*)::int FROM source_files WHERE batch_id = $1 AND status = 'FAILED') AS "failedCount",
       (SELECT count(*)::int FROM accounting_documents WHERE batch_id = $1) AS "documentCount",
       (SELECT count(*)::int FROM accounting_documents WHERE batch_id = $1 AND status = 'READY') AS "readyCount",
       (SELECT count(*)::int FROM accounting_documents WHERE batch_id = $1 AND status = 'REVIEW_REQUIRED') AS "reviewRequiredCount",
       (SELECT count(*)::int FROM accounting_document_sources ads
          JOIN accounting_documents ad ON ad.id = ads.document_id
         WHERE ad.batch_id = $1 AND ads.relation_status = 'CONFIRMED') AS "confirmedLinks",
       (SELECT count(*)::int FROM accounting_document_conflicts
         WHERE batch_id = $1 AND status = 'OPEN') AS "openConflicts"`,
    [batchId],
  );
  const summary = result.rows[0];
  if (!summary) throw new Error("Bilan de consolidation absent");
  return summary;
}

export async function consolidateBatch(client: PoolClient, batchId: string) {
  const sources = await client.query<SourceRow>(
    `SELECT sf.id, sf.original_filename, sf.status AS source_status,
            so.status AS observation_status, so.fields
       FROM source_files sf
       LEFT JOIN source_observations so ON so.source_id = sf.id
      WHERE sf.batch_id = $1 AND sf.media_type IN ('application/pdf', 'image/jpeg')
      ORDER BY sf.created_at, sf.id`,
    [batchId],
  );
  const tabularRecords = await client.query<TabularRow>(
    `SELECT str.id, str.source_id, str.status, str.external_document_id, str.fields
       FROM source_tabular_records str
       JOIN source_files sf ON sf.id = str.source_id
      WHERE sf.batch_id = $1
      ORDER BY sf.created_at, str.row_number, str.id`,
    [batchId],
  );

  const candidates = new Map<string, Candidate[]>();
  for (const source of sources.rows) {
    const values = source.fields ? valuesFrom(source.fields) : null;
    const documentId = values ? await insertDocument(client, batchId, values, null) : null;
    if (documentId) await insertRelation(client, documentId, source.id, null, "PRIMARY");
    const key = sourceReference(source.original_filename);
    const list = candidates.get(key) ?? [];
    list.push({ ...source, documentId, values });
    candidates.set(key, list);
  }

  for (const record of tabularRecords.rows) {
    const values = valuesFrom(record.fields);
    const key = record.external_document_id?.trim().toLocaleUpperCase("fr-FR") ?? null;
    const matches = key ? candidates.get(key) ?? [] : [];
    if (matches.length === 0) {
      const documentId = await insertDocument(
        client, batchId, values, record.external_document_id,
        record.status !== "COMPLETE" || record.external_document_id === null,
      );
      await insertRelation(client, documentId, record.source_id, record.id, "PRIMARY");
      continue;
    }

    if (matches.length > 1) {
      const documentId = await insertDocument(
        client, batchId, values, record.external_document_id, true,
      );
      await insertRelation(client, documentId, record.source_id, record.id, "PRIMARY");
      for (const match of matches) {
        await insertConflict(
          client, batchId, documentId, record.id, match.id, "externalDocumentId",
          sourceReference(match.original_filename), record.external_document_id,
          "AMBIGUOUS_SOURCE_IDENTIFIER",
        );
        if (match.documentId) {
          await client.query(
            "UPDATE accounting_documents SET status = 'REVIEW_REQUIRED' WHERE id = $1",
            [match.documentId],
          );
        }
      }
      continue;
    }

    const match = matches[0];
    if (!match) throw new Error("Candidat de consolidation absent");
    if (!match.documentId || !match.values) {
      const documentId = await insertDocument(
        client, batchId, values, record.external_document_id, true,
      );
      await insertRelation(client, documentId, record.source_id, record.id, "PRIMARY");
      await insertRelation(client, documentId, match.id, null, "CONFLICT_CANDIDATE");
      await insertConflict(
        client, batchId, documentId, record.id, match.id, "sourceExtraction",
        match.source_status, record.status, "SOURCE_WITHOUT_OBSERVATIONS",
      );
      continue;
    }

    const differences = compareRepresentations(match.values, values);
    await client.query(
      `UPDATE accounting_documents
          SET external_document_id = $2,
              account = COALESCE(account, $3)
        WHERE id = $1`,
      [match.documentId, record.external_document_id, values.account],
    );
    if (differences.length === 0) {
      await insertRelation(client, match.documentId, record.source_id, record.id, "CONFIRMED");
      continue;
    }

    await insertRelation(client, match.documentId, record.source_id, record.id, "CONFLICT_CANDIDATE");
    await client.query(
      "UPDATE accounting_documents SET status = 'REVIEW_REQUIRED' WHERE id = $1",
      [match.documentId],
    );
    for (const difference of differences) {
      await insertConflict(
        client, batchId, match.documentId, record.id, match.id,
        difference.fieldName, difference.documentValue, difference.tabularValue,
        difference.reason,
      );
    }
  }

  return summarizeConsolidation(client, batchId);
}
