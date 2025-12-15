import React, { useState, useEffect, useCallback } from "react";

interface LocalMetrics {
  scansToday: number;
  acceptedToday: number;
  acceptanceRateToday: number;
  totalScans: number;
  totalAccepted: number;
  acceptanceRateAllTime: number;
  queueDepth: number;
  pathAToday: number;
  pathBToday: number;
}

interface FunnelStep {
  name: string;
  count: number;
  conversionRate: number;
}

interface PostHogData {
  steps: FunnelStep[];
  period: string;
  lastUpdated: string;
  source: "posthog";
}

interface AnalyticsPulse {
  ok: boolean;
  local: LocalMetrics;
  posthog: PostHogData | null;
  timestamp: string;
}

interface AnalyticsStatus {
  configured: boolean;
  host: string | null;
  projectId: string | null;
}

const POSTHOG_CLOUD_URL = "https://us.posthog.com";

const fetchAnalyticsPulse = async (): Promise<AnalyticsPulse> => {
  const response = await fetch("/api/analytics/pulse");
  if (!response.ok) {
    throw new Error(`Failed to fetch analytics: ${response.status}`);
  }
  return response.json();
};

const fetchAnalyticsStatus = async (): Promise<AnalyticsStatus> => {
  const response = await fetch("/api/analytics/status");
  if (!response.ok) {
    throw new Error(`Failed to fetch status: ${response.status}`);
  }
  return response.json();
};

const MetricCard: React.FC<{
  label: string;
  value: string | number;
  subtext?: string;
  accent?: boolean;
  warning?: boolean;
}> = ({ label, value, subtext, accent, warning }) => (
  <div
    style={{
      background: warning ? "var(--warning-bg, #fef3c7)" : "var(--surface, #f9fafb)",
      border: `1px solid ${warning ? "var(--warning-border, #fcd34d)" : "var(--border, #e5e7eb)"}`,
      borderRadius: "var(--r-md, 8px)",
      padding: "12px 16px",
      minWidth: 120,
    }}
  >
    <div
      style={{
        fontSize: "var(--text-xs, 11px)",
        color: "var(--muted, #6b7280)",
        textTransform: "uppercase",
        letterSpacing: "0.5px",
        marginBottom: 4,
      }}
    >
      {label}
    </div>
    <div
      style={{
        fontSize: "var(--text-2xl, 28px)",
        fontWeight: 600,
        color: accent ? "var(--accent, #3b82f6)" : warning ? "var(--warning, #d97706)" : "var(--fg, #1f2937)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {value}
    </div>
    {subtext && (
      <div style={{ fontSize: "var(--text-xs, 11px)", color: "var(--muted, #6b7280)", marginTop: 2 }}>
        {subtext}
      </div>
    )}
  </div>
);

const FunnelBar: React.FC<{ step: FunnelStep; maxCount: number; index: number }> = ({
  step,
  maxCount,
  index,
}) => {
  const width = maxCount > 0 ? Math.max((step.count / maxCount) * 100, 5) : 5;
  const colors = ["#3b82f6", "#6366f1", "#8b5cf6", "#22c55e"];

  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "var(--text-xs, 11px)",
          marginBottom: 4,
        }}
      >
        <span style={{ color: "var(--fg, #1f2937)", fontWeight: 500 }}>
          {step.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
        </span>
        <span style={{ color: "var(--muted, #6b7280)" }}>
          {step.count.toLocaleString()}
          {index > 0 && ` (${step.conversionRate}%)`}
        </span>
      </div>
      <div
        style={{
          height: 8,
          background: "var(--border, #e5e7eb)",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${width}%`,
            height: "100%",
            background: colors[index % colors.length],
            borderRadius: 4,
            transition: "width 0.3s ease",
          }}
        />
      </div>
    </div>
  );
};

export const AnalyticsPanel: React.FC = () => {
  const [pulse, setPulse] = useState<AnalyticsPulse | null>(null);
  const [status, setStatus] = useState<AnalyticsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pulseData, statusData] = await Promise.all([
        fetchAnalyticsPulse(),
        fetchAnalyticsStatus(),
      ]);
      setPulse(pulseData);
      setStatus(statusData);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Auto-refresh every 60 seconds
    const interval = setInterval(refresh, 60000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (loading && !pulse) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "var(--muted, #6b7280)" }}>
        Loading analytics...
      </div>
    );
  }

  if (error && !pulse) {
    return (
      <div style={{ padding: 24 }}>
        <div
          style={{
            padding: 16,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 8,
            color: "#991b1b",
          }}
        >
          {error}
        </div>
        <button
          onClick={refresh}
          style={{
            marginTop: 12,
            padding: "8px 16px",
            background: "var(--accent, #3b82f6)",
            color: "white",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const local = pulse?.local;
  const posthog = pulse?.posthog;
  const maxFunnelCount = posthog?.steps?.[0]?.count ?? 0;

  return (
    <div style={{ padding: 16, height: "100%", overflow: "auto" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <h2 style={{ fontSize: "var(--text-lg, 18px)", fontWeight: 600, margin: 0 }}>
          Analytics
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {lastRefresh && (
            <span style={{ fontSize: "var(--text-xs, 11px)", color: "var(--muted, #6b7280)" }}>
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={loading}
            style={{
              padding: "4px 8px",
              fontSize: "var(--text-xs, 11px)",
              background: "var(--surface, #f9fafb)",
              border: "1px solid var(--border, #e5e7eb)",
              borderRadius: 4,
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Daily Pulse - Local Metrics */}
      <div style={{ marginBottom: 20 }}>
        <h3
          style={{
            fontSize: "var(--text-sm, 13px)",
            fontWeight: 600,
            color: "var(--muted, #6b7280)",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            marginBottom: 12,
          }}
        >
          Operator Pulse
        </h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            gap: 12,
          }}
        >
          <MetricCard label="Scans Today" value={local?.scansToday ?? "—"} />
          <MetricCard
            label="Accepted"
            value={local?.acceptedToday ?? "—"}
            subtext={local ? `${local.acceptanceRateToday}% rate` : undefined}
            accent
          />
          <MetricCard
            label="Queue"
            value={local?.queueDepth ?? "—"}
            warning={(local?.queueDepth ?? 0) > 5}
          />
          <MetricCard
            label="Path A"
            value={local?.pathAToday ?? "—"}
            subtext="OpenAI"
          />
          <MetricCard
            label="Path B"
            value={local?.pathBToday ?? "—"}
            subtext="LM Studio"
          />
        </div>
      </div>

      {/* All Time Stats */}
      <div style={{ marginBottom: 20 }}>
        <h3
          style={{
            fontSize: "var(--text-sm, 13px)",
            fontWeight: 600,
            color: "var(--muted, #6b7280)",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            marginBottom: 12,
          }}
        >
          All Time
        </h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 12,
          }}
        >
          <MetricCard
            label="Total Scans"
            value={local?.totalScans?.toLocaleString() ?? "—"}
          />
          <MetricCard
            label="Total Accepted"
            value={local?.totalAccepted?.toLocaleString() ?? "—"}
            subtext={local ? `${local.acceptanceRateAllTime}% rate` : undefined}
            accent
          />
        </div>
      </div>

      {/* PostHog Funnel */}
      <div style={{ marginBottom: 20 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h3
            style={{
              fontSize: "var(--text-sm, 13px)",
              fontWeight: 600,
              color: "var(--muted, #6b7280)",
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              margin: 0,
            }}
          >
            Storefront Funnel
          </h3>
          {posthog?.period && (
            <span
              style={{
                fontSize: "var(--text-xs, 10px)",
                padding: "2px 6px",
                background: status?.configured ? "#dcfce7" : "#f3f4f6",
                color: status?.configured ? "#166534" : "#6b7280",
                borderRadius: 4,
              }}
            >
              {status?.configured ? "PostHog" : "Not Configured"}
            </span>
          )}
        </div>

        {status?.configured && posthog?.steps && posthog.steps.length > 0 ? (
          <div
            style={{
              background: "var(--surface, #f9fafb)",
              border: "1px solid var(--border, #e5e7eb)",
              borderRadius: 8,
              padding: 16,
            }}
          >
            {posthog.steps.map((step, index) => (
              <FunnelBar
                key={step.name}
                step={step}
                maxCount={maxFunnelCount}
                index={index}
              />
            ))}
          </div>
        ) : (
          <div
            style={{
              padding: 20,
              background: "#f3f4f6",
              borderRadius: 8,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: "var(--text-sm, 13px)", color: "#6b7280", marginBottom: 8 }}>
              {status?.configured
                ? "No funnel data available yet"
                : "PostHog not configured"}
            </div>
            <div style={{ fontSize: "var(--text-xs, 11px)", color: "#9ca3af" }}>
              {status?.configured
                ? "Events will appear once storefront captures them"
                : "Set POSTHOG_API_KEY, POSTHOG_PERSONAL_API_KEY, and POSTHOG_PROJECT_ID in .env"}
            </div>
          </div>
        )}
      </div>

      {/* PostHog Cloud Link */}
      <div
        style={{
          padding: 16,
          background: "linear-gradient(135deg, #1d4ed8 0%, #7c3aed 100%)",
          borderRadius: 8,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ fontWeight: 600, color: "white", marginBottom: 4 }}>
            Deep Analytics
          </div>
          <div style={{ fontSize: "var(--text-xs, 11px)", color: "rgba(255,255,255,0.8)" }}>
            Session replays, experiments, feature flags
          </div>
        </div>
        <a
          href={`${POSTHOG_CLOUD_URL}/insights`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: "8px 16px",
            background: "rgba(255,255,255,0.2)",
            color: "white",
            borderRadius: 6,
            textDecoration: "none",
            fontSize: "var(--text-sm, 13px)",
            fontWeight: 500,
            transition: "background 0.2s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.3)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.2)")}
        >
          Open PostHog
        </a>
      </div>
    </div>
  );
};

export default AnalyticsPanel;
