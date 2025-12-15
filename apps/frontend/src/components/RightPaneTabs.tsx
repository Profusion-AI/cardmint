import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Job } from "../api/adapters";
import type { Evidence } from "../api/client";
import RightPaneEvidence, { PPTBestGuess, PPTEnrichmentContext } from "./RightPaneEvidence";
import ManualEditor from "./ManualEditor";
import CanonicalizationDrawer from "./CanonicalizationDrawer";
import { enrichWithPPT, fetchPPTQuote, rescanJob, promoteProducts } from "../api/client";

const VITE_FEATURE_MANUAL_TAB = (() => {
  const raw = import.meta.env.VITE_FEATURE_MANUAL_TAB;
  if (raw == null) return true; // Default true for pilot
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
})();

const DEBUG_PANEL_ENABLED = import.meta.env.DEV === true;

interface RightPaneTabsProps {
  job: Job | null;
  evidence: Evidence | null;
  loading: boolean;
  chosen: number | null;
  setChosen: (i: number) => void;
  onAccept: () => void;
  onFlag: () => void;
  featureEnabled: boolean;
  setSelectionSource: (source: "top3" | "expanded_family" | "manual_tab") => void;
  variantTelemetry: Record<string, any>;
  setVariantTelemetry: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  setSelectedExpandedVariantId: (id: string | null) => void;
  onManualValidityChange?: (hasValidEdits: boolean, hasInvalidEdits: boolean) => void;
  refreshEvidence: () => void;
  refreshJob?: () => Promise<void>;
  condition: string;
  setCondition: (condition: string) => void;
  onBaselineAccepted?: () => void;
}

type TabType = "auto" | "manual";

interface DebugEvent {
  id: number;
  ts: string;
  type: string;
  payload: any;
}

const RightPaneTabs: React.FC<RightPaneTabsProps> = (props) => {
  const {
    job,
    evidence,
    loading,
    chosen,
    setChosen,
    onAccept,
    onFlag,
    featureEnabled,
    setSelectionSource,
    variantTelemetry,
    setVariantTelemetry,
    setSelectedExpandedVariantId,
    onManualValidityChange,
    refreshEvidence,
    refreshJob,
    condition,
    setCondition,
    onBaselineAccepted,
  } = props;

  const [debugOpen, setDebugOpen] = useState(false);
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);

  const logDebug = useCallback(
    (type: string, payload: any) => {
      if (!DEBUG_PANEL_ENABLED) return;
      setDebugEvents((prev) => [
        {
          id: Date.now() + Math.random(),
          ts: new Date().toISOString(),
          type,
          payload,
        },
        ...prev.slice(0, 199),
      ]);
    },
    []
  );

  // Track manual editor validity state
  const [hasValidEdits, setHasValidEdits] = useState(false);
  const [hasInvalidEdits, setHasInvalidEdits] = useState(false);

  const handleValidityChange = (valid: boolean, invalid: boolean) => {
    setHasValidEdits(valid);
    setHasInvalidEdits(invalid);
    if (onManualValidityChange) {
      onManualValidityChange(valid, invalid);
    }
  };

  // Persist tab selection in sessionStorage per job
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    if (!VITE_FEATURE_MANUAL_TAB) return "auto";
    if (typeof window === "undefined") return "auto";
    try {
      const key = `cardmint:rightPaneTab:${job?.id ?? "null"}`;
      const stored = sessionStorage.getItem(key);
      return (stored === "manual" ? "manual" : "auto") as TabType;
    } catch {
      return "auto";
    }
  });

  const [pptBestGuess, setPptBestGuess] = useState<PPTBestGuess | null>(null);
  const [pptEnrichmentContext, setPptEnrichmentContext] = useState<PPTEnrichmentContext | null>(null);
  const pendingInventoryRefreshRef = useRef<{ jobId: string | null; attempts: number; timeout: number | null }>({
    jobId: null,
    attempts: 0,
    timeout: null,
  });

  const resetPendingInventoryRefresh = useCallback((nextJobId: string | null = null) => {
    const state = pendingInventoryRefreshRef.current;
    if (state.timeout) {
      window.clearTimeout(state.timeout);
      state.timeout = null;
    }
    state.attempts = 0;
    state.jobId = nextJobId;
  }, []);

  // Close debug panel on job change and mark selection
  useEffect(() => {
    if (!DEBUG_PANEL_ENABLED) return;
    setDebugOpen(false);
    if (job?.id) {
      logDebug("JOB_SELECTED", { jobId: job.id });
    }
  }, [job?.id, logDebug]);

  // Persist tab selection whenever it changes
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!job?.id) return;
    try {
      const key = `cardmint:rightPaneTab:${job.id}`;
      sessionStorage.setItem(key, activeTab);
    } catch {
      /* ignore quota */
    }
  }, [job?.id, activeTab]);

  // If feature disabled, render only Auto tab
  if (!VITE_FEATURE_MANUAL_TAB) {
    return (
      <RightPaneEvidence
        job={job}
        evidence={evidence}
        loading={loading}
        chosen={chosen}
        setChosen={setChosen}
        onAccept={onAccept}
        onFlag={onFlag}
        featureEnabled={featureEnabled}
        setSelectionSource={setSelectionSource}
        setVariantTelemetry={setVariantTelemetry}
        setSelectedExpandedVariantId={setSelectedExpandedVariantId}
        pptBestGuess={null}
        pptEnrichmentContext={pptEnrichmentContext}
        refreshEvidence={refreshEvidence}
        refreshJob={refreshJob}
        condition={condition}
        setCondition={setCondition}
        variantTelemetry={variantTelemetry}
        onBaselineAccepted={onBaselineAccepted}
      />
    );
  }

  // Toolbar actions: Canonicalize / Enrich / Promote / Rescan
  const canonicalFromBackend =
    (job as any)?.cm_card_id ??
    evidence?.inventory?.cm_card_id ??
    null;
  const [localCanonicalId, setLocalCanonicalId] = useState<string | null>(canonicalFromBackend);
  useEffect(() => {
    setLocalCanonicalId(canonicalFromBackend);
  }, [canonicalFromBackend]);

  // Stage 2 inventory might not exist yet, so product UID can be null until Accept
  const productUid = evidence?.inventory?.product_uid ?? null;

  const isUnknown =
    !localCanonicalId || String(localCanonicalId).startsWith("UNKNOWN_");

  // Stage 1 prerequisite: front locked + operator Truth Core ready
  // Read from variantTelemetry.truth_core (operator inputs), NOT job.extracted (model output)
  const truthCore = variantTelemetry?.truth_core as { name?: string; collector_no?: string; set_name?: string } | undefined;
  const truthCoreReady = Boolean(
    truthCore?.name?.trim() &&
    truthCore?.collector_no?.trim() &&
    truthCore?.set_name?.trim()
  );
  const canCanonicalize = Boolean(
    isUnknown && job?.id && job?.front_locked && truthCoreReady
  );
  const canonicalizeTitle = !isUnknown
    ? "Already canonical"
    : !job?.id
      ? "Select a scan to canonicalize"
      : !job?.front_locked
        ? "Lock front image before canonicalizing"
        : !truthCoreReady
          ? "Truth core fields required (name, collector_no, set_name)"
          : "Resolve canonical ID";
  const [canonSuggestion, setCanonSuggestion] = useState<string | null>(null);
  const [canonSuggestionStatus, setCanonSuggestionStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [canonSuggestionError, setCanonSuggestionError] = useState<string | null>(null);
  const suggestionAbortRef = useRef<AbortController | null>(null);
  const lastSuggestionSignatureRef = useRef<string | null>(null);
  const pendingSuggestionSignatureRef = useRef<string | null>(null);

  const resetCanonSuggestion = useCallback(() => {
    suggestionAbortRef.current?.abort();
    suggestionAbortRef.current = null;
    lastSuggestionSignatureRef.current = null;
    pendingSuggestionSignatureRef.current = null;
    setCanonSuggestion(null);
    setCanonSuggestionStatus("idle");
    setCanonSuggestionError(null);
  }, []);

  useEffect(() => {
    return () => {
      suggestionAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      resetPendingInventoryRefresh(null);
    };
  }, [resetPendingInventoryRefresh]);

  useEffect(() => {
    if (!refreshEvidence || !job?.id) {
      resetPendingInventoryRefresh(null);
      return;
    }

    if (!evidence || evidence.status !== "AVAILABLE") {
      return;
    }

    const hasProductUid = Boolean(evidence.inventory?.product_uid);
    const hasCmCardId = Boolean(evidence.inventory?.cm_card_id);

    if (hasProductUid && hasCmCardId) {
      resetPendingInventoryRefresh(job.id);
      return;
    }

    const state = pendingInventoryRefreshRef.current;
    if (state.jobId !== job.id) {
      resetPendingInventoryRefresh(job.id);
    }

    if (state.attempts >= 4 || state.timeout) {
      return;
    }

    const delay = 900 + state.attempts * 400;
    state.timeout = window.setTimeout(() => {
      refreshEvidence();
      state.timeout = null;
    }, delay);
    state.attempts += 1;
  }, [
    job?.id,
    evidence?.status,
    evidence?.inventory?.product_uid,
    evidence?.inventory?.cm_card_id,
    refreshEvidence,
    resetPendingInventoryRefresh,
  ]);

  useEffect(() => {
    if (!job?.id || !isUnknown) {
      if (DEBUG_PANEL_ENABLED) {
        logDebug("CANON_RESET", {
          jobId: job?.id ?? null,
          reason: !job?.id ? "no_job" : !isUnknown ? "not_unknown" : "unknown",
        });
      }
      resetCanonSuggestion();
      return;
    }

    const truthCore = variantTelemetry?.truth_core;
    const truthVerified =
      variantTelemetry?.truth_verified === true ||
      variantTelemetry?.set_verified === true;
    const truthValidFlag =
      variantTelemetry?.truth_valid === true ||
      (truthCore &&
        !!String(truthCore.name ?? "").trim() &&
        !!String(truthCore.collector_no ?? "").trim() &&
        !!String(truthCore.set_name ?? "").trim());

    if (!truthCore || !truthVerified || !truthValidFlag) {
      if (DEBUG_PANEL_ENABLED) {
        logDebug("CANON_RESET", {
          jobId: job?.id ?? null,
          reason: "gating_failed",
          truthCore,
          truthVerified,
          truthValidFlag,
        });
      }
      resetCanonSuggestion();
      return;
    }

    const collectorNoRaw = String(truthCore.collector_no ?? "").trim();
    const setSize = truthCore.set_size ?? null;
    const setNumber = collectorNoRaw && setSize ? `${collectorNoRaw}/${setSize}` : collectorNoRaw;
    const payload = {
      name: String(truthCore.name ?? "").trim(),
      collector_no: collectorNoRaw,
      set_number: setNumber,
      set_name: String(truthCore.set_name ?? "").trim(),
      hp: truthCore.hp ?? null,
    };

    if (!payload.name || !payload.collector_no || !payload.set_name) {
      if (DEBUG_PANEL_ENABLED) {
        logDebug("CANON_RESET", {
          jobId: job?.id ?? null,
          reason: "payload_incomplete",
          payload,
        });
      }
      resetCanonSuggestion();
      return;
    }

    // Include PPT hint if available
    const ppt_hint = pptBestGuess && (pptBestGuess.setName || pptBestGuess.cardNumber)
      ? {
        setName: pptBestGuess.setName ?? null,
        cardNumber: pptBestGuess.cardNumber ?? null,
      }
      : null;

    const signature = JSON.stringify({ jobId: job.id, ...payload, ppt_hint });
    if (
      signature === lastSuggestionSignatureRef.current ||
      signature === pendingSuggestionSignatureRef.current
    ) {
      return;
    }

    pendingSuggestionSignatureRef.current = signature;
    suggestionAbortRef.current?.abort();
    const controller = new AbortController();
    suggestionAbortRef.current = controller;
    setCanonSuggestionStatus("loading");
    setCanonSuggestionError(null);

    if (DEBUG_PANEL_ENABLED) {
      logDebug("CANON_REQUEST", {
        jobId: job.id,
        payload,
        ppt_hint,
        signature,
      });
    }

    fetch(`/api/scans/${job.id}/canonicalize/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ truth_core: payload, ppt_hint }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          let data: any = null;
          try {
            data = await response.json();
          } catch {
            /* ignore */
          }
          const message = data?.message || data?.error || `Suggestion failed (${response.status})`;
          throw new Error(message);
        }
        return response.json();
      })
      .then((data) => {
        if (controller.signal.aborted) {
          return;
        }
        pendingSuggestionSignatureRef.current = null;
        lastSuggestionSignatureRef.current = signature;
        const suggestedId = typeof data?.suggestion === "string" ? data.suggestion : null;
        setCanonSuggestion(suggestedId);
        setCanonSuggestionStatus("ready");
        setCanonSuggestionError(null);

        if (DEBUG_PANEL_ENABLED) {
          logDebug("CANON_RESULT", {
            jobId: job.id,
            signature,
            suggestedId,
          });
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        pendingSuggestionSignatureRef.current = null;
        lastSuggestionSignatureRef.current = null;
        setCanonSuggestion(null);
        setCanonSuggestionStatus("error");
        setCanonSuggestionError(error instanceof Error ? error.message : "Suggestion failed");

        if (DEBUG_PANEL_ENABLED) {
          logDebug("CANON_ERROR", {
            jobId: job?.id ?? null,
            signature,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      controller.abort();
    };
  }, [job?.id, isUnknown, variantTelemetry, pptBestGuess, resetCanonSuggestion, logDebug]);

  const [pptDailyLimit, setPptDailyLimit] = useState<number | null>(null);
  const [pptDailyRemaining, setPptDailyRemaining] = useState<number | null>(null);
  const [pptReadyForEnrichment, setPptReadyForEnrichment] = useState<boolean>(false);
  const [pptLoading, setPptLoading] = useState(false);
  const [pptError, setPptError] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [previewConfidence, setPreviewConfidence] = useState<number | null>(null);
  const [previewTitle, setPreviewTitle] = useState<string | null>(null);
  const [pptApplied, setPptApplied] = useState<boolean | null>(null);
  const [pptQuoteMarketPrice, setPptQuoteMarketPrice] = useState<number | null>(null);

  const updatePptContext = useCallback(
    (signals: any | null, meta?: Partial<PPTEnrichmentContext> | null) => {
      const derivedStrategy = meta?.strategy ?? (typeof signals?.lookupStrategy === "string" ? signals.lookupStrategy : null);
      const derivedRequestedTitle =
        meta?.parseTitleRequest ??
        (signals?.parseTitle && typeof signals.parseTitle === "object" && typeof signals.parseTitle.requestedTitle === "string"
          ? signals.parseTitle.requestedTitle
          : null);
      const hasPayload = Boolean(signals || derivedStrategy || meta?.bridgeId || derivedRequestedTitle);
      if (!hasPayload) {
        setPptEnrichmentContext(null);
        return;
      }
      setPptEnrichmentContext({
        strategy: (derivedStrategy as PPTEnrichmentContext["strategy"]) ?? null,
        bridgeId: meta?.bridgeId ?? null,
        parseTitleRequest: derivedRequestedTitle ?? null,
        signals: signals ?? null,
      });
    },
    []
  );

  const derivePptBestGuess = useCallback(
    (signals: any, fallbackTitle: string | null): PPTBestGuess | null => {
      const parse = signals?.parseTitle;
      if (!parse) {
        const summary = signals?.cardSummary;
        if (summary && typeof summary === "object") {
          const title = summary.name || fallbackTitle || null;
          if (!title) return null;
          return {
            title,
            setName: summary.setName ?? null,
            cardNumber: summary.cardNumber ?? null,
            confidence: null,
          };
        }
        if (typeof fallbackTitle === "string" && fallbackTitle.trim().length > 0) {
          return { title: fallbackTitle, setName: null, cardNumber: null, confidence: null };
        }
        return null;
      }
      const parsed = parse.parsed;
      let title: string | null = null;
      if (typeof parsed === "string") {
        title = parsed;
      } else if (parsed && typeof parsed === "object") {
        title = parsed.title || parsed.name || parsed.normalized || null;
      }
      if (!title) {
        if (typeof fallbackTitle === "string" && fallbackTitle.trim().length > 0) {
          title = fallbackTitle;
        } else if (typeof parse.requestedTitle === "string") {
          title = parse.requestedTitle;
        }
      }
      if (!title) return null;
      const setName =
        parsed && typeof parsed === "object" ? parsed.setName ?? null : null;
      const cardNumber =
        parsed && typeof parsed === "object" ? parsed.cardNumber ?? null : null;
      const confidence =
        typeof parse.confidence === "number" && Number.isFinite(parse.confidence)
          ? parse.confidence
          : typeof parse.parser?.parsedConfidence === "number" &&
            Number.isFinite(parse.parser?.parsedConfidence)
            ? parse.parser.parsedConfidence
            : null;
      return { title, setName, cardNumber, confidence };
    },
    []
  );

  // Reset preview confidence when context changes (new job or product state)
  useEffect(() => {
    setPreviewConfidence(null);
    setPreviewTitle(null);
    setPptBestGuess(null);
    setPptApplied(null);
    setPptEnrichmentContext(null);
  }, [job?.id, productUid, isUnknown]);

  useEffect(() => {
    let abort = false;
    // Fetch PPT quote whenever product UID changes
    const fetchQuote = async () => {
      if (!productUid || isUnknown) {
        setPptDailyLimit(null);
        setPptDailyRemaining(null);
        setPptReadyForEnrichment(false);
        setPptError(null);
        setPptApplied(null);
        setPptQuoteMarketPrice(null);
        return;
      }
      setPptLoading(true);
      setPptError(null);
      try {
        const quote = await fetchPPTQuote(productUid);
        if (abort) return;
        setPptDailyLimit(quote.quota?.dailyLimit ?? null);
        setPptDailyRemaining(quote.quota?.dailyRemaining ?? null);
        setPptReadyForEnrichment(quote.ready_for_enrichment ?? false);
        const quoteMarketPrice = (quote as { market_price?: unknown }).market_price;
        setPptQuoteMarketPrice(typeof quoteMarketPrice === "number" ? quoteMarketPrice : null);
        setPptApplied(
          typeof quote.pricing_status === "string" && quote.pricing_status.toLowerCase() !== "missing"
            ? true
            : false
        );
        // Broadcast updated quota for top‑nav chip
        try {
          window.dispatchEvent(
            new CustomEvent("cardmint:pptQuotaUpdate", { detail: { quota: quote.quota ?? null } })
          );
        } catch {
          /* no-op */
        }
        if (DEBUG_PANEL_ENABLED) {
          logDebug("PPT_QUOTE_OK", {
            jobId: job?.id ?? null,
            productUid,
            quote,
          });
        }
      } catch (err) {
        if (abort) return;
        const msg = err instanceof Error ? err.message : "Failed to fetch PPT quota";
        setPptError(msg);
        setPptDailyLimit(null);
        setPptDailyRemaining(null);
        setPptReadyForEnrichment(false);
        setPptQuoteMarketPrice(null);
        if (DEBUG_PANEL_ENABLED) {
          logDebug("PPT_QUOTE_ERROR", {
            jobId: job?.id ?? null,
            productUid,
            error: msg,
          });
        }
      } finally {
        if (!abort) setPptLoading(false);
      }
    };
    void fetchQuote();
    return () => {
      abort = true;
    };
  }, [productUid, isUnknown, job?.id, logDebug]);

  // Rescan hotkey (R)
  const [rescanPending, setRescanPending] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "r") return;
      const target = e.target as HTMLElement | null;
      const tag = (target?.tagName || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag)) return; // don't hijack typing
      if (!job?.id || rescanPending) return;
      e.preventDefault();
      setRescanPending(true);
      if (DEBUG_PANEL_ENABLED) {
        logDebug("RESCAN_TRIGGERED", { jobId: job.id, source: "hotkey" });
      }
      rescanJob(job.id)
        .then((r) => {
          console.info("RESCAN_OK", { jobId: job.id, retry_count: r.retry_count });
          setNotice({ level: "success", text: `Rescan queued (retry ${r.retry_count})` });
        })
        .catch((err) => {
          console.error("RESCAN_FAILED", err);
          setNotice({ level: "error", text: err instanceof Error ? err.message : "Rescan failed" });
        })
        .finally(() => setTimeout(() => setRescanPending(false), 400));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [job?.id, rescanPending, logDebug]);

  const [canonOpen, setCanonOpen] = useState(false);
  const [notice, setNotice] = useState<{ level: "info" | "success" | "error"; text: string } | null>(null);

  // CDN status (read-only - publish happens automatically on Accept)
  const cdnImageUrl = evidence?.inventory?.cdn_image_url ?? null;
  const cdnPublishedAt = evidence?.inventory?.cdn_published_at ?? null;

  // Promote to Shop state (EverShop sync)
  const [shopPromotePending, setShopPromotePending] = useState(false);
  const [shopPromoteConfirmOpen, setShopPromoteConfirmOpen] = useState(false);
  const evershopSyncState = job?.evershop_sync_state ?? "not_synced";
  const stagingReady = job?.staging_ready ?? false;

  // Auto-dismiss notices after 5 seconds
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Promote to Shop handler (EverShop sync)
  const handlePromoteToShop = async () => {
    if (!productUid || shopPromotePending) return;

    setShopPromoteConfirmOpen(false);
    setShopPromotePending(true);

    try {
      const result = await promoteProducts([productUid]);
      const productResult = result.results[0];

      if (productResult?.success) {
        setNotice({
          level: "success",
          text: `Promoted to shop (${productResult.evershop_sync_state ?? "vault_only"})`
        });
        refreshEvidence();
      } else {
        setNotice({
          level: "error",
          text: productResult?.error ?? "Promotion failed"
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Promotion failed";
      setNotice({ level: "error", text: message });
    } finally {
      setShopPromotePending(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", position: "relative" }}>
      {/* Tab Navigation */}
      <div
        style={{
          display: "flex",
          borderBottom: "2px solid #e5e7eb",
          backgroundColor: "#f9fafb",
          padding: "0 1rem",
        }}
      >
        <button
          onClick={() => setActiveTab("auto")}
          style={{
            padding: "0.75rem 1.5rem",
            border: "none",
            backgroundColor: "transparent",
            cursor: "pointer",
            fontWeight: activeTab === "auto" ? "600" : "400",
            color: activeTab === "auto" ? "#1f2937" : "#6b7280",
            borderBottom: activeTab === "auto" ? "3px solid #3b82f6" : "3px solid transparent",
            marginBottom: "-2px",
            transition: "all 0.2s ease",
          }}
        >
          Auto
        </button>
        <button
          onClick={() => setActiveTab("manual")}
          style={{
            padding: "0.75rem 1.5rem",
            border: "none",
            backgroundColor: "transparent",
            cursor: "pointer",
            fontWeight: activeTab === "manual" ? "600" : "400",
            color: activeTab === "manual" ? "#1f2937" : "#6b7280",
            borderBottom: activeTab === "manual" ? "3px solid #3b82f6" : "3px solid transparent",
            marginBottom: "-2px",
            transition: "all 0.2s ease",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          Manual
          {(hasValidEdits || hasInvalidEdits) && (
            <span
              style={{
                fontSize: "0.625rem",
                padding: "0.125rem 0.5rem",
                borderRadius: "9999px",
                backgroundColor: hasInvalidEdits ? "#fecaca" : "#dbeafe",
                color: hasInvalidEdits ? "#991b1b" : "#1e40af",
                fontWeight: "500",
              }}
            >
              {hasInvalidEdits ? "Invalid" : "Unsaved"}
            </span>
          )}
        </button>
      </div>

      {/* Operator Actions (stubs) — shown under tabs */}
      {(!!notice || previewConfidence != null || (previewTitle && previewTitle.length > 0)) && (
        <div style={{ padding: "4px 10px", display: "flex", alignItems: "center", gap: 8 }}>
          {!!notice && (
            <span
              className="pill"
              style={{
                background: notice.level === "error" ? "#fecaca" : notice.level === "success" ? "#dcfce7" : "#dbeafe",
                color: notice.level === "error" ? "#991b1b" : notice.level === "success" ? "#166534" : "#1e40af",
                borderColor: "transparent",
                fontSize: 12,
              }}
            >
              {notice.text}
            </span>
          )}
          {previewTitle && (
            <span
              className="pill"
              title={previewTitle}
              style={{
                fontSize: 11,
                borderColor: "transparent",
                background: "#eef2ff",
                color: "#3730a3",
                maxWidth: 300,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              Title: {previewTitle}
            </span>
          )}
          {previewConfidence != null && (
            <span
              className="pill"
              title="PPT preview confidence"
              style={{
                fontSize: 11,
                borderColor: "transparent",
                background:
                  previewConfidence >= 0.8
                    ? "#22c55e22"
                    : previewConfidence >= 0.6
                      ? "#f59e0b22"
                      : "#ef444422",
                color:
                  previewConfidence >= 0.8
                    ? "#16a34a"
                    : previewConfidence >= 0.6
                      ? "#d97706"
                      : "#dc2626",
              }}
            >
              PPT conf: {Math.round(previewConfidence * 100)}%
            </span>
          )}
        </div>
      )}
      {/* Compact Operator Actions Toolbar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        flexWrap: "wrap",
        borderBottom: "1px solid #e5e7eb",
        background: "#fafafa",
      }}>
        {/* Status indicators row */}
        <span
          className="pill"
          style={{
            background: isUnknown ? "#fecaca" : "#dcfce7",
            color: isUnknown ? "#991b1b" : "#166534",
            borderColor: "transparent",
            fontSize: 11,
          }}
          title={isUnknown ? "Canonical ID not resolved" : "Canonical ID resolved"}
        >
          {isUnknown ? "UNKNOWN" : "✓ Canon"}
        </span>
        {pptApplied !== null && (
          <span
            className="pill"
            style={{
              background: pptApplied ? "#dbeafe" : "#f3f4f6",
              color: pptApplied ? "#1d4ed8" : "#4b5563",
              borderColor: "transparent",
              fontSize: 11,
            }}
            title={pptApplied ? "PPT enrichment applied" : "PPT enrichment pending"}
          >
            {pptApplied ? "✓ PPT" : "○ PPT"}
          </span>
        )}
        {cdnImageUrl && (
          <span
            className="pill"
            style={{
              background: "#dcfce7",
              color: "#166534",
              borderColor: "transparent",
              fontSize: 11,
            }}
            title={cdnPublishedAt ? `Published ${new Date(cdnPublishedAt).toLocaleString()}` : "Published to CDN"}
          >
            ✓ CDN
          </span>
        )}
        {evershopSyncState && evershopSyncState !== "not_synced" && (
          <span
            className="pill"
            style={{
              background:
                evershopSyncState === "evershop_live" ? "#dcfce7" :
                evershopSyncState === "evershop_hidden" ? "#dbeafe" :
                evershopSyncState === "vault_only" ? "#fef3c7" :
                evershopSyncState === "sync_error" ? "#fecaca" : "#f3f4f6",
              color:
                evershopSyncState === "evershop_live" ? "#166534" :
                evershopSyncState === "evershop_hidden" ? "#1d4ed8" :
                evershopSyncState === "vault_only" ? "#92400e" :
                evershopSyncState === "sync_error" ? "#991b1b" : "#6b7280",
              borderColor: "transparent",
              fontSize: 11,
            }}
            title={`Shop sync: ${evershopSyncState}`}
          >
            {evershopSyncState === "evershop_live" ? "LIVE" :
             evershopSyncState === "evershop_hidden" ? "Hidden" :
             evershopSyncState === "vault_only" ? "Vault" :
             evershopSyncState === "sync_error" ? "Err" : evershopSyncState.slice(0, 6)}
          </span>
        )}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Action buttons - compact */}
        <button
          className="btn"
          disabled={!canCanonicalize}
          title={canonicalizeTitle}
          onClick={() => setCanonOpen(true)}
          style={{ fontSize: 11, padding: "4px 8px" }}
        >
          Canonicalize
        </button>
        <button
          className="btn"
          disabled={
            pptLoading || enriching || isUnknown ||
            (Boolean(productUid && !isUnknown) && !pptReadyForEnrichment)
          }
          title={
            isUnknown
              ? "Canonicalize first"
              : Boolean(productUid && !isUnknown) && !pptReadyForEnrichment
                ? "Pricing fresh or quota exceeded"
                : "Fetch PPT pricing"
          }
          onClick={async () => {
            setEnriching(true);
            try {
              if (productUid && !isUnknown) {
                const res = await enrichWithPPT(productUid);
                console.info("PPT_ENRICH_OK", { product_uid: productUid, res });
                const resSignals: any = (res as any)?.enrichment_signals ?? null;
                const resParseRequest = res.parse_title_request ?? (resSignals?.parseTitle?.requestedTitle ?? null);
                updatePptContext(resSignals, {
                  strategy: (res as any)?.enrichment_strategy ?? resSignals?.lookupStrategy ?? null,
                  bridgeId: (res as any)?.pricecharting_bridge_id ?? null,
                  parseTitleRequest: resParseRequest,
                });
                if (resSignals) {
                  const immediateGuess = derivePptBestGuess(resSignals, resParseRequest ?? null);
                  if (immediateGuess) setPptBestGuess(immediateGuess);
                }
                if (res.quota) {
                  setPptDailyLimit(res.quota.dailyLimit ?? null);
                  setPptDailyRemaining(res.quota.dailyRemaining ?? null);
                }
                setPptApplied(
                  typeof res.pricing_status === "string" &&
                  res.pricing_status.toLowerCase() !== "missing"
                );
                setNotice({ level: "success", text: res.staging_ready ? "Priced & staged" : "Pricing updated" });
                try {
                  window.dispatchEvent(new CustomEvent("cardmint:pptQuotaUpdate", { detail: { quota: res.quota ?? null } }));
                } catch { /* no-op */ }
                refreshEvidence();
                try {
                  const quote = await fetchPPTQuote(productUid);
                  setPptReadyForEnrichment(quote.ready_for_enrichment ?? false);
                  const quoteMarketPrice = (quote as { market_price?: unknown }).market_price;
                  setPptQuoteMarketPrice(typeof quoteMarketPrice === "number" ? quoteMarketPrice : null);
                  if (quote.quota) {
                    setPptDailyLimit(quote.quota.dailyLimit ?? null);
                    setPptDailyRemaining(quote.quota.dailyRemaining ?? null);
                    try { window.dispatchEvent(new CustomEvent("cardmint:pptQuotaUpdate", { detail: { quota: quote.quota } })); } catch { /* no-op */ }
                  }
                } catch (e) { console.warn("Failed to refresh PPT quote after enrich:", e); }
              } else {
                if (!job?.id) throw new Error("No job to preview");
                const preview = await (await import("../api/client")).previewPPT({ scan_id: job.id });
                console.info("PPT_PREVIEW_OK", { jobId: job.id, preview });
                if (preview.result?.quotaStatus) {
                  setPptDailyLimit(preview.result.quotaStatus.dailyLimit ?? null);
                  setPptDailyRemaining(preview.result.quotaStatus.dailyRemaining ?? null);
                }
                const price = preview.result?.priceData?.market_price ?? null;
                setNotice({ level: price != null ? "success" : "info", text: price != null ? `Preview: ${price}` : "No price" });
                const signals: any = (preview.result?.priceData as any)?.enrichment_signals ?? null;
                const conf = signals?.parseTitle?.confidence;
                setPreviewConfidence(typeof conf === "number" && isFinite(conf) ? conf : null);
                const parsed = signals?.parseTitle?.parsed;
                const requested = signals?.parseTitle?.requestedTitle;
                const displayTitle = typeof parsed === "string" ? parsed : (parsed && typeof parsed === "object" && (parsed.title || parsed.normalized)) || (typeof requested === "string" ? requested : null);
                setPreviewTitle(displayTitle ?? null);
                setPptBestGuess(signals ? derivePptBestGuess(signals, displayTitle ?? null) : null);
                updatePptContext(signals, { strategy: signals?.lookupStrategy ?? "parse_title", parseTitleRequest: typeof requested === "string" ? requested : displayTitle });
                try { window.dispatchEvent(new CustomEvent("cardmint:pptQuotaUpdate", { detail: { quota: preview.result?.quotaStatus ?? null } })); } catch { /* no-op */ }
              }
            } catch (err) {
              console.error("PPT_ENRICH_OR_PREVIEW_FAILED", err);
              setNotice({ level: "error", text: err instanceof Error ? err.message : "PPT failed" });
            } finally {
              setEnriching(false);
            }
          }}
          style={{ fontSize: 11, padding: "4px 8px" }}
        >
          {enriching ? "…" : "PPT"}
        </button>
        <button
          className="btn"
          disabled={!job?.id || rescanPending}
          title={job?.id ? "Rescan (R)" : "No job"}
          onClick={() => {
            if (!job?.id || rescanPending) return;
            setRescanPending(true);
            rescanJob(job.id)
              .then((r) => {
                console.info("RESCAN_OK", { jobId: job.id, retry_count: r.retry_count });
                setNotice({ level: "success", text: `Rescan #${r.retry_count}` });
              })
              .catch((err) => {
                console.error("RESCAN_FAILED", err);
                setNotice({ level: "error", text: err instanceof Error ? err.message : "Rescan failed" });
              })
              .finally(() => setTimeout(() => setRescanPending(false), 400));
          }}
          style={{ fontSize: 11, padding: "4px 8px" }}
        >
          R
        </button>
        {stagingReady && productUid && !isUnknown && evershopSyncState === "not_synced" && (
          <button
            className="btn primary"
            disabled={shopPromotePending || !pptApplied}
            title={!pptApplied ? "PPT first" : "Promote to shop"}
            onClick={() => setShopPromoteConfirmOpen(true)}
            style={{ fontSize: 11, padding: "4px 10px" }}
          >
            {shopPromotePending ? "…" : "→ Shop"}
          </button>
        )}

        {/* Quota + Debug toggle */}
        <span className="pill" title={pptError ?? "PPT quota"} style={{ fontSize: 10 }}>
          {pptDailyRemaining ?? "—"}/{pptDailyLimit ?? "—"}
        </span>
        {DEBUG_PANEL_ENABLED && (
          <button
            className="btn"
            type="button"
            onClick={() => setDebugOpen((open) => !open)}
            style={{ fontSize: 10, padding: "3px 6px" }}
          >
            {debugOpen ? "▼" : "▶"}
          </button>
        )}
      </div>

      {/* Canonical suggestion hint (only when relevant) */}
      {(canonSuggestionStatus === "loading" || (canonSuggestionStatus === "ready" && canonSuggestion) || canonSuggestionStatus === "error") && (
        <div style={{ padding: "4px 10px", fontSize: 11, color: "var(--muted)", borderBottom: "1px solid #f0f0f0" }}>
          {canonSuggestionStatus === "loading" && "Generating canonical ID…"}
          {canonSuggestionStatus === "ready" && canonSuggestion && <>Suggested: <code style={{ background: "#f3f4f6", padding: "1px 4px", borderRadius: 3 }}>{canonSuggestion}</code></>}
          {canonSuggestionStatus === "error" && <span style={{ color: "#b45309" }}>{canonSuggestionError ?? "Suggestion failed"}</span>}
        </div>
      )}

      {/* Tab Content */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {activeTab === "auto" ? (
          <>
            <RightPaneEvidence
              job={job}
              evidence={evidence}
              loading={loading}
              chosen={chosen}
              setChosen={setChosen}
              onAccept={onAccept}
              onFlag={onFlag}
              featureEnabled={featureEnabled}
              setSelectionSource={setSelectionSource}
              setVariantTelemetry={setVariantTelemetry}
              setSelectedExpandedVariantId={setSelectedExpandedVariantId}
              pptBestGuess={pptBestGuess}
              pptEnrichmentContext={pptEnrichmentContext}
              refreshEvidence={refreshEvidence}
              refreshJob={refreshJob}
              condition={condition}
              setCondition={setCondition}
              onBaselineAccepted={onBaselineAccepted}
            />
            {DEBUG_PANEL_ENABLED && debugOpen && (
              <RightPaneDebugPanel
                job={job}
                evidence={evidence}
                variantTelemetry={variantTelemetry}
                localCanonicalId={localCanonicalId}
                isUnknown={isUnknown}
                productUid={productUid}
                canonSuggestion={canonSuggestion}
                canonSuggestionStatus={canonSuggestionStatus}
                canonSuggestionError={canonSuggestionError}
                pptBestGuess={pptBestGuess}
                pptEnrichmentContext={pptEnrichmentContext}
                events={debugEvents}
                onClearEvents={() => setDebugEvents([])}
              />
            )}
          </>
        ) : (
          <ManualEditor
            job={job}
            onAccept={onAccept}
            onFlag={onFlag}
            onValidityChange={handleValidityChange}
            condition={condition}
            setCondition={setCondition}
          />
        )}
      </div>

      {/* Canonicalization Drawer */}
      {canonOpen && job?.id && (
        <CanonicalizationDrawer
          scanId={job.id}
          isOpen={canonOpen}
          currentCmCardId={localCanonicalId ?? evidence?.inventory?.cm_card_id ?? null}
          initialValue={canonSuggestion ?? undefined}
          onClose={() => setCanonOpen(false)}
          onSuccess={(newId) => {
            setLocalCanonicalId(newId);
            void refreshEvidence?.();
            setNotice({ level: "success", text: "Canonicalization saved" });
          }}
        />
      )}

      {/* Promote to Shop Confirmation Modal */}
      {shopPromoteConfirmOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "grid",
            placeItems: "center",
            zIndex: 1000,
          }}
          onClick={() => setShopPromoteConfirmOpen(false)}
        >
          <div
            style={{
              background: "var(--bg)",
              border: "2px solid var(--accent)",
              borderRadius: 8,
              padding: 24,
              maxWidth: 500,
              width: "90%",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, fontSize: 18, marginBottom: 16 }}>
              Promote to Shop
            </div>
            <div style={{ marginBottom: 16, fontSize: 14, color: "var(--muted)" }}>
              <p>This will push the product to production:</p>
              <ul style={{ marginLeft: 20, marginTop: 8 }}>
                <li>Write to production SQLite database</li>
                <li>Create/update product in EverShop PostgreSQL</li>
                <li>Product will be hidden in shop by default</li>
              </ul>
              <p style={{ marginTop: 12 }}>
                <strong>Product:</strong> {evidence?.modelVerdict?.productName ?? job?.card_name ?? "—"}
                <br />
                <strong>SKU:</strong> {evidence?.inventory?.product_sku ?? "—"}
                <br />
                <strong>Price:</strong> ${typeof pptQuoteMarketPrice === "number" ? pptQuoteMarketPrice.toFixed(2) : "—"}
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                className="btn"
                onClick={() => setShopPromoteConfirmOpen(false)}
                disabled={shopPromotePending}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={handlePromoteToShop}
                disabled={shopPromotePending}
              >
                {shopPromotePending ? "Promoting…" : "Confirm Promotion"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    const iso = d.toISOString();
    return iso.split("T")[1]?.replace("Z", "") ?? ts;
  } catch {
    return ts;
  }
}

interface RightPaneDebugPanelProps {
  job: Job | null;
  evidence: Evidence | null;
  variantTelemetry: Record<string, any>;
  localCanonicalId: string | null;
  isUnknown: boolean;
  productUid: string | null;
  canonSuggestion: string | null;
  canonSuggestionStatus: "idle" | "loading" | "ready" | "error";
  canonSuggestionError: string | null;
  pptBestGuess: PPTBestGuess | null;
  pptEnrichmentContext: PPTEnrichmentContext | null;
  events: DebugEvent[];
  onClearEvents: () => void;
}

const RightPaneDebugPanel: React.FC<RightPaneDebugPanelProps> = ({
  job,
  evidence,
  variantTelemetry,
  localCanonicalId,
  isUnknown,
  productUid,
  canonSuggestion,
  canonSuggestionStatus,
  canonSuggestionError,
  pptBestGuess,
  pptEnrichmentContext,
  events,
  onClearEvents,
}) => {
  const jobSummary = job
    ? {
      id: job.id,
      status: job.status,
      card_name: job.card_name,
      set_number: job.set_number,
      set_name: job.set_name,
    }
    : null;

  const snapshot = {
    job: jobSummary,
    canonicalization: {
      localCanonicalId,
      isUnknown,
      suggestion: canonSuggestion,
      status: canonSuggestionStatus,
      error: canonSuggestionError,
      truth_core: variantTelemetry?.truth_core ?? null,
      truth_verified: variantTelemetry?.truth_verified ?? null,
      truth_valid: variantTelemetry?.truth_valid ?? null,
    },
    ppt: {
      productUid,
      bestGuess: pptBestGuess,
      context: pptEnrichmentContext,
    },
    evidence: evidence
      ? {
        status: evidence.status,
        inventory_cm_card_id: (evidence as any)?.inventory?.cm_card_id ?? null,
      }
      : null,
  };

  return (
    <div
      className="panel"
      style={{
        margin: "8px 10px",
        padding: 10,
        border: "1px solid #e5e7eb",
        borderRadius: 6,
        background: "#f9fafb",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600 }}>Debug — Right Pane Telemetry</div>
        <button
          type="button"
          className="btn"
          onClick={onClearEvents}
          style={{ fontSize: 10, padding: "2px 6px" }}
        >
          Clear log
        </button>
      </div>

      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1.1fr 1fr", alignItems: "start" }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Snapshot</div>
          <pre
            style={{
              maxHeight: 220,
              overflow: "auto",
              fontSize: 10,
              background: "#111827",
              color: "#e5e7eb",
              padding: 8,
              borderRadius: 4,
            }}
          >
            {JSON.stringify(snapshot, null, 2)}
          </pre>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Event log</div>
          <div
            style={{
              maxHeight: 220,
              overflow: "auto",
              border: "1px solid #e5e7eb",
              borderRadius: 4,
              background: "#ffffff",
              padding: 6,
            }}
          >
            {events.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--muted)" }}>No debug events yet.</div>
            ) : (
              events.map((ev) => (
                <div
                  key={ev.id}
                  style={{
                    borderBottom: "1px solid #e5e7eb",
                    padding: "4px 0",
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      fontFamily: "var(--mono)",
                      marginBottom: 2,
                    }}
                  >
                    [{formatTime(ev.ts)}] {ev.type}
                  </div>
                  <pre
                    style={{
                      fontSize: 10,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      background: "#f3f4f6",
                      padding: 4,
                      borderRadius: 3,
                    }}
                  >
                    {JSON.stringify(ev.payload, null, 2)}
                  </pre>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default RightPaneTabs;
