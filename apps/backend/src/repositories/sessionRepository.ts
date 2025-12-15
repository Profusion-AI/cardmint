import Database from "better-sqlite3";
import { OperatorSession, OperatorSessionEvent, SessionStatus, SessionPhase } from "../domain/session";

const serialize = (value: unknown) => JSON.stringify(value ?? null);
const deserialize = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    return fallback;
  }
};

const now = () => Date.now();

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Create a new operator session.
   * Enforces single RUNNING session constraint via transaction.
   */
  create(session: Omit<OperatorSession, "created_at" | "updated_at">): OperatorSession {
    const timestamp = now();

    // Transactional enforcement: check for existing RUNNING/VALIDATING session
    const existing = this.db
      .prepare(
        `SELECT id FROM operator_sessions WHERE status IN ('RUNNING', 'VALIDATING') LIMIT 1`
      )
      .get() as { id: string } | undefined;

    if (existing) {
      throw new Error(`Session conflict: active session ${existing.id} already running (409)`);
    }

    this.db
      .prepare(
        `INSERT INTO operator_sessions (
          id, started_at, ended_at, status, started_by, heartbeat_at, phase, notes,
          baseline, created_at, updated_at
        ) VALUES (@id, @started_at, @ended_at, @status, @started_by, @heartbeat_at,
          @phase, @notes, @baseline, @created_at, @updated_at)`
      )
      .run({
        id: session.id,
        started_at: session.started_at,
        ended_at: session.ended_at ?? null,
        status: session.status,
        started_by: session.started_by ?? null,
        heartbeat_at: session.heartbeat_at ?? null,
        phase: session.phase,
        notes: session.notes ?? null,
        baseline: session.baseline ?? 0,
        created_at: timestamp,
        updated_at: timestamp,
      });

    return {
      ...session,
      created_at: timestamp,
      updated_at: timestamp,
    };
  }

  /**
   * Get the currently active session (RUNNING or VALIDATING).
   */
  getActive(): OperatorSession | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM operator_sessions WHERE status IN ('RUNNING', 'VALIDATING') ORDER BY started_at DESC LIMIT 1`
      )
      .get() as any | undefined;

    return row ? this.mapRow(row) : undefined;
  }

  /**
   * Get a session by ID.
   */
  getById(id: string): OperatorSession | undefined {
    const row = this.db.prepare(`SELECT * FROM operator_sessions WHERE id = @id`).get({ id }) as
      | any
      | undefined;

    return row ? this.mapRow(row) : undefined;
  }

  /**
   * Update session status and phase.
   */
  updateStatus(id: string, status: SessionStatus, phase?: SessionPhase): void {
    const timestamp = now();
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Session ${id} not found`);
    }

    this.db
      .prepare(
        `UPDATE operator_sessions
         SET status = @status,
             phase = @phase,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        status,
        phase: phase ?? existing.phase,
        updated_at: timestamp,
      });
  }

  /**
   * Update session end time and status (for closure).
   */
  close(id: string, status: SessionStatus = "CLOSED"): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE operator_sessions
         SET status = @status,
             ended_at = @ended_at,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        status,
        ended_at: timestamp,
        updated_at: timestamp,
      });
  }

  /**
   * Update heartbeat timestamp.
   */
  updateHeartbeat(id: string): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE operator_sessions
         SET heartbeat_at = @heartbeat_at,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        heartbeat_at: timestamp,
        updated_at: timestamp,
      });
  }

  /**
   * Add an event to the session timeline.
   */
  addEvent(
    sessionId: string,
    source: string,
    level: string = "info",
    message?: string,
    payload?: Record<string, any>,
    phase?: SessionPhase
  ): OperatorSessionEvent {
    const timestamp = now();
    const result = this.db
      .prepare(
        `INSERT INTO operator_session_events (
          session_id, timestamp, phase, level, source, message, payload_json
        ) VALUES (@session_id, @timestamp, @phase, @level, @source, @message, @payload_json)`
      )
      .run({
        session_id: sessionId,
        timestamp,
        phase: phase ?? null,
        level,
        source,
        message: message ?? null,
        payload_json: serialize(payload ?? {}),
      });

    return {
      id: result.lastInsertRowid as number,
      session_id: sessionId,
      timestamp,
      phase,
      level: level as any,
      source: source as any,
      message,
      payload: payload ?? {},
    };
  }

  /**
   * Get events for a session since a given timestamp.
   */
  getEventsSince(sessionId: string, sinceTimestamp?: number): OperatorSessionEvent[] {
    const query = sinceTimestamp
      ? `SELECT * FROM operator_session_events WHERE session_id = @session_id AND timestamp > @since ORDER BY timestamp ASC`
      : `SELECT * FROM operator_session_events WHERE session_id = @session_id ORDER BY timestamp ASC`;

    const rows = this.db.prepare(query).all({
      session_id: sessionId,
      since: sinceTimestamp ?? 0,
    }) as any[];

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      timestamp: row.timestamp,
      phase: row.phase,
      level: row.level,
      source: row.source,
      message: row.message,
      payload: deserialize(row.payload_json, {}),
    }));
  }

  /**
   * Get all events for a session, newest first.
   */
  getAllEvents(sessionId: string): OperatorSessionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM operator_session_events WHERE session_id = @session_id ORDER BY timestamp DESC`
      )
      .all({ session_id: sessionId }) as any[];

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      timestamp: row.timestamp,
      phase: row.phase,
      level: row.level,
      source: row.source,
      message: row.message,
      payload: deserialize(row.payload_json, {}),
    }));
  }

  /**
   * Clear old sessions (closed >24h ago) for maintenance.
   */
  clearOldSessions(olderThanMs: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db
      .prepare(
        `DELETE FROM operator_sessions WHERE status IN ('CLOSED', 'ABORTED') AND ended_at < @cutoff`
      )
      .run({ cutoff });

    return result.changes;
  }

  /**
   * Update quota state for a session (stores as session event).
   */
  updateQuota(sessionId: string, quota: {
    tier: string;
    dailyLimit: number;
    dailyRemaining: number | null;
    callsConsumed: number | null;
    warningLevel: "ok" | "warning" | "critical";
  }): void {
    const level = quota.warningLevel === "critical" ? "error" : quota.warningLevel === "warning" ? "warning" : "info";
    const source = quota.warningLevel === "critical" ? "quota_exhausted" : quota.warningLevel === "warning" ? "quota_warning" : "quota_updated";

    this.addEvent(
      sessionId,
      source,
      level,
      `PPT quota ${quota.warningLevel}: ${quota.dailyRemaining ?? "unknown"} of ${quota.dailyLimit} remaining`,
      {
        tier: quota.tier,
        dailyLimit: quota.dailyLimit,
        dailyRemaining: quota.dailyRemaining,
        callsConsumed: quota.callsConsumed,
        warningLevel: quota.warningLevel,
        lastUpdated: Date.now(),
      }
    );
  }

  /**
   * Get the latest quota state for a session from events.
   */
  getQuotaState(sessionId: string): {
    tier: string;
    dailyLimit: number;
    dailyRemaining: number | null;
    callsConsumed: number | null;
    warningLevel: "ok" | "warning" | "critical";
    lastUpdated: number;
  } | null {
    const row = this.db
      .prepare(
        `SELECT payload_json FROM operator_session_events
         WHERE session_id = @session_id
           AND source IN ('quota_updated', 'quota_warning', 'quota_exhausted')
         ORDER BY timestamp DESC
         LIMIT 1`
      )
      .get({ session_id: sessionId }) as { payload_json: string } | undefined;

    if (!row) {
      return null;
    }

    return deserialize(row.payload_json, null);
  }

  private mapRow(row: any): OperatorSession {
    return {
      id: row.id,
      started_at: row.started_at,
      ended_at: row.ended_at,
      status: row.status,
      started_by: row.started_by,
      heartbeat_at: row.heartbeat_at,
      phase: row.phase,
      notes: row.notes,
      baseline: row.baseline,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
