import React, { useEffect, useState } from "react";
import type { BaselineSummary } from "../api/client";

interface BaselineSummaryPanelProps {
  isOpen: boolean;
  summary: BaselineSummary | null;
  onClose: () => void;
}

/**
 * BaselineSummaryPanel: Full-screen centered modal displaying baseline session summary
 * Read-only display with copy actions for JSON and acceptance commands
 */
const BaselineSummaryPanel: React.FC<BaselineSummaryPanelProps> = ({
  isOpen,
  summary,
  onClose,
}) => {
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  // Auto-dismiss copy notices after 5 seconds
  useEffect(() => {
    if (!copyNotice) return;
    const timer = setTimeout(() => setCopyNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [copyNotice]);

  // Keyboard accessibility: ESC to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !summary) return null;

  const handleCopyJSON = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
      setCopyNotice("Summary JSON copied to clipboard");
    } catch (err) {
      console.error("Failed to copy JSON", err);
      setCopyNotice("Failed to copy JSON");
    }
  };

  const handleCopyAcceptanceCommand = async () => {
    const command = `scripts/validate/run_acceptance.sh`;
    try {
      await navigator.clipboard.writeText(command);
      setCopyNotice("Acceptance command copied to clipboard");
    } catch (err) {
      console.error("Failed to copy command", err);
      setCopyNotice("Failed to copy command");
    }
  };

  const handleCopyExportCommand = async () => {
    const command = `scripts/export/baseline_ground_truth.sh`;
    try {
      await navigator.clipboard.writeText(command);
      setCopyNotice("Export command copied to clipboard");
    } catch (err) {
      console.error("Failed to copy command", err);
      setCopyNotice("Failed to copy command");
    }
  };

  // Warning conditions
  const warnings: string[] = [];
  if (summary.total_scans < 20) {
    warnings.push(`Low sample size: N=${summary.total_scans} (recommended ≥20)`);
  }
  if (summary.unmatched_count > 0) {
    warnings.push(`${summary.unmatched_count} UNKNOWN_* items (unmatched)`);
  }
  if (summary.eligible_not_staged_count > 0) {
    warnings.push(`${summary.eligible_not_staged_count} eligible items not staging_ready`);
  }
  if (summary.csv_fallback_count > 0) {
    warnings.push(`${summary.csv_fallback_count} items using CSV fallback pricing`);
  }

  const formatTimestamp = (ts: number) => {
    if (!ts) return "—";
    return new Date(ts).toLocaleString();
  };

  const formatDuration = (start: number, end: number) => {
    if (!start || !end) return "—";
    const durationMs = end - start;
    const durationMin = Math.floor(durationMs / 60000);
    return `${durationMin} min`;
  };

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          zIndex: 999,
        }}
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="panel"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(95%, 900px)",
          maxHeight: "90vh",
          overflow: "auto",
          zIndex: 1000,
          padding: 24,
          display: "grid",
          gap: 20,
        }}
      >
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 20 }}>Baseline Session Summary</div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
              Session {summary.session_id.slice(0, 8)} • Finalized {formatTimestamp(summary.finalized_at)}
            </div>
          </div>
          <button className="btn" onClick={onClose} style={{ padding: "6px 12px" }}>
            ✕
          </button>
        </header>

        {/* Copy Notice */}
        {copyNotice && (
          <div
            className="pill"
            style={{
              background: "var(--good)",
              color: "#fff",
              padding: "8px 16px",
              borderRadius: 4,
              fontSize: 13,
              textAlign: "center",
            }}
          >
            {copyNotice}
          </div>
        )}

        {/* Warnings */}
        {warnings.length > 0 && (
          <div
            style={{
              background: "rgba(251, 191, 36, 0.1)",
              border: "1px solid rgb(251, 191, 36)",
              borderRadius: 6,
              padding: 12,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8, color: "rgb(245, 158, 11)" }}>
              ⚠ Warnings
            </div>
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
              {warnings.map((w, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  {w}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Metrics Grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 16,
          }}
        >
          <MetricCard label="Total Scans" value={summary.total_scans} />
          <MetricCard label="Accepted" value={summary.accepted_count} good />
          <MetricCard label="Flagged" value={summary.flagged_count} warn={summary.flagged_count > 0} />
          <MetricCard label="Unmatched" value={summary.unmatched_count} warn={summary.unmatched_count > 0} />
          <MetricCard label="Canonicalized" value={summary.canonicalized_count} />
          <MetricCard label="Enriched (PPT)" value={summary.enriched_count} />
          <MetricCard label="Fresh Pricing" value={summary.fresh_pricing_count} />
          <MetricCard label="CSV Fallback" value={summary.csv_fallback_count} warn={summary.csv_fallback_count > 0} />
          <MetricCard label="Staging Ready" value={summary.staging_ready_count} good />
          <MetricCard label="Eligible (Not Staged)" value={summary.eligible_not_staged_count} warn={summary.eligible_not_staged_count > 0} />
          <MetricCard label="Manual Overrides" value={summary.manual_override_count} />
          <MetricCard label="Accepted w/o Canonical" value={summary.accepted_without_canonical_count} warn={summary.accepted_without_canonical_count > 0} />
        </div>

        {/* Session Details */}
        <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Session Details</div>
          <DetailRow label="First Scan" value={formatTimestamp(summary.first_scan_at)} />
          <DetailRow label="Last Scan" value={formatTimestamp(summary.last_scan_at)} />
          <DetailRow label="Duration" value={formatDuration(summary.first_scan_at, summary.last_scan_at)} />
          <DetailRow label="PPT Calls Consumed" value={summary.ppt_calls_consumed ?? "—"} />
          <DetailRow label="PPT Daily Remaining" value={summary.ppt_daily_remaining ?? "—"} />
          <DetailRow label="Retrieval Corpus Hash" value={summary.retrieval_corpus_hash?.slice(0, 16) ?? "—"} />
          <DetailRow label="OpenAI Model" value={summary.openai_model ?? "—"} />
        </div>

        {/* Actions */}
        <footer style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button className="btn" onClick={handleCopyJSON} style={{ padding: "8px 16px" }}>
            📋 Copy Summary JSON
          </button>
          <button className="btn" onClick={handleCopyAcceptanceCommand} style={{ padding: "8px 16px" }}>
            📋 Copy Acceptance Command
          </button>
          <button className="btn" onClick={handleCopyExportCommand} style={{ padding: "8px 16px" }}>
            📋 Copy Export Command
          </button>
          <button className="btn primary" onClick={onClose} style={{ padding: "8px 16px" }}>
            Close
          </button>
        </footer>
      </div>
    </>
  );
};

// Helper Components
const MetricCard: React.FC<{ label: string; value: number; good?: boolean; warn?: boolean }> = ({
  label,
  value,
  good,
  warn,
}) => {
  let color = "var(--text)";
  if (good) color = "var(--good)";
  if (warn) color = "rgb(251, 191, 36)";

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 12,
        background: "var(--surface)",
      }}
    >
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
    </div>
  );
};

const DetailRow: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
    <span style={{ color: "var(--muted)" }}>{label}:</span>
    <span style={{ fontWeight: 500 }}>{value}</span>
  </div>
);

export default BaselineSummaryPanel;
