-- Operator session management (Oct 21, 2025)
-- Enables single-source-of-truth session state and structured event logging for operator workflows

PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;

-- Core operator session table
CREATE TABLE IF NOT EXISTS operator_sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'PREP',
  -- Status values: PREP, RUNNING, VALIDATING, CLOSED, ABORTED
  started_by TEXT,
  heartbeat_at INTEGER,
  phase TEXT DEFAULT 'PREP',
  -- Phase values: PREP (Phase 0), RUNNING (Phases 1-2), VALIDATING (Phase 3), CLOSED (Phase 4), ABORTED
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Session event log: structured timeline of all SOP actions
CREATE TABLE IF NOT EXISTS operator_session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  phase TEXT,
  -- Event level: info, warning, error
  level TEXT NOT NULL DEFAULT 'info',
  -- Event source: session_start, session_end, session_abort, capture_triggered,
  -- placeholder_attached, job_status_changed, queue_cleared, gate_b_check, incident_logged
  source TEXT NOT NULL,
  message TEXT,
  -- JSON payload for structured data (count, jobId, exitCode, etc.)
  payload_json TEXT DEFAULT '{}',
  FOREIGN KEY (session_id) REFERENCES operator_sessions(id) ON DELETE CASCADE
);

-- Enforce single RUNNING session constraint via migration check
-- (Runtime code will enforce with transaction isolation and 409 conflict on duplicate RUNNING)

CREATE INDEX IF NOT EXISTS idx_operator_sessions_status ON operator_sessions(status);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_phase ON operator_sessions(phase);
CREATE INDEX IF NOT EXISTS idx_operator_session_events_session_id ON operator_session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_operator_session_events_timestamp ON operator_session_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_operator_session_events_level ON operator_session_events(level);
