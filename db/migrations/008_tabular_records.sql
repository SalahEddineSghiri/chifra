CREATE TABLE source_tabular_records (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES source_files(id) ON DELETE RESTRICT,
  extraction_id uuid NOT NULL REFERENCES source_extractions(id) ON DELETE RESTRICT,
  row_number integer NOT NULL CHECK (row_number > 1),
  external_document_id text,
  status text NOT NULL CHECK (status IN ('COMPLETE', 'PARTIAL')),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, row_number)
);

CREATE INDEX source_tabular_records_external_id_idx
  ON source_tabular_records (external_document_id)
  WHERE external_document_id IS NOT NULL;
