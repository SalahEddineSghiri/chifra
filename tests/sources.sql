BEGIN;

DO $$
DECLARE
  duplicate_rejected boolean := false;
  orphan_rejected boolean := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 1) THEN
    RAISE EXCEPTION 'Migration 1 absente';
  END IF;

  INSERT INTO batches (id) VALUES ('00000000-0000-4000-8000-000000000001');
  INSERT INTO source_files (
    id, batch_id, content_sha256, original_filename,
    media_type, size_bytes, storage_key
  ) VALUES (
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    repeat('a', 64), 'DOC-001.pdf', 'application/pdf', 123,
    'test/source-1'
  );

  BEGIN
    INSERT INTO source_files (
      id, batch_id, content_sha256, original_filename,
      media_type, size_bytes, storage_key
    ) VALUES (
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000001',
      repeat('a', 64), 'copie.pdf', 'application/pdf', 123,
      'test/source-2'
    );
  EXCEPTION WHEN unique_violation THEN
    duplicate_rejected := true;
  END;

  BEGIN
    INSERT INTO source_files (
      id, batch_id, content_sha256, original_filename,
      media_type, size_bytes, storage_key
    ) VALUES (
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000099',
      repeat('b', 64), 'orphelin.pdf', 'application/pdf', 123,
      'test/source-3'
    );
  EXCEPTION WHEN foreign_key_violation THEN
    orphan_rejected := true;
  END;

  IF NOT duplicate_rejected OR NOT orphan_rejected THEN
    RAISE EXCEPTION 'Contrainte de source non appliquée';
  END IF;
END $$;

ROLLBACK;
