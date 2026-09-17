BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batches (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'CLOSED', 'PROCESSING', 'COMPLETED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS source_files (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  content_sha256 text NOT NULL
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  original_filename text NOT NULL
    CHECK (length(trim(original_filename)) > 0),
  media_type text NOT NULL
    CHECK (length(trim(media_type)) > 0),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  storage_key text NOT NULL UNIQUE
    CHECK (length(trim(storage_key)) > 0),
  status text NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED', 'PROCESSING', 'DONE', 'NON_TRAITE', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, content_sha256)
);

CREATE INDEX IF NOT EXISTS source_files_batch_status_idx
  ON source_files (batch_id, status);

INSERT INTO schema_migrations (version) VALUES (1)
  ON CONFLICT (version) DO NOTHING;

COMMIT;
