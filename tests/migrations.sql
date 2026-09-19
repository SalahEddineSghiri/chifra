BEGIN;

DO $$
DECLARE
  test_batch uuid := gen_random_uuid();
  test_source uuid := gen_random_uuid();
  duplicate_rejected boolean := false;
  empty_success_rejected boolean := false;
  missing_reason_rejected boolean := false;
BEGIN
  IF (SELECT count(*) FROM schema_migrations WHERE version BETWEEN 1 AND 12) <> 12 THEN
    RAISE EXCEPTION 'Migrations 1 à 12 attendues';
  END IF;

  IF to_regclass('public.reconciliation_runs') IS NULL
     OR to_regclass('public.reconciliation_jobs') IS NULL
     OR to_regclass('public.calculation_proofs') IS NULL
     OR to_regclass('public.payment_allocations') IS NULL THEN
    RAISE EXCEPTION 'Tables de rapprochement absentes';
  END IF;

  IF to_regclass('public.audit_jobs') IS NULL
     OR to_regclass('public.audit_runs') IS NULL
     OR to_regclass('public.document_audit_results') IS NULL THEN
    RAISE EXCEPTION 'Tables d audit absentes';
  END IF;

  IF to_regclass('public.agent_runs') IS NULL
     OR to_regclass('public.agent_events') IS NULL
     OR to_regclass('public.agent_checkpoints') IS NULL
     OR to_regclass('public.llm_response_cache') IS NULL THEN
    RAISE EXCEPTION 'Tables agentiques absentes';
  END IF;

  INSERT INTO batches (id) VALUES (test_batch);
  INSERT INTO source_files (
    id, batch_id, content_sha256, original_filename,
    media_type, size_bytes, storage_key
  ) VALUES (
    test_source, test_batch, repeat('c', 64), 'test.pdf',
    'application/pdf', 123, 'test/' || test_source::text
  );

  INSERT INTO source_extractions (id, source_id, method, method_version, status)
  VALUES (gen_random_uuid(), test_source, 'PDF_TEXT', 'v1', 'PENDING');

  BEGIN
    INSERT INTO source_extractions (id, source_id, method, method_version, status)
    VALUES (gen_random_uuid(), test_source, 'PDF_TEXT', 'v1', 'PENDING');
  EXCEPTION WHEN unique_violation THEN
    duplicate_rejected := true;
  END;

  BEGIN
    INSERT INTO source_extractions (id, source_id, method, method_version, status)
    VALUES (gen_random_uuid(), test_source, 'OCR', 'v1', 'SUCCEEDED');
  EXCEPTION WHEN check_violation THEN
    empty_success_rejected := true;
  END;

  BEGIN
    INSERT INTO source_extractions (id, source_id, method, method_version, status)
    VALUES (gen_random_uuid(), test_source, 'TABULAR', 'v1', 'NON_TRAITE');
  EXCEPTION WHEN check_violation THEN
    missing_reason_rejected := true;
  END;

  INSERT INTO source_extractions (
    id, source_id, method, method_version, status, text_content
  ) VALUES (
    gen_random_uuid(), test_source, 'OCR', 'v1', 'SUCCEEDED', 'Texte extrait'
  );

  INSERT INTO source_extractions (
    id, source_id, method, method_version, status, failure_reason
  ) VALUES (
    gen_random_uuid(), test_source, 'TABULAR', 'v1', 'NON_TRAITE', 'Format non pris en charge'
  );

  IF NOT duplicate_rejected OR NOT empty_success_rejected OR NOT missing_reason_rejected THEN
    RAISE EXCEPTION 'Contraintes d extraction non appliquées';
  END IF;
END $$;

DO $$
DECLARE
  test_source uuid;
  test_extraction uuid;
  missing_status_reason_rejected boolean := false;
BEGIN
  SELECT id INTO test_source FROM source_files WHERE content_sha256 = repeat('c', 64);
  SELECT id INTO test_extraction
    FROM source_extractions
   WHERE source_id = test_source AND status = 'SUCCEEDED'
   LIMIT 1;

  INSERT INTO source_observations (
    source_id, extraction_id, parser_version, status, fields
  ) VALUES (
    test_source, test_extraction, 'test-v1', 'PARTIAL', '{}'::jsonb
  );
  INSERT INTO source_observation_inputs (source_id, extraction_id)
  VALUES (test_source, test_extraction);

  IF (SELECT count(*) FROM source_observation_inputs WHERE source_id = test_source) <> 1 THEN
    RAISE EXCEPTION 'Provenance des observations absente';
  END IF;

  BEGIN
    UPDATE source_files SET status = 'NON_TRAITE' WHERE id = test_source;
  EXCEPTION WHEN check_violation THEN
    missing_status_reason_rejected := true;
  END;
  IF NOT missing_status_reason_rejected THEN
    RAISE EXCEPTION 'Motif terminal obligatoire non appliqué';
  END IF;
END $$;

DO $$
DECLARE
  test_source uuid;
  test_extraction uuid;
  test_record uuid := gen_random_uuid();
  test_document uuid := gen_random_uuid();
BEGIN
  SELECT id INTO test_source FROM source_files WHERE content_sha256 = repeat('c', 64);
  INSERT INTO source_extractions (
    id, source_id, method, method_version, status, text_content
  ) VALUES (
    gen_random_uuid(), test_source, 'TABULAR', 'xlsx-test-v1', 'SUCCEEDED', '[{}]'
  ) RETURNING id INTO test_extraction;

  INSERT INTO source_tabular_records (
    id, source_id, extraction_id, row_number, external_document_id, status, fields
  ) VALUES (
    test_record, test_source, test_extraction, 2, 'TST-001', 'COMPLETE', '{}'::jsonb
  );
  IF (SELECT count(*) FROM source_tabular_records WHERE source_id = test_source) <> 1 THEN
    RAISE EXCEPTION 'Ligne XLSX non persistée';
  END IF;

  INSERT INTO accounting_documents (
    id, batch_id, consolidation_version, external_document_id, kind, status,
    invoice_number, supplier_name, issued_on, amount_ht, vat_amount, amount_ttc
  ) SELECT test_document, batch_id, 'test-v1', 'TST-001', 'INVOICE', 'READY',
           'FT-001', 'FOURNISSEUR TEST', DATE '2026-04-01', 1000.00, 200.00, 1200.00
      FROM source_files WHERE id = test_source;
  INSERT INTO accounting_document_sources (
    id, document_id, source_id, tabular_record_id, relation_status
  ) VALUES (
    gen_random_uuid(), test_document, test_source, test_record, 'PRIMARY'
  );
  INSERT INTO accounting_document_conflicts (
    id, batch_id, document_id, tabular_record_id, candidate_source_id,
    field_name, document_value, tabular_value, reason
  ) SELECT gen_random_uuid(), batch_id, test_document, test_record, test_source,
           'amountTtc', '1200.00', '1210.00', 'VALUE_MISMATCH'
      FROM source_files WHERE id = test_source;
  IF (SELECT amount_ttc FROM accounting_documents WHERE id = test_document) <> 1200.00 THEN
    RAISE EXCEPTION 'Montant numeric de la pièce métier invalide';
  END IF;
END $$;

ROLLBACK;
