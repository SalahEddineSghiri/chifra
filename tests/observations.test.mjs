import assert from "node:assert/strict";
import { test } from "node:test";
import { extractInvoiceObservations } from "../dist/server/observations.js";

test("les montants et la date lus conservent leur page sans calcul métier", () => {
  const result = extractInvoiceObservations([{
    page: 2,
    text: [
      "FOURNISSEUR EXEMPLE",
      "ICE 005678901000091",
      "FACTURE N FA-2026-0001",
      "Date",
      "2026-01-01",
      "ICE client",
      "001987654000073",
      "Total HT",
      "7 800.00",
      "TVA 20%",
      "1 560.00",
      "Net a payer TTC",
      "9 360.00",
    ].join("\n"),
  }]);

  assert.equal(result.status, "COMPLETE");
  assert.deepEqual(result.fields.amountHt, { value: "7800.00", page: 2, missingReason: null });
  assert.deepEqual(result.fields.vatAmount, { value: "1560.00", page: 2, missingReason: null });
  assert.deepEqual(result.fields.amountTtc, { value: "9360.00", page: 2, missingReason: null });
  assert.equal(result.fields.printedVatRate.value, "20");
  assert.equal(result.fields.issuedOn.value, "2026-01-01");
});

test("un champ ambigu ou absent reste nul avec motif", () => {
  const result = extractInvoiceObservations([{
    page: 1,
    text: "Total HT\n100.00\nTotal HT\n200.00\nDate\n2026-02-30",
  }]);

  assert.equal(result.status, "PARTIAL");
  assert.equal(result.fields.amountHt.value, null);
  assert.match(result.fields.amountHt.missingReason, /Plusieurs valeurs/);
  assert.equal(result.fields.issuedOn.value, null);
  assert.ok(result.fields.issuedOn.missingReason);
  assert.equal(result.fields.amountTtc.value, null);
  assert.equal(result.fields.amountTtc.page, null);
});
