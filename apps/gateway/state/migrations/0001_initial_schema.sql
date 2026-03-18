CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  last_thread_activity_at TIMESTAMPTZ NOT NULL,
  idle_deadline_at TIMESTAMPTZ,
  closed_reason TEXT,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::JSONB,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  responder_id TEXT
);

CREATE TABLE IF NOT EXISTS session_path_permissions (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  path TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (session_id, operation, path)
);

CREATE TABLE IF NOT EXISTS session_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  snapshot_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memory_entries (
  memory_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  "key" TEXT NOT NULL,
  value_json JSONB NOT NULL,
  tags_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, namespace, "key")
);

CREATE TABLE IF NOT EXISTS audit_logs (
  log_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  raw JSONB NOT NULL DEFAULT '{}'::JSONB,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_status_updated_at
  ON sessions (user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_session_status_updated_at
  ON tasks (session_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_approvals_session_status_requested_at
  ON approvals (session_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_events_task_timestamp
  ON task_events (task_id, "timestamp");

CREATE INDEX IF NOT EXISTS idx_session_path_permissions_lookup
  ON session_path_permissions (session_id, operation, path);

CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation_timestamp
  ON audit_logs (correlation_id, "timestamp");
