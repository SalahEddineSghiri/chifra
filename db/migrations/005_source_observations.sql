CREATE TABLE source_observations (
  source_id uuid PRIMARY KEY REFERENCES source_files(id) ON DELETE RESTRICT,
  extraction_id uuid NOT NULL UNIQUE REFERENCES source_extractions(id) ON DELETE RESTRICT,
  parser_version text NOT NULL CHECK (length(trim(parser_version)) > 0),
  status text NOT NULL CHECK (status IN ('COMPLETE', 'PARTIAL')),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
