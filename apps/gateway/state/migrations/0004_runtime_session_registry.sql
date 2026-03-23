CREATE TABLE IF NOT EXISTS runtime_sessions (
  session_id TEXT PRIMARY KEY,
  sdk_session_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_runtime_sessions_updated_at
  ON runtime_sessions (updated_at DESC);

CREATE TABLE IF NOT EXISTS runtime_task_snapshots (
  task_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'canceled')),
  bootstrap_mode TEXT NOT NULL CHECK (bootstrap_mode IN ('create', 'resume')),
  send_and_wait_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  result_json JSONB,
  tool_events_json JSONB,
  error_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_runtime_task_snapshots_session_id
  ON runtime_task_snapshots (session_id, updated_at DESC);
