CREATE TABLE audit_jobs (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  engine_version text NOT NULL CHECK (length(trim(engine_version)) > 0),
  reference_version text NOT NULL CHECK (length(trim(reference_version)) > 0),
  status text NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (batch_id, engine_version, reference_version),
  CHECK ((status = 'FAILED' AND failure_reason IS NOT NULL) OR status <> 'FAILED')
);

CREATE TABLE audit_runs (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES audit_jobs(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  engine_version text NOT NULL CHECK (length(trim(engine_version)) > 0),
  rules_version text NOT NULL CHECK (length(trim(rules_version)) > 0),
  reference_version text NOT NULL CHECK (length(trim(reference_version)) > 0),
  reference_hashes jsonb NOT NULL CHECK (jsonb_typeof(reference_hashes) = 'object'),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  input_payload jsonb NOT NULL CHECK (jsonb_typeof(input_payload) = 'object'),
  output_payload jsonb NOT NULL CHECK (jsonb_typeof(output_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, engine_version, reference_version)
);

CREATE TABLE document_audit_results (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES audit_runs(id) ON DELETE RESTRICT,
  document_id uuid NOT NULL REFERENCES accounting_documents(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('PASS', 'ANOMALY', 'NOT_EVALUABLE')),
  supplier_reference jsonb,
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  UNIQUE (run_id, document_id)
);

CREATE INDEX audit_jobs_status_created_idx ON audit_jobs (status, created_at, id);
CREATE INDEX document_audit_results_run_status_idx ON document_audit_results (run_id, status);
