import React, { useState, useMemo } from "react";
import { useSessionEvents, useSession } from "../hooks/useSession";
import type { OperatorSessionEvent, SessionEventLevel } from "../stores/sessionStore";

type LevelFilter = "all" | "info" | "warning" | "error";

/**
 * SessionTimeline - Terminal-style event feed with filtering
 * Shows latest events first, color-coded by level
 */
export const SessionTimeline: React.FC = () => {
  const events = useSessionEvents();
  const session = useSession();
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");

  const levelColors: Record<SessionEventLevel, string> = {
    info: "#3b82f6", // blue
    warning: "#f59e0b", // amber
    error: "#ef4444", // red
  };

  const filteredEvents = useMemo(() => {
    let filtered = events;
    if (levelFilter !== "all") {
      filtered = filtered.filter((e) => e.level === levelFilter);
    }
    return filtered;
  }, [events, levelFilter]);

  if (!session.session?.id) {
    return (
      <div style={{ padding: 20, textAlign: "center", color: "var(--muted)" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>No session active</div>
        <div style={{ fontSize: 12 }}>Start a session to view the event timeline</div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr",
        gap: 12,
        height: "100%",
        padding: 12,
      }}
    >
      {/* Filter Chips */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {(["all", "info", "warning", "error"] as LevelFilter[]).map((level) => (
          <button
            key={level}
            onClick={() => setLevelFilter(level)}
            style={{
              padding: "4px 8px",
              fontSize: 11,
              fontWeight: 600,
              border: `1px solid ${levelFilter === level ? "var(--accent)" : "var(--border)"}`,
              background:
                levelFilter === level ? "var(--accent)22" : "transparent",
              color: levelFilter === level ? "var(--accent)" : "var(--text)",
              cursor: "pointer",
              borderRadius: 4,
              transition: "all 0.2s",
            }}
          >
            {level.charAt(0).toUpperCase() + level.slice(1)}
          </button>
        ))}
      </div>

      {/* Session Info Banner */}
      {session.session && (
        <div
          style={{
            padding: 8,
            fontSize: 11,
            color: "var(--muted)",
            borderLeft: `2px solid ${
              session.status === "RUNNING"
                ? "#22c55e"
                : session.status === "VALIDATING"
                ? "#3b82f6"
                : "#6b7280"
            }`,
            paddingLeft: 8,
          }}
        >
          <strong>Session {session.status}</strong>
          {session.phase && ` — Phase: ${session.phase}`}
          {session.getElapsedTime() && ` — Elapsed: ${session.getElapsedTime()}`}
        </div>
      )}

      {/* Events Feed (newest first) */}
      <div
        style={{
          overflowY: "auto",
          display: "grid",
          gap: 4,
          alignContent: "start",
          fontFamily: "var(--mono)",
          fontSize: 11,
        }}
      >
        {filteredEvents.length === 0 ? (
          <div style={{ padding: 12, color: "var(--muted)", textAlign: "center" }}>
            {events.length === 0
              ? "Session timeline empty — awaiting first event"
              : "No events match the selected filter"}
          </div>
        ) : (
          filteredEvents.map((event) => (
            <EventRow key={event.id} event={event} levelColors={levelColors} />
          ))
        )}
      </div>
    </div>
  );
};

interface EventRowProps {
  event: OperatorSessionEvent;
  levelColors: Record<SessionEventLevel, string>;
}

const EventRow: React.FC<EventRowProps> = ({ event, levelColors }) => {
  const time = new Date(event.timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const color = levelColors[event.level];

  return (
    <div
      style={{
        padding: 8,
        background: `${color}08`,
        borderLeft: `2px solid ${color}`,
        borderRadius: 2,
        display: "grid",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <span style={{ color: "var(--muted)", minWidth: 60 }}>{time}</span>
        <span style={{ color, fontWeight: 600, minWidth: 90 }}>{event.source}</span>
        <span style={{ color: "var(--text)" }}>{event.message ?? ""}</span>
      </div>

      {/* Event payload details (if present) */}
      {event.payload && Object.keys(event.payload).length > 0 && (
        <div
          style={{
            paddingLeft: 68,
            fontSize: 10,
            color: "var(--muted)",
            fontFamily: "var(--mono)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {JSON.stringify(event.payload, null, 2)}
        </div>
      )}
    </div>
  );
};

export default SessionTimeline;
