BEGIN;

SELECT pg_advisory_xact_lock(2026091801);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 1) THEN
    RAISE EXCEPTION 'Migration 1 absente';
  END IF;
END $$;

SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE version = 2)
  THEN 'false' ELSE 'true' END AS apply_002
\gset

\if :apply_002
\ir migrations/002_extractions.sql
INSERT INTO schema_migrations (version) VALUES (2);
\endif

COMMIT;
