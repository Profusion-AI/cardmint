import React, { useEffect, useState } from "react";
import { fetchQuotaState, type QuotaState } from "../api/client";

/**
 * QuotaChip: Displays PPT quota status as a chip with —/~/✓ states
 * - — (dash): unknown or quota data unavailable
 * - ~ (tilde): warning level (low remaining, typically <=20%)
 * - ✓ (checkmark): ok level (plenty remaining, typically >20%)
 */
export const QuotaChip: React.FC = () => {
  const [quota, setQuota] = useState<QuotaState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadQuota = async () => {
      setLoading(true);
      setError(null);
      try {
        const state = await fetchQuotaState();
        if (!cancelled) {
          setQuota(state);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load quota");
          setQuota(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadQuota();

    // Refresh quota every 60 seconds
    const interval = setInterval(loadQuota, 60000);

    // Listen for immediate quota updates from enrichment/preview actions
    const onQuotaEvent = (e: Event) => {
      try {
        const custom = e as CustomEvent<{ quota?: QuotaState | null }>;
        const next = custom.detail?.quota;
        if (next) {
          setQuota(next);
          setError(null);
          setLoading(false);
        } else {
          // If payload missing, force a refresh
          void loadQuota();
        }
      } catch {
        // Ignore malformed events
      }
    };
    window.addEventListener("cardmint:pptQuotaUpdate", onQuotaEvent as EventListener);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("cardmint:pptQuotaUpdate", onQuotaEvent as EventListener);
    };
  }, []);

  // Determine chip state and color
  const getChipDisplay = (): { symbol: string; color: string; tooltip: string } => {
    if (loading) {
      return {
        symbol: "...",
        color: "var(--muted)",
        tooltip: "Loading quota status...",
      };
    }

    if (error) {
      return {
        symbol: "—",
        color: "var(--muted)",
        tooltip: `Quota unavailable: ${error}`,
      };
    }

    if (!quota) {
      return {
        symbol: "—",
        color: "var(--muted)",
        tooltip: "Quota data not available",
      };
    }

    const { tier, dailyLimit, dailyRemaining, callsConsumed, warningLevel, lastUpdated } = quota;

    // Build tooltip text
    const remaining = dailyRemaining ?? "unknown";
    const consumed = callsConsumed ?? "unknown";
    const lastUpdateTime = new Date(lastUpdated).toLocaleTimeString();
    const tooltipText = [
      `Tier: ${tier}`,
      `Daily limit: ${dailyLimit}`,
      `Remaining: ${remaining}`,
      `Consumed: ${consumed}`,
      `Last updated: ${lastUpdateTime}`,
    ].join("\n");

    // Map warning level to chip display
    switch (warningLevel) {
      case "ok":
        return {
          symbol: "✓",
          color: "var(--good)",
          tooltip: tooltipText,
        };
      case "warning":
        return {
          symbol: "~",
          color: "var(--warn)",
          tooltip: tooltipText,
        };
      case "critical":
        return {
          symbol: "!",
          color: "var(--bad)",
          tooltip: `${tooltipText}\n\nCritical: Quota nearly exhausted`,
        };
      default:
        return {
          symbol: "—",
          color: "var(--muted)",
          tooltip: tooltipText,
        };
    }
  };

  const { symbol, color, tooltip } = getChipDisplay();

  return (
    <span
      className="pill"
      style={{
        borderColor: "transparent",
        background: `${color}22`,
        color,
        fontWeight: 600,
        cursor: "help",
        userSelect: "none",
      }}
      title={tooltip}
    >
      PPT {symbol}
    </span>
  );
};
