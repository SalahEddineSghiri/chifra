CREATE TABLE accounting_documents (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  consolidation_version text NOT NULL CHECK (length(trim(consolidation_version)) > 0),
  external_document_id text,
  kind text NOT NULL CHECK (kind IN ('INVOICE', 'CREDIT', 'UNDETERMINED')),
  status text NOT NULL CHECK (status IN ('READY', 'REVIEW_REQUIRED')),
  invoice_number text,
  supplier_name text,
  supplier_ice text,
  customer_ice text,
  issued_on date,
  account text,
  printed_vat_rate numeric(7, 4),
  amount_ht numeric(18, 2),
  vat_amount numeric(18, 2),
  amount_ttc numeric(18, 2),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX accounting_documents_batch_status_idx
  ON accounting_documents (batch_id, status, created_at, id);

CREATE TABLE accounting_document_sources (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES accounting_documents(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES source_files(id) ON DELETE RESTRICT,
  tabular_record_id uuid REFERENCES source_tabular_records(id) ON DELETE RESTRICT,
  relation_status text NOT NULL
    CHECK (relation_status IN ('PRIMARY', 'CONFIRMED', 'CONFLICT_CANDIDATE')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX accounting_document_sources_file_unique
  ON accounting_document_sources (source_id)
  WHERE tabular_record_id IS NULL;

CREATE UNIQUE INDEX accounting_document_sources_row_unique
  ON accounting_document_sources (tabular_record_id)
  WHERE tabular_record_id IS NOT NULL;

CREATE TABLE accounting_document_conflicts (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  document_id uuid NOT NULL REFERENCES accounting_documents(id) ON DELETE RESTRICT,
  tabular_record_id uuid REFERENCES source_tabular_records(id) ON DELETE RESTRICT,
  candidate_source_id uuid REFERENCES source_files(id) ON DELETE RESTRICT,
  field_name text NOT NULL CHECK (length(trim(field_name)) > 0),
  document_value text,
  tabular_value text,
  reason text NOT NULL CHECK (reason IN (
    'VALUE_MISMATCH', 'MISSING_COMPARABLE_VALUE',
    'SOURCE_WITHOUT_OBSERVATIONS', 'AMBIGUOUS_SOURCE_IDENTIFIER'
  )),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX accounting_document_conflicts_batch_status_idx
  ON accounting_document_conflicts (batch_id, status, created_at, id);
