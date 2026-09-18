BEGIN;

DO $$
DECLARE
  test_batch uuid := gen_random_uuid();
  test_source uuid := gen_random_uuid();
  duplicate_rejected boolean := false;
  empty_success_rejected boolean := false;
  missing_reason_rejected boolean := false;
BEGIN
  IF (SELECT count(*) FROM schema_migrations WHERE version IN (1, 2)) <> 2 THEN
    RAISE EXCEPTION 'Migrations 1 et 2 attendues';
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

ROLLBACK;
