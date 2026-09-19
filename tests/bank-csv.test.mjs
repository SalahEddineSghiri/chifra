import assert from "node:assert/strict";
import { test } from "node:test";
import { BankCsvError, parseBankStatementCsv } from "../dist/server/bank-csv.js";

test("le parseur bancaire conserve le brut et calcule sans flottants", () => {
  const parsed = parseBankStatementCsv([
    "date,libelle,debit_mad,credit_mad,solde_mad",
    '2026-01-05,"VIR FOURNISSEUR, EXEMPLE",120.0,0.0,880.0',
    "2026-01-06,VIREMENT SALAIRES,100.00,0.00,780.00",
    "2026-01-07,REGLEMENT CLIENT EXEMPLE,0.0,50.0,831.0",
  ].join("\n"));

  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].label, "VIR FOURNISSEUR, EXEMPLE");
  assert.equal(parsed[0].debitMad, "120.00");
  assert.equal(parsed[0].rawValues.debit_mad, "120.0");
  assert.equal(parsed[0].classification, "PURCHASE_CANDIDATE");
  assert.equal(parsed[0].balanceConsistent, null);
  assert.equal(parsed[1].classification, "SALARY");
  assert.equal(parsed[1].balanceConsistent, true);
  assert.equal(parsed[2].classification, "CLIENT_RECEIPT");
  assert.equal(parsed[2].balanceConsistent, false);
});

test("le parseur bancaire refuse une direction et un format ambigus", () => {
  assert.throws(() => parseBankStatementCsv([
    "date,libelle,debit_mad,credit_mad,solde_mad",
    "2026-01-08,VIR INVALIDE,10.00,5.00,826.00",
  ].join("\n")), BankCsvError);
  assert.throws(() => parseBankStatementCsv([
    "date,libelle,debit_mad,credit_mad,solde_mad",
    "08/01/2026,VIR INVALIDE,10,0,826",
  ].join("\n")), /date ISO invalide/);
});
