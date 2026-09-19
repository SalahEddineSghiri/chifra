import assert from "node:assert/strict";
import { test } from "node:test";
import { loadReferenceData } from "../dist/server/reference-data.js";

test("les référentiels fournis sont chargés et validés", () => {
  const reference = loadReferenceData();
  assert.equal(reference.version, "chiffra-reference-v1");
  assert.equal(reference.accounts.size, 13);
  assert.equal(reference.suppliers.length, 15);
  assert.equal(reference.accounts.get("6132"), "Redevances de crédit-bail et licences");
  assert.deepEqual(
    reference.suppliers.find((supplier) => supplier.ice === "005678901000091"),
    {
      name: "INFOTECH MAROC",
      ice: "005678901000091",
      category: "licences logicielles",
      usualVatRate: "20.00",
      account: "6132",
      recurring: true,
      averageTtcMad: "9360.00",
    },
  );
  assert.deepEqual(reference.rules, {
    periodStart: "2026-01-01",
    periodEnd: "2026-06-30",
    duplicateWindowDays: 7,
    abnormalAmountMultiplier: "10",
  });
  assert.ok(Object.values(reference.hashes).every((hash) => /^[0-9a-f]{64}$/.test(hash)));
});
