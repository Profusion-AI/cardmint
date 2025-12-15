/**
 * Session Store - Manages operator session state for the frontend
 * Provides hooks for session management, event polling, and heartbeat tracking
 */

export type SessionStatus = "PREP" | "RUNNING" | "VALIDATING" | "CLOSED" | "ABORTED";
export type SessionPhase = "PREP" | "RUNNING" | "VALIDATING" | "CLOSED" | "ABORTED";
export type SessionEventLevel = "info" | "warning" | "error";

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
  source: string;
  message?: string;
  payload?: Record<string, any>;
}

export interface SessionState {
  session: OperatorSession | null;
  status: SessionStatus;
  phase: SessionPhase;
  heartbeat_stale: boolean;
  events: OperatorSessionEvent[];
  isLoading: boolean;
  error: string | null;
  lastEventTimestamp: number | null;
}

const API_BASE = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:4000";

export class SessionStore {
  private state: SessionState = {
    session: null,
    status: "PREP",
    phase: "PREP",
    heartbeat_stale: false,
    events: [],
    isLoading: false,
    error: null,
    lastEventTimestamp: null,
  };

  private listeners: Set<(state: SessionState) => void> = new Set();

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((listener) => listener(this.state));
  }

  getState(): SessionState {
    return { ...this.state };
  }

  /**
   * Load active session from server
   */
  async loadActiveSession(): Promise<void> {
    this.state.isLoading = true;
    this.notify();

    try {
      const response = await fetch(`${API_BASE}/api/operator-sessions/active`);
      if (!response.ok) throw new Error("Failed to load active session");

      const data = await response.json();
      this.state.session = data.session;
      this.state.status = data.status;
      this.state.phase = data.phase ?? "PREP";
      this.state.heartbeat_stale = data.heartbeat_stale ?? false;
      this.state.error = null;

      // If session exists, load initial events
      if (this.state.session?.id) {
        await this.loadEvents();
      }
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : "Failed to load session";
    } finally {
      this.state.isLoading = false;
      this.notify();
    }
  }

  /**
   * Start a new operator session
   * Clears previous session data (allowing operator to review old timeline first)
   * @param baseline - If true, starts a baseline session with relaxed Accept gates
   */
  async startSession(baseline?: boolean): Promise<OperatorSession | null> {
    this.state.isLoading = true;
    this.notify();

    try {
      const response = await fetch(`${API_BASE}/api/operator-sessions/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseline: baseline ?? false }),
      });

      if (response.status === 409) {
        throw new Error("Another session is already active");
      }

      if (!response.ok) throw new Error("Failed to start session");

      const data = await response.json();
      // Clear old session data when starting new session
      this.state.session = data.session;
      this.state.status = "RUNNING";
      this.state.phase = "RUNNING";
      this.state.heartbeat_stale = false;
      this.state.events = [];
      this.state.lastEventTimestamp = null;
      this.state.error = null;
      this.notify();

      return data.session;
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : "Failed to start session";
      this.notify();
      return null;
    } finally {
      this.state.isLoading = false;
    }
  }

  /**
   * End the active session
   * Transitions status to CLOSED (via VALIDATING on backend), preserves session/events for operator review
   */
  async endSession(): Promise<OperatorSession | null> {
    if (!this.state.session?.id) {
      this.state.error = "No active session";
      return null;
    }

    this.state.isLoading = true;
    this.notify();

    try {
      const response = await fetch(`${API_BASE}/api/operator-sessions/${this.state.session.id}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) throw new Error("Failed to end session");

      const data = await response.json();
      // Keep session data and events for operator review/audit
      // Use actual server status (CLOSED or VALIDATING) instead of reverting to PREP
      this.state.session = data.session;
      this.state.status = data.session.status as SessionStatus;
      this.state.phase = data.session.phase as SessionPhase;
      // Keep events and lastEventTimestamp for timeline review
      this.state.error = null;
      this.notify();

      return data.session;
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : "Failed to end session";
      this.notify();
      return null;
    } finally {
      this.state.isLoading = false;
    }
  }

  /**
   * Abort the active session (emergency stop)
   * Transitions status to ABORTED, preserves session/events for audit trail
   */
  async abortSession(reason?: string): Promise<OperatorSession | null> {
    if (!this.state.session?.id) {
      this.state.error = "No active session";
      return null;
    }

    this.state.isLoading = true;
    this.notify();

    try {
      const response = await fetch(`${API_BASE}/api/operator-sessions/${this.state.session.id}/abort`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });

      if (!response.ok) throw new Error("Failed to abort session");

      const data = await response.json();
      // Keep session data and events for audit trail
      // Use actual server status (ABORTED) instead of reverting to PREP
      this.state.session = data.session;
      this.state.status = data.session.status as SessionStatus;
      this.state.phase = data.session.phase as SessionPhase;
      // Keep events and lastEventTimestamp for abort reason tracking
      this.state.error = null;
      this.notify();

      return data.session;
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : "Failed to abort session";
      this.notify();
      return null;
    } finally {
      this.state.isLoading = false;
    }
  }

  /**
   * Update heartbeat for active session
   */
  async updateHeartbeat(): Promise<boolean> {
    if (!this.state.session?.id) return false;

    try {
      const response = await fetch(
        `${API_BASE}/api/operator-sessions/${this.state.session.id}/heartbeat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );

      if (!response.ok) return false;

      // Update local heartbeat state
      if (this.state.session) {
        this.state.session.heartbeat_at = Date.now();
        this.state.heartbeat_stale = false;
        this.notify();
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load or poll for new events since last timestamp
   */
  async loadEvents(): Promise<void> {
    if (!this.state.session?.id) return;

    try {
      const sinceParam = this.state.lastEventTimestamp
        ? `?since=${this.state.lastEventTimestamp}`
        : "";

      const response = await fetch(
        `${API_BASE}/api/operator-sessions/${this.state.session.id}/events${sinceParam}`
      );

      if (!response.ok) throw new Error("Failed to load events");

      const data = await response.json();
      const newEvents = data.events ?? [];

      // Merge with existing events (avoiding duplicates)
      const existingIds = new Set(this.state.events.map((e) => e.id));
      const mergedEvents = [
        ...newEvents.filter((e: OperatorSessionEvent) => !existingIds.has(e.id)),
        ...this.state.events,
      ];

      this.state.events = mergedEvents;
      if (newEvents.length > 0) {
        this.state.lastEventTimestamp = Math.max(
          ...newEvents.map((e: OperatorSessionEvent) => e.timestamp)
        );
      }

      this.notify();
    } catch {
      // Silent failure - will retry on next poll
    }
  }

  /**
   * Check heartbeat staleness (>90s)
   */
  checkHeartbeatDrift(): boolean {
    if (!this.state.session?.heartbeat_at) return false;

    const now = Date.now();
    const elapsed = now - this.state.session.heartbeat_at;
    const isStale = elapsed > 90000; // 90 seconds

    if (isStale && !this.state.heartbeat_stale) {
      this.state.heartbeat_stale = true;
      this.notify();
    } else if (!isStale && this.state.heartbeat_stale) {
      this.state.heartbeat_stale = false;
      this.notify();
    }

    return isStale;
  }

  /**
   * Clear all state
   */
  reset(): void {
    this.state = {
      session: null,
      status: "PREP",
      phase: "PREP",
      heartbeat_stale: false,
      events: [],
      isLoading: false,
      error: null,
      lastEventTimestamp: null,
    };
    this.notify();
  }

  /**
   * Get formatted elapsed time for session
   */
  getElapsedTime(): string | null {
    if (!this.state.session?.started_at) return null;

    const start = this.state.session.started_at;
    const end = this.state.session.ended_at ?? Date.now();
    const elapsed = end - start;

    const hours = Math.floor(elapsed / (1000 * 60 * 60));
    const minutes = Math.floor((elapsed % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((elapsed % (1000 * 60)) / 1000);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

// Singleton instance
let storeInstance: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (!storeInstance) {
    storeInstance = new SessionStore();
  }
  return storeInstance;
}
