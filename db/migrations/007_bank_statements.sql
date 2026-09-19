CREATE TABLE bank_statements (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  original_filename text NOT NULL CHECK (length(trim(original_filename)) > 0),
  parser_version text NOT NULL CHECK (length(trim(parser_version)) > 0),
  raw_content text NOT NULL CHECK (length(raw_content) > 0),
  row_count integer NOT NULL CHECK (row_count > 0 AND row_count <= 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, content_sha256)
);

CREATE TABLE bank_lines (
  id uuid PRIMARY KEY,
  statement_id uuid NOT NULL REFERENCES bank_statements(id) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number > 1),
  booked_on date NOT NULL,
  label text NOT NULL CHECK (length(trim(label)) > 0),
  debit_mad numeric(18, 2) NOT NULL CHECK (debit_mad >= 0),
  credit_mad numeric(18, 2) NOT NULL CHECK (credit_mad >= 0),
  balance_mad numeric(18, 2) NOT NULL,
  classification text NOT NULL CHECK (classification IN (
    'PURCHASE_CANDIDATE', 'SALARY', 'BANK_FEE', 'CLIENT_RECEIPT', 'OTHER'
  )),
  balance_consistent boolean,
  raw_values jsonb NOT NULL CHECK (jsonb_typeof(raw_values) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (statement_id, line_number),
  CHECK ((debit_mad > 0 AND credit_mad = 0) OR (credit_mad > 0 AND debit_mad = 0))
);

CREATE INDEX bank_statements_batch_created_idx
  ON bank_statements (batch_id, created_at, id);

CREATE INDEX bank_lines_statement_date_idx
  ON bank_lines (statement_id, booked_on, line_number);
