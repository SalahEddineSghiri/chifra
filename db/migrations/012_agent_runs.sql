CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  graph_version text NOT NULL CHECK (length(trim(graph_version)) > 0),
  status text NOT NULL CHECK (status IN (
    'PENDING', 'PROCESSING', 'WAITING_HUMAN', 'COMPLETED', 'FAILED'
  )),
  current_step text,
  failure_reason text,
  plan jsonb,
  explanation jsonb,
  requires_human boolean NOT NULL DEFAULT false,
  human_reasons jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(human_reasons) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (batch_id, graph_version),
  CHECK ((status = 'FAILED' AND failure_reason IS NOT NULL) OR status <> 'FAILED')
);

CREATE TABLE agent_events (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence > 0),
  role text NOT NULL CHECK (role IN (
    'ORCHESTRATOR', 'INGESTOR', 'RECONCILER', 'AUDITOR', 'EXPLAINER', 'RUNTIME'
  )),
  event_type text NOT NULL CHECK (event_type IN (
    'TOOL_EXECUTED', 'LLM_CALLED', 'CACHE_HIT', 'TRANSITION', 'ERROR'
  )),
  task text NOT NULL CHECK (length(trim(task)) > 0),
  model text,
  selection_reason text,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  token_usage jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE TABLE agent_checkpoints (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  step text NOT NULL CHECK (length(trim(step)) > 0),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step)
);

CREATE TABLE llm_response_cache (
  cache_key text PRIMARY KEY CHECK (length(cache_key) = 64),
  task text NOT NULL CHECK (length(trim(task)) > 0),
  model text NOT NULL CHECK (length(trim(model)) > 0),
  prompt_version text NOT NULL CHECK (length(trim(prompt_version)) > 0),
  schema_version text NOT NULL CHECK (length(trim(schema_version)) > 0),
  output_payload jsonb NOT NULL CHECK (jsonb_typeof(output_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_runs_status_created_idx ON agent_runs (status, created_at, id);
CREATE INDEX agent_events_run_sequence_idx ON agent_events (run_id, sequence);
