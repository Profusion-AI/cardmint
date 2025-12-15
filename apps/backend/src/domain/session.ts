export type SessionStatus = "PREP" | "RUNNING" | "VALIDATING" | "CLOSED" | "ABORTED";
export type SessionPhase = "PREP" | "RUNNING" | "VALIDATING" | "CLOSED" | "ABORTED";
export type SessionEventLevel = "info" | "warning" | "error";
export type SessionEventSource =
  | "session_start"
  | "session_end"
  | "session_abort"
  | "capture_triggered"
  | "placeholder_attached"
  | "job_preview_ready"
  | "job_image_processed"
  | "job_status_changed"
  | "queue_cleared"
  | "gate_b_check"
  | "incident_logged"
  | "job_accepted"
  | "job_flagged"
  | "variant_drawer_opened"
  | "variant_drawer_closed"
  | "variant_filter_toggled"
  | "quota_updated"
  | "quota_warning"
  | "quota_exhausted"
  | "manual_override_committed"
  | "canonicalize_scan"
  | "rescan_triggered"
  | "baseline_finalized";

export interface OperatorSession {
  id: string;
  started_at: number;
  ended_at?: number;
  status: SessionStatus;
  started_by?: string;
  heartbeat_at?: number;
  phase: SessionPhase;
  notes?: string;
  baseline?: number;
  created_at: number;
  updated_at: number;
}

export interface OperatorSessionEvent {
  id: number;
  session_id: string;
  timestamp: number;
  phase?: SessionPhase;
  level: SessionEventLevel;
  source: SessionEventSource;
  message?: string;
  payload?: Record<string, any>;
}

export interface QuotaMetadata {
  tier: string;
  dailyLimit: number;
  dailyRemaining: number | null;
  minuteRemaining: number | null;
  callsConsumed: number | null;
  warningLevel: "ok" | "warning" | "critical";
  lastUpdated: number;
}
