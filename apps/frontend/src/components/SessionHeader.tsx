import React, { useEffect, useState } from "react";
import { useSession, useSessionStatus } from "../hooks/useSession";
import { finalizeBaseline, fetchSessionSummary, fetchMetrics, type BaselineSummary } from "../api/client";
import BaselineSummaryPanel from "./BaselineSummaryPanel";
import CalibrationModal from "./CalibrationModal";

/**
 * SessionHeader - Displays session state toggle, timer, and status pills
 * Replaces simple connectivity status with full session lifecycle display
 */
export const SessionHeader: React.FC<{
  backCaptureDelayMs?: number;
  onBackCaptureDelayChange?: (ms: number) => void;
}> = ({ backCaptureDelayMs = 3500, onBackCaptureDelayChange }) => {
  const session = useSession();
  const { status, statusColor, statusLabel, heartbeat_stale } = useSessionStatus();
  const [elapsedTime, setElapsedTime] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isFinalizeConfirming, setIsFinalizeConfirming] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [summary, setSummary] = useState<BaselineSummary | null>(null);
  const [finalizePreCheck, setFinalizePreCheck] = useState<{ total: number; unmatched: number } | null>(null);
  const [showCalibration, setShowCalibration] = useState(false);
  const [canonicalHitRate, setCanonicalHitRate] = useState<number | null>(null);
  const [baselineCount, setBaselineCount] = useState<number>(0);
  const BASELINE_TARGET = 25;

  // Fetch baseline count periodically when in baseline mode
  useEffect(() => {
    if (!session.isBaseline || (status !== "RUNNING" && status !== "VALIDATING")) {
      setBaselineCount(0);
      return;
    }
    const fetchCount = async () => {
      if (!session.session?.id) return;
      try {
        const summaryData = await fetchSessionSummary(session.session.id);
        setBaselineCount(summaryData.accepted_count ?? 0);
      } catch {
        // Silently ignore fetch errors
      }
    };
    fetchCount();
    const interval = setInterval(fetchCount, 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, [session.isBaseline, status, session.session?.id]);

  // Fetch canonical hit rate periodically when session is active
  useEffect(() => {
    if (status !== "RUNNING" && status !== "VALIDATING") {
      setCanonicalHitRate(null);
      return;
    }
    const fetchHitRate = async () => {
      try {
        const metrics = await fetchMetrics();
        if (metrics.canonical_retrieval) {
          setCanonicalHitRate(metrics.canonical_retrieval.hit_rate_percent);
        }
      } catch {
        // Silently ignore metric fetch errors
      }
    };
    fetchHitRate();
    const interval = setInterval(fetchHitRate, 30000); // Every 30 seconds
    return () => clearInterval(interval);
  }, [status]);

  // Update elapsed time every second
  // Important: depend only on stable primitives to avoid re-running each render
  useEffect(() => {
    if (status === "RUNNING" || status === "VALIDATING") {
      const update = () => setElapsedTime(session.getElapsedTime());
      update();
      const interval = setInterval(update, 1000);
      return () => clearInterval(interval);
    } else {
      setElapsedTime(null);
    }
    // Re-run when status or active session id changes
  }, [status, session.session?.id]);

  const handleToggle = async () => {
    if (status === "PREP" || status === "CLOSED" || status === "ABORTED") {
      // Start session (or restart after closed/aborted)
      await session.startSession(false);
    } else if (status === "RUNNING") {
      // End session (show confirmation modal)
      setIsConfirming(true);
    }
    // VALIDATING: checkbox disabled, no action possible
  };

  const handleStartBaseline = async () => {
    if (status === "PREP" || status === "CLOSED" || status === "ABORTED") {
      await session.startBaselineSession();
    }
  };

  const handleConfirmEnd = async () => {
    await session.endSession();
    setIsConfirming(false);
  };

  const handleCancelEnd = () => {
    setIsConfirming(false);
  };

  const handleFinalizeClick = async () => {
    // Pre-check: fetch summary to show warnings in confirmation
    if (!session.session?.id) return;
    try {
      const preCheckSummary = await fetchSessionSummary(session.session.id);
      setFinalizePreCheck({
        total: preCheckSummary.total_scans,
        unmatched: preCheckSummary.unmatched_count,
      });
      setIsFinalizeConfirming(true);
    } catch (err) {
      console.error("Failed to fetch pre-check summary", err);
    }
  };

  const handleConfirmFinalize = async () => {
    if (!session.session?.id) return;
    setFinalizing(true);
    try {
      await finalizeBaseline(session.session.id);
      const summaryData = await fetchSessionSummary(session.session.id);
      setSummary(summaryData);
      setIsFinalizeConfirming(false);
      setShowSummary(true);
    } catch (err) {
      console.error("Failed to finalize baseline", err);
      // Keep confirmation modal open for retry
    } finally {
      setFinalizing(false);
    }
  };

  const handleCancelFinalize = () => {
    setIsFinalizeConfirming(false);
    setFinalizePreCheck(null);
  };

  const handleCloseSummary = () => {
    setShowSummary(false);
    setSummary(null);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 12px" }}>
      {/* Capture QA Settings Button (gear icon) */}
      <button
        onClick={() => setShowCalibration(true)}
        style={{
          padding: "4px 8px",
          fontSize: 14,
          background: "var(--bg-secondary)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          cursor: "pointer",
          color: "var(--muted)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        title="Capture QA Settings - Adjust camera and image processing parameters"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      </button>

      {/* Session Toggle */}
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: status === "VALIDATING" ? "not-allowed" : "pointer",
          opacity: status === "VALIDATING" ? 0.6 : 1,
        }}
      >
        <input
          type="checkbox"
          checked={status === "RUNNING" || status === "VALIDATING"}
          onChange={handleToggle}
          disabled={status === "VALIDATING" || session.isLoading}
          style={{ cursor: "pointer" }}
        />
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.5 }}>Session</span>
      </label>

      {/* Status Pill */}
      <span
        className="pill"
        style={{
          borderColor: "transparent",
          background: `${statusColor}22`,
          color: statusColor,
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        {statusLabel}
      </span>

      {/* Baseline Mode Indicator + Counter */}
      {session.isBaseline && (status === "RUNNING" || status === "VALIDATING") && (
        <>
          <span
            className="pill"
            style={{
              borderColor: "transparent",
              background: "#8b5cf622",
              color: "#8b5cf6",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.5,
            }}
            title="Baseline session: Accept gates relaxed (no back capture or canonical required)"
          >
            BASELINE MODE
          </span>
          <span
            className="pill"
            style={{
              borderColor: "transparent",
              background: baselineCount >= BASELINE_TARGET ? "#22c55e22" : "#f59e0b22",
              color: baselineCount >= BASELINE_TARGET ? "#22c55e" : "#f59e0b",
              fontSize: 11,
              fontWeight: 700,
              fontFamily: "var(--mono)",
            }}
            title={`Baseline contributions: ${baselineCount} of ${BASELINE_TARGET} target`}
          >
            {baselineCount} / {BASELINE_TARGET}
          </span>
        </>
      )}

      {/* Back capture countdown selector (non-baseline sessions) */}
      {!session.isBaseline && session.session?.id && (status === "RUNNING" || status === "VALIDATING") && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--sub)" }} title="Delay before triggering back capture during Accept macro">
            Back countdown
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            {[
              { label: "2s", ms: 2000 },
              { label: "3.5s", ms: 3500 },
              { label: "4.5s", ms: 4500 },
            ].map((opt) => (
              <label
                key={opt.ms}
                className="pill"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  cursor: "pointer",
                  borderColor: "transparent",
                  background: backCaptureDelayMs === opt.ms ? "var(--accent-glow)" : "rgba(139, 149, 168, 0.10)",
                  color: backCaptureDelayMs === opt.ms ? "var(--accent)" : "var(--sub)",
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "6px 10px",
                  userSelect: "none",
                }}
              >
                <input
                  type="radio"
                  name="cm_back_capture_delay"
                  value={opt.ms}
                  checked={backCaptureDelayMs === opt.ms}
                  onChange={() => onBackCaptureDelayChange?.(opt.ms)}
                  style={{ display: "none" }}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Start Baseline Session Button (visible when no session active) */}
      {(status === "PREP" || status === "CLOSED" || status === "ABORTED") && (
        <button
          onClick={handleStartBaseline}
          disabled={session.isLoading}
          style={{
            padding: "4px 10px",
            fontSize: 11,
            fontWeight: 600,
            background: "#8b5cf622",
            color: "#8b5cf6",
            border: "1px solid #8b5cf644",
            borderRadius: 4,
            cursor: session.isLoading ? "not-allowed" : "pointer",
            opacity: session.isLoading ? 0.6 : 1,
          }}
          title="Start a baseline session with relaxed Accept gates (no back capture or canonical required)"
        >
          🎯 Start Baseline Session
        </button>
      )}

      {/* Elapsed Timer (when active) */}
      {(status === "RUNNING" || status === "VALIDATING") && elapsedTime && (
        <span className="pill" style={{ fontSize: 11, fontFamily: "var(--mono)" }}>
          ⏱ {elapsedTime}
        </span>
      )}

      {/* Heartbeat Drift Warning */}
      {heartbeat_stale && (
        <span
          className="pill"
          style={{
            borderColor: "transparent",
            background: "#f59e0b22",
            color: "#f59e0b",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          ⚠ Heartbeat stale (&gt;90s)
        </span>
      )}

      {/* Canonical Hit Rate Telemetry Chip */}
      {canonicalHitRate !== null && (
        <span
          className="pill"
          style={{
            borderColor: "transparent",
            background: canonicalHitRate >= 80 ? "#dcfce7" : "#fef3c7",
            color: canonicalHitRate >= 80 ? "#166534" : "#92400e",
            fontSize: 11,
            fontWeight: 600,
          }}
          title={`Canonical retrieval hit rate: ${canonicalHitRate}% (≥80% is healthy)`}
        >
          Canonical {canonicalHitRate}%
        </span>
      )}

      {/* Session ID (full with copy button) */}
      {session.session?.id && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--mono)" }}>
            {session.session.id}
          </span>
          <button
            onClick={() => {
              navigator.clipboard.writeText(session.session!.id);
              // Optional: show toast notification
            }}
            style={{
              padding: "2px 6px",
              fontSize: 9,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              cursor: "pointer",
              color: "var(--muted)",
              fontFamily: "var(--mono)",
            }}
            title="Copy session UUID to clipboard"
          >
            📋
          </button>
        </div>
      )}

      {/* Finalize Baseline Button (visible only when baseline session is RUNNING) */}
      {session.isBaseline && status === "RUNNING" && (
        <button
          className="btn primary"
          onClick={handleFinalizeClick}
          disabled={finalizing}
          style={{
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: 600,
            marginLeft: "auto",
          }}
          title="Finalize this session as the active baseline"
        >
          {finalizing ? "⏳ Finalizing..." : "🎯 Finalize Baseline"}
        </button>
      )}

      {/* Baseline Summary Panel */}
      <BaselineSummaryPanel
        isOpen={showSummary}
        summary={summary}
        onClose={handleCloseSummary}
      />

      {/* Confirmation Modal for Finalize Baseline */}
      {isFinalizeConfirming && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={handleCancelFinalize}
        >
          <div
            className="panel"
            style={{
              padding: 20,
              borderRadius: 8,
              maxWidth: 500,
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
              zIndex: 1001,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ margin: "0 0 8px 0", fontSize: 14, fontWeight: 700 }}>
                🎯 Finalize Baseline Session?
              </h3>
              <p style={{ margin: 0, fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
                This will mark this session as the active baseline (latest baseline wins).
              </p>
              {finalizePreCheck && (
                <div style={{ marginTop: 12, padding: 12, background: "var(--surface)", borderRadius: 6 }}>
                  <div style={{ fontSize: 12, marginBottom: 6 }}>
                    <strong>Session Summary:</strong>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: "var(--muted)" }}>
                    <li>Total scans: <strong>{finalizePreCheck.total}</strong></li>
                    <li>Unmatched: <strong>{finalizePreCheck.unmatched}</strong></li>
                  </ul>
                  {finalizePreCheck.total < 20 && (
                    <div style={{ marginTop: 8, fontSize: 12, color: "rgb(251, 191, 36)", fontWeight: 600 }}>
                      ⚠ Sample size is low (N={finalizePreCheck.total}, recommended ≥20)
                    </div>
                  )}
                  {finalizePreCheck.unmatched > 0 && (
                    <div style={{ marginTop: 8, fontSize: 12, color: "rgb(251, 191, 36)", fontWeight: 600 }}>
                      ⚠ {finalizePreCheck.unmatched} UNKNOWN_* items present
                    </div>
                  )}
                </div>
              )}
              <p style={{ margin: "12px 0 0 0", fontSize: 12, color: "var(--info)", fontWeight: 600 }}>
                You can proceed even with warnings. Summary will be shown after finalization.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                className="btn"
                onClick={handleCancelFinalize}
                disabled={finalizing}
                style={{ padding: "6px 12px", fontSize: 12 }}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={handleConfirmFinalize}
                disabled={finalizing}
                style={{ padding: "6px 12px", fontSize: 12 }}
              >
                {finalizing ? "⏳ Finalizing..." : "Finalize"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal for End Session */}
      {isConfirming && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={handleCancelEnd}
        >
          <div
            className="panel"
            style={{
              padding: 20,
              borderRadius: 8,
              maxWidth: 400,
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
              zIndex: 1001,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ margin: "0 0 8px 0", fontSize: 14, fontWeight: 700 }}>
                ⚠ End Session?
              </h3>
              <p style={{ margin: 0, fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
                This will:
              </p>
              <ul style={{ margin: "8px 0", paddingLeft: 20, fontSize: 12, color: "var(--muted)" }}>
                <li>Clear the job queue</li>
                <li>Transition session to VALIDATING then CLOSED</li>
                <li>Stop heartbeat polling</li>
              </ul>
              <p style={{ margin: "8px 0 0 0", fontSize: 12, color: "var(--warn)", fontWeight: 600 }}>
                This action cannot be undone.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                className="btn"
                onClick={handleCancelEnd}
                style={{ padding: "6px 12px", fontSize: 12 }}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={handleConfirmEnd}
                style={{ padding: "6px 12px", fontSize: 12, background: "#ef4444", color: "white" }}
              >
                End Session
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Calibration Modal */}
      <CalibrationModal
        isOpen={showCalibration}
        onClose={() => setShowCalibration(false)}
      />
    </div>
  );
};

export default SessionHeader;
