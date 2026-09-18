CREATE TABLE source_extractions (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES source_files(id) ON DELETE RESTRICT,
  method text NOT NULL CHECK (method IN ('PDF_TEXT', 'OCR', 'TABULAR')),
  method_version text NOT NULL CHECK (length(trim(method_version)) > 0),
  status text NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'NON_TRAITE', 'FAILED')),
  text_content text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, method, method_version),
  CHECK (
    (status = 'PENDING' AND text_content IS NULL AND failure_reason IS NULL)
    OR (status = 'SUCCEEDED' AND text_content IS NOT NULL
      AND length(trim(text_content)) > 0 AND failure_reason IS NULL)
    OR (status IN ('NON_TRAITE', 'FAILED') AND text_content IS NULL
      AND failure_reason IS NOT NULL AND length(trim(failure_reason)) > 0)
  )
);

CREATE INDEX source_extractions_source_status_idx
  ON source_extractions (source_id, status);
