CREATE TABLE reconciliation_jobs (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  engine_version text NOT NULL CHECK (length(trim(engine_version)) > 0),
  status text NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (batch_id, engine_version),
  CHECK ((status = 'FAILED' AND failure_reason IS NOT NULL) OR status <> 'FAILED')
);

CREATE TABLE reconciliation_runs (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES reconciliation_jobs(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  engine_version text NOT NULL CHECK (length(trim(engine_version)) > 0),
  status text NOT NULL CHECK (status IN ('COMPLETED')),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  UNIQUE (batch_id, engine_version),
  CHECK ((is_current AND superseded_at IS NULL) OR (NOT is_current AND superseded_at IS NOT NULL))
);

CREATE UNIQUE INDEX reconciliation_runs_current_batch_unique
  ON reconciliation_runs (batch_id) WHERE is_current;

CREATE TABLE calculation_proofs (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  tool_name text NOT NULL CHECK (length(trim(tool_name)) > 0),
  tool_version text NOT NULL CHECK (length(trim(tool_version)) > 0),
  input_payload jsonb NOT NULL CHECK (jsonb_typeof(input_payload) = 'object'),
  output_payload jsonb NOT NULL CHECK (jsonb_typeof(output_payload) = 'object'),
  executed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_line_results (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  proof_id uuid NOT NULL REFERENCES calculation_proofs(id) ON DELETE RESTRICT,
  bank_line_id uuid NOT NULL REFERENCES bank_lines(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN (
    'FULLY_MATCHED', 'PARTIALLY_ALLOCATED', 'UNMATCHED',
    'REVIEW_REQUIRED', 'EXCLUDED', 'WAITING'
  )),
  supplier_name text,
  payment_amount_mad numeric(18, 2) NOT NULL CHECK (payment_amount_mad >= 0),
  allocated_amount_mad numeric(18, 2) NOT NULL CHECK (allocated_amount_mad >= 0),
  unallocated_amount_mad numeric(18, 2) NOT NULL CHECK (unallocated_amount_mad >= 0),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  candidate_document_ids uuid[] NOT NULL DEFAULT '{}',
  UNIQUE (run_id, bank_line_id),
  CHECK (payment_amount_mad = allocated_amount_mad + unallocated_amount_mad)
);

CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  proof_id uuid NOT NULL REFERENCES calculation_proofs(id) ON DELETE RESTRICT,
  bank_line_id uuid NOT NULL REFERENCES bank_lines(id) ON DELETE RESTRICT,
  document_id uuid NOT NULL REFERENCES accounting_documents(id) ON DELETE RESTRICT,
  amount_mad numeric(18, 2) NOT NULL CHECK (amount_mad > 0),
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, bank_line_id, document_id)
);

CREATE UNIQUE INDEX payment_allocations_current_line_document_unique
  ON payment_allocations (bank_line_id, document_id) WHERE is_current;

CREATE TABLE reconciliation_document_results (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  document_id uuid NOT NULL REFERENCES accounting_documents(id) ON DELETE RESTRICT,
  amount_ttc_mad numeric(18, 2),
  paid_amount_mad numeric(18, 2) NOT NULL CHECK (paid_amount_mad >= 0),
  residual_mad numeric(18, 2),
  status text NOT NULL CHECK (status IN ('MATCHED', 'PARTIAL', 'UNMATCHED', 'NOT_ELIGIBLE')),
  UNIQUE (run_id, document_id),
  CHECK (residual_mad IS NULL OR residual_mad >= 0),
  CHECK (amount_ttc_mad IS NULL OR residual_mad IS NULL OR amount_ttc_mad = paid_amount_mad + residual_mad)
);

CREATE INDEX reconciliation_line_results_run_status_idx
  ON reconciliation_line_results (run_id, status);

CREATE INDEX reconciliation_jobs_status_created_idx
  ON reconciliation_jobs (status, created_at, id);
