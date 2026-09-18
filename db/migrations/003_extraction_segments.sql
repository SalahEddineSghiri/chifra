CREATE TABLE source_extraction_segments (
  id uuid PRIMARY KEY,
  extraction_id uuid NOT NULL REFERENCES source_extractions(id) ON DELETE RESTRICT,
  segment_index integer NOT NULL CHECK (segment_index > 0),
  page_number integer CHECK (page_number > 0),
  row_number integer CHECK (row_number > 0),
  text_content text NOT NULL CHECK (length(trim(text_content)) > 0),
  confidence_percent numeric(5,2)
    CHECK (confidence_percent BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (extraction_id, segment_index),
  CHECK (page_number IS NOT NULL OR row_number IS NOT NULL)
);
