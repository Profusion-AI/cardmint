-- Phase 5: Print agent heartbeat for 24/7 ops visibility
-- Stores the last-seen timestamp from the local Fedora print agent.

CREATE TABLE IF NOT EXISTS print_agent_heartbeats (
  agent_id TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL,
  hostname TEXT,
  version TEXT,
  printer_name TEXT,
  auto_print INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_print_agent_heartbeats_last_seen
  ON print_agent_heartbeats(last_seen_at);

