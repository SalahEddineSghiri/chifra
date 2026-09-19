import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractXlsx } from "../dist/server/xlsx.js";

test("le parseur XLSX conserve les cellules brutes et normalise les décimales", async () => {
  const result = await extractXlsx(fileURLToPath(new URL("./fixtures/purchases.xlsx", import.meta.url)));
  assert.equal(result.status, "DONE");
  assert.equal(result.sheetName, "achats T2");
  assert.equal(result.records.length, 3);
  const first = result.records[0];
  assert.equal(first.status, "COMPLETE");
  assert.equal(first.externalDocumentId, "TST-001");
  assert.equal(first.fields.supplierIce.value, "001234567890123");
  assert.equal(first.fields.amountHt.rawValue, "1000");
  assert.equal(first.fields.amountHt.value, "1000.00");
  assert.deepEqual(first.fields.amountHt.normalization, ["DECIMAL_CANONICAL"]);
  assert.equal(result.records[2].fields.amountTtc.value, "-120.00");
});

test("un faux XLSX reste non traité avec un motif", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chiffra-invalid-xlsx-"));
  const path = join(directory, "invalid.xlsx");
  try {
    await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
    const result = await extractXlsx(path);
    assert.equal(result.status, "NON_TRAITE");
    assert.match(result.reason, /tronquée ou illisible/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
