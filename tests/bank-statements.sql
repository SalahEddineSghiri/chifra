BEGIN;

DO $$
DECLARE
  test_batch uuid := gen_random_uuid();
  test_statement uuid := gen_random_uuid();
  invalid_direction_rejected boolean := false;
  duplicate_line_rejected boolean := false;
BEGIN
  INSERT INTO batches (id, name) VALUES (test_batch, 'Test relevé');
  INSERT INTO bank_statements (
    id, batch_id, content_sha256, original_filename, parser_version, raw_content, row_count
  ) VALUES (
    test_statement, test_batch, repeat('d', 64), 'releve.csv', 'bank-csv-v1',
    'date,libelle,debit_mad,credit_mad,solde_mad', 1
  );

  INSERT INTO bank_lines (
    id, statement_id, line_number, booked_on, label, debit_mad, credit_mad,
    balance_mad, classification, balance_consistent, raw_values
  ) VALUES (
    gen_random_uuid(), test_statement, 2, '2026-01-01', 'VIR TEST', 120.00, 0.00,
    880.00, 'PURCHASE_CANDIDATE', NULL, '{}'::jsonb
  );

  BEGIN
    INSERT INTO bank_lines (
      id, statement_id, line_number, booked_on, label, debit_mad, credit_mad,
      balance_mad, classification, balance_consistent, raw_values
    ) VALUES (
      gen_random_uuid(), test_statement, 3, '2026-01-02', 'INVALIDE', 10.00, 5.00,
      875.00, 'OTHER', true, '{}'::jsonb
    );
  EXCEPTION WHEN check_violation THEN
    invalid_direction_rejected := true;
  END;

  BEGIN
    INSERT INTO bank_lines (
      id, statement_id, line_number, booked_on, label, debit_mad, credit_mad,
      balance_mad, classification, balance_consistent, raw_values
    ) VALUES (
      gen_random_uuid(), test_statement, 2, '2026-01-03', 'DOUBLON', 5.00, 0.00,
      875.00, 'OTHER', true, '{}'::jsonb
    );
  EXCEPTION WHEN unique_violation THEN
    duplicate_line_rejected := true;
  END;

  IF NOT invalid_direction_rejected OR NOT duplicate_line_rejected THEN
    RAISE EXCEPTION 'Contraintes des lignes bancaires non appliquées';
  END IF;
END $$;

ROLLBACK;
