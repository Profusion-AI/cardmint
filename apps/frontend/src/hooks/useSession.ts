import { useEffect, useState, useRef } from "react";
import { getSessionStore, SessionState } from "../stores/sessionStore";

/**
 * Hook to access and interact with operator session state
 */
export function useSession() {
  const store = getSessionStore();
  const [state, setState] = useState<SessionState>(store.getState());
  const heartbeatIntervalRef = useRef<number | null>(null);
  const pollIntervalRef = useRef<number | null>(null);

  // Subscribe to store updates
  useEffect(() => {
    const unsubscribe = store.subscribe(setState);
    return unsubscribe;
  }, [store]);

  // Load initial session state
  useEffect(() => {
    void store.loadActiveSession();
  }, [store]);

  // Set up heartbeat polling (30s) and event polling (5s) when session is RUNNING
  useEffect(() => {
    if (state.session?.id && (state.status === "RUNNING" || state.status === "VALIDATING")) {
      // Heartbeat every 30 seconds
      heartbeatIntervalRef.current = window.setInterval(() => {
        void store.updateHeartbeat();
      }, 30000);

      // Event poll every 5 seconds
      pollIntervalRef.current = window.setInterval(() => {
        void store.loadEvents();
        store.checkHeartbeatDrift();
      }, 5000);

      // Initial heartbeat update
      void store.updateHeartbeat();
    }

    return () => {
      if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [state.session?.id, state.status, store]);

  // Periodically check heartbeat drift even when not running
  useEffect(() => {
    const driftCheckInterval = window.setInterval(() => {
      store.checkHeartbeatDrift();
    }, 10000);

    return () => clearInterval(driftCheckInterval);
  }, [store]);

  return {
    ...state,
    startSession: (baseline?: boolean) => store.startSession(baseline),
    startBaselineSession: () => store.startSession(true),
    endSession: () => store.endSession(),
    abortSession: (reason?: string) => store.abortSession(reason),
    getElapsedTime: () => store.getElapsedTime(),
    isBaseline: state.session?.baseline === 1,
  };
}

/**
 * Hook to get just the session events
 */
export function useSessionEvents() {
  const session = useSession();
  return session.events;
}

/**
 * Hook to get session status with readable label
 */
export function useSessionStatus() {
  const session = useSession();

  const statusColor = {
    PREP: "#94a3b8", // gray
    RUNNING: "#22c55e", // green
    VALIDATING: "#3b82f6", // blue
    CLOSED: "#6b7280", // slate
    ABORTED: "#ef4444", // red
  }[session.status];

  const statusLabel = session.status.replace(/_/g, " ");

  return {
    status: session.status,
    phase: session.phase,
    statusColor,
    statusLabel,
    heartbeat_stale: session.heartbeat_stale,
  };
}
