import assert from "node:assert/strict";
import { test } from "node:test";
import { extractInvoiceObservations } from "../dist/server/observations.js";

const segment = (text, page = 1, method = "OCR", version = "test-ocr-v1") => ({
  page, text, method, version,
});

test("les montants et la date lus conservent valeur brute, normalisation et provenance", () => {
  const result = extractInvoiceObservations([segment([
    "FOURNISSEUR EXEMPLE",
    "ICE 005678901000091",
    "FACTURE N FA-2026-0001",
    "Date",
    "2026-01-1",
    "ICE client",
    "001987654000073",
    "Total HT",
    "7 800.00",
    "TVA 20%",
    "1 560.00",
    "Net a payer TTC",
    "9 360.00",
  ].join("\n"), 2, "PDF_TEXT", "poppler-test")]);

  assert.equal(result.status, "COMPLETE");
  assert.equal(result.fields.amountHt.value, "7800.00");
  assert.equal(result.fields.amountHt.rawValue, "7 800.00");
  assert.deepEqual(result.fields.amountHt.normalization, ["GROUPING_SEPARATOR_REMOVED"]);
  assert.equal(result.fields.amountHt.page, 2);
  assert.equal(result.fields.amountHt.extractionMethod, "PDF_TEXT");
  assert.equal(result.fields.amountHt.extractionVersion, "poppler-test");
  assert.equal(result.fields.vatAmount.value, "1560.00");
  assert.equal(result.fields.amountTtc.value, "9360.00");
  assert.equal(result.fields.printedVatRate.value, "20");
  assert.equal(result.fields.issuedOn.value, "2026-01-01");
  assert.equal(result.fields.issuedOn.rawValue, "2026-01-1");
  assert.deepEqual(result.fields.issuedOn.normalization, ["DATE_COMPONENT_ZERO_PADDED"]);
});

test("les chiffres arabo-indiens sont normalisés explicitement sans perdre la valeur brute", () => {
  const result = extractInvoiceObservations([segment([
    "شركة المثال العربية",
    "المعرف الموحد للمقاولة",
    "٠٠٥٦٧٨٩٠١٠٠٠٠٩١",
    "فاتورة رقم",
    "AR-٢٠٢٦-٠٠٠١",
    "التاريخ",
    "٢٠٢٦/٠١/٠٣",
    "معرف الزبون",
    "٠٠١٩٨٧٦٥٤٠٠٠٠٧٣",
    "المجموع دون الضريبة",
    "٧٬٨٠٠٫٠٠",
    "ضريبة القيمة المضافة",
    "٢٠٪ ١٬٥٦٠٫٠٠",
    "المجموع مع الضريبة",
    "٩٬٣٦٠٫٠٠",
  ].join("\n"))]);

  assert.equal(result.status, "COMPLETE");
  assert.equal(result.fields.supplierName.value, "شركة المثال العربية");
  assert.equal(result.fields.supplierIce.value, "005678901000091");
  assert.equal(result.fields.customerIce.value, "001987654000073");
  assert.equal(result.fields.invoiceNumber.value, "AR-2026-0001");
  assert.equal(result.fields.invoiceNumber.rawValue, "AR-٢٠٢٦-٠٠٠١");
  assert.equal(result.fields.issuedOn.value, "2026-01-03");
  assert.deepEqual(result.fields.issuedOn.normalization, [
    "ARABIC_INDIC_DIGITS_TO_LATIN", "DATE_SEPARATOR_TO_HYPHEN",
  ]);
  assert.equal(result.fields.amountHt.rawValue, "٧٬٨٠٠٫٠٠");
  assert.equal(result.fields.amountHt.value, "7800.00");
  assert.deepEqual(result.fields.amountHt.normalization, [
    "ARABIC_INDIC_DIGITS_TO_LATIN",
    "ARABIC_DECIMAL_TO_DOT",
    "ARABIC_THOUSANDS_REMOVED",
  ]);
  assert.equal(result.fields.vatAmount.value, "1560.00");
  assert.equal(result.fields.amountTtc.value, "9360.00");
  assert.equal(result.fields.printedVatRate.value, "20");
});

test("un champ ambigu ou absent reste nul et conserve ses candidats", () => {
  const result = extractInvoiceObservations([segment(
    "Total HT\n100.00\nTotal HT\n200.00\nDate\n2026-02-30",
  )]);

  assert.equal(result.status, "PARTIAL");
  assert.equal(result.fields.amountHt.value, null);
  assert.equal(result.fields.amountHt.rawValue, null);
  assert.match(result.fields.amountHt.missingReason, /Plusieurs valeurs/);
  assert.deepEqual(result.fields.amountHt.candidates.map((candidate) => candidate.rawValue), [
    "100.00", "200.00",
  ]);
  assert.equal(result.fields.amountHt.reviewRequired, true);
  assert.equal(result.fields.issuedOn.value, null);
  assert.ok(result.fields.issuedOn.missingReason);
  assert.equal(result.fields.amountTtc.value, null);
  assert.equal(result.fields.amountTtc.page, null);
  assert.deepEqual(result.fields.amountTtc.candidates, []);
  assert.equal(result.fields.amountTtc.reviewRequired, false);
});

test("le taux placé après le montant TVA ne fait pas partie du montant", () => {
  for (const text of [
    "ضريبة القيمة المضافة\n1560.00 20%",
    "TVA 1560.00 20%",
    "الضريبة على القيمة المضافة\n١٬٥٦٠٫٠٠ ٢٠٪",
    "TVA 1560.00 20.00%",
    "\u200fTVA 1560.00 20\u200e%",
  ]) {
    const result = extractInvoiceObservations([segment(text)]);
    assert.equal(result.fields.vatAmount.value, "1560.00", text);
    assert.ok(!result.fields.vatAmount.rawValue.includes("%"));
    assert.ok(!result.fields.vatAmount.rawValue.includes("٪"));
    assert.equal(result.fields.printedVatRate.value, text.includes("20.00%") ? "20.00" : "20");
  }
});

test("les marques de direction restent dans la source et n'empêchent pas les libellés", () => {
  const input = segment([
    "شركة المثال العربية", "المعرف الموحد للمقاولة", "005678901000091",
    "فاتورة رقم", "\u200eAR-2026-0001\u200f", "\u200fالتاريخ", "\u200f2026-01-3",
    "\u200fمعرف الزبون", "001987654000073", "المجموع دون الضريبة", "7800.00",
    "ضريبة القيمة المضافة", "1560.00 20%", "المجموع مع الضريبة", "9360.00",
  ].join("\n"));
  const before = structuredClone(input);
  const result = extractInvoiceObservations([input]);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.fields.invoiceNumber.value, "AR-2026-0001");
  assert.equal(result.fields.issuedOn.value, "2026-01-03");
  assert.equal(result.fields.vatAmount.value, "1560.00");
  assert.equal(result.fields.vatAmount.rawValue, "1560.00");
  assert.deepEqual(result.fields.vatAmount.normalization, []);
  assert.deepEqual(input, before);
});

test("sans libellé TVA reconnu, aucun montant ni taux n'est attribué", () => {
  const result = extractInvoiceObservations([segment([
    "المجموع دون الضريبة", "7800.00", "1560.00 20%",
    "المجموع مع الضريبة", "9360.00",
  ].join("\n"))]);
  assert.equal(result.fields.amountHt.value, "7800.00");
  assert.equal(result.fields.vatAmount.value, null);
  assert.equal(result.fields.printedVatRate.value, null);
  assert.equal(result.fields.amountTtc.value, "9360.00");
});
