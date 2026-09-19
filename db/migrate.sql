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

SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE version = 3)
  THEN 'false' ELSE 'true' END AS apply_003
\gset

\if :apply_003
\ir migrations/003_extraction_segments.sql
INSERT INTO schema_migrations (version) VALUES (3);
\endif

SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE version = 4)
  THEN 'false' ELSE 'true' END AS apply_004
\gset

\if :apply_004
\ir migrations/004_batch_names.sql
INSERT INTO schema_migrations (version) VALUES (4);
\endif

SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE version = 5)
  THEN 'false' ELSE 'true' END AS apply_005
\gset

\if :apply_005
\ir migrations/005_source_observations.sql
INSERT INTO schema_migrations (version) VALUES (5);
\endif

SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE version = 6)
  THEN 'false' ELSE 'true' END AS apply_006
\gset

\if :apply_006
\ir migrations/006_ocr_provenance.sql
INSERT INTO schema_migrations (version) VALUES (6);
\endif

SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE version = 7)
  THEN 'false' ELSE 'true' END AS apply_007
\gset

\if :apply_007
\ir migrations/007_bank_statements.sql
INSERT INTO schema_migrations (version) VALUES (7);
\endif

SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE version = 8)
  THEN 'false' ELSE 'true' END AS apply_008
\gset

\if :apply_008
\ir migrations/008_tabular_records.sql
INSERT INTO schema_migrations (version) VALUES (8);
\endif

SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE version = 9)
  THEN 'false' ELSE 'true' END AS apply_009
\gset

\if :apply_009
\ir migrations/009_accounting_documents.sql
INSERT INTO schema_migrations (version) VALUES (9);
\endif

SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE version = 10)
  THEN 'false' ELSE 'true' END AS apply_010
\gset

\if :apply_010
\ir migrations/010_reconciliation.sql
INSERT INTO schema_migrations (version) VALUES (10);
\endif

SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE version = 11)
  THEN 'false' ELSE 'true' END AS apply_011
\gset

\if :apply_011
\ir migrations/011_document_audit.sql
INSERT INTO schema_migrations (version) VALUES (11);
\endif

COMMIT;
