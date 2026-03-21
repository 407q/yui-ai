CREATE TABLE IF NOT EXISTS memory_links (
  source_memory_id TEXT NOT NULL REFERENCES memory_entries(memory_id) ON DELETE CASCADE,
  source_user_id TEXT NOT NULL,
  source_namespace TEXT NOT NULL,
  source_key TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  target_namespace TEXT NOT NULL,
  target_key TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'related',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (
    source_user_id,
    source_namespace,
    source_key,
    target_user_id,
    target_namespace,
    target_key,
    relation
  )
);

CREATE INDEX IF NOT EXISTS idx_memory_links_target_lookup
  ON memory_links (target_user_id, target_namespace, target_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_links_source_lookup
  ON memory_links (source_user_id, source_namespace, source_key, created_at DESC);
