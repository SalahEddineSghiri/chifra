BEGIN;

DO $$
DECLARE
  test_batch uuid := gen_random_uuid();
  test_source uuid := gen_random_uuid();
  test_extraction uuid := gen_random_uuid();
  duplicate_rejected boolean := false;
  missing_location_rejected boolean := false;
  invalid_confidence_rejected boolean := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 3) THEN
    RAISE EXCEPTION 'Migration 3 absente';
  END IF;

  INSERT INTO batches (id) VALUES (test_batch);
  INSERT INTO source_files (
    id, batch_id, content_sha256, original_filename,
    media_type, size_bytes, storage_key
  ) VALUES (
    test_source, test_batch, repeat('d', 64), 'test.pdf',
    'application/pdf', 123, 'test/' || test_source::text
  );
  INSERT INTO source_extractions (
    id, source_id, method, method_version, status, text_content
  ) VALUES (
    test_extraction, test_source, 'PDF_TEXT', 'v1', 'SUCCEEDED', 'Texte extrait'
  );

  INSERT INTO source_extraction_segments (
    id, extraction_id, segment_index, page_number, text_content
  ) VALUES (
    gen_random_uuid(), test_extraction, 1, 1, 'Texte extrait'
  );

  BEGIN
    INSERT INTO source_extraction_segments (
      id, extraction_id, segment_index, row_number, text_content
    ) VALUES (
      gen_random_uuid(), test_extraction, 1, 2, 'Doublon'
    );
  EXCEPTION WHEN unique_violation THEN
    duplicate_rejected := true;
  END;

  BEGIN
    INSERT INTO source_extraction_segments (
      id, extraction_id, segment_index, text_content
    ) VALUES (
      gen_random_uuid(), test_extraction, 2, 'Sans position'
    );
  EXCEPTION WHEN check_violation THEN
    missing_location_rejected := true;
  END;

  BEGIN
    INSERT INTO source_extraction_segments (
      id, extraction_id, segment_index, page_number, text_content,
      confidence_percent
    ) VALUES (
      gen_random_uuid(), test_extraction, 3, 1, 'Confiance invalide', 101
    );
  EXCEPTION WHEN check_violation THEN
    invalid_confidence_rejected := true;
  END;

  IF NOT duplicate_rejected OR NOT missing_location_rejected
    OR NOT invalid_confidence_rejected THEN
    RAISE EXCEPTION 'Contraintes des segments non appliquées';
  END IF;

  IF (SELECT confidence_percent FROM source_extraction_segments
      WHERE extraction_id = test_extraction AND segment_index = 1) IS NOT NULL THEN
    RAISE EXCEPTION 'La confiance absente doit rester NULL';
  END IF;
END $$;

ROLLBACK;
