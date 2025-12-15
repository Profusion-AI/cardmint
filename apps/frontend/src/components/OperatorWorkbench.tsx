import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchMetrics, listRecentJobsAdapted, fetchJobById, patchJob, triggerCapture, uploadImage, fetchEvidence, recordOperatorFirstView, type Evidence, lockFrontImage, captureBackForScan, lockCanonical, saveTruthCore } from "../api/client";
import type { Job } from "../api/adapters";
import SessionHeader from "./SessionHeader";
import SessionTimeline from "./SessionTimeline";
import { useSession } from "../hooks/useSession";
import { useAudioFeedback } from "../hooks/useAudioFeedback";
import { useStagedEdits } from "../hooks/useStagedEdits";
import RightPaneTabs from "./RightPaneTabs";
import { QuotaChip } from "./QuotaChip";
import { ManualOverrideDrawer } from "./ManualOverrideDrawer";
import AnalyticsPanel from "./AnalyticsPanel";

const WARN_THRESHOLD = 11;
const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://127.0.0.1:4000/ws";
const METRICS_POLL_MS = 15000;
const JOB_REFRESH_MS = 5000; // Reduced from 60s for responsive placeholder updates
const RETRIEVAL_HEALTH_POLL_MS = 4000; // Evidence readiness polling cadence
const EVIDENCE_UI_ENABLED = (() => {
  const raw = import.meta.env.VITE_FEATURE_EVIDENCE_UI;
  if (raw == null) return true;
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
})();

type JobStatus =
  | "QUEUED"
  | "CAPTURING"
  | "CAPTURED"
  | "PREPROCESSING"
  | "INFERENCING"
  | "CANDIDATES_READY"
  | "OPERATOR_PENDING"
  | "UNMATCHED_NO_REASONABLE_CANDIDATE"
  | "ACCEPTED"
  | "FLAGGED"
  | "NEEDS_REVIEW"
  | "FAILED";

type ToastLevel = "info" | "success" | "warning" | "error";

interface MetricsState {
  queueDepth: number;
  backendUp: boolean;
  warning: boolean;
  p50?: number;
  p95?: number;
}

interface Toast {
  id: number;
  title: string;
  body?: string;
  level: ToastLevel;
}

// ============================================================================
// HMR-safe state persistence
// ============================================================================

function usePersistedState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore quota */
    }
  }, [key, value]);

  return [value, setValue];
}

// ============================================================================
// Optional WebSocket hook (degrades to polling)
// ============================================================================

type WsStatus = "connecting" | "up" | "down" | "reconnecting";

function useWs<T = any>(url: string | null, onMsg: (d: T) => void) {
  const [status, setStatus] = useState<WsStatus>("connecting");
  const backoff = useRef(600);
  const seqSeen = useRef<Set<number>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!url) {
      setStatus("down");
      return;
    }

    let closed = false;
    const connect = () => {
      setStatus(wsRef.current ? "reconnecting" : "connecting");
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("up");
        backoff.current = 600;
      };

      ws.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          // Optional idempotency via numeric 'seq'
          const seq = typeof payload.seq === "number" ? payload.seq : undefined;
          if (seq != null) {
            if (seqSeen.current.has(seq)) return;
            seqSeen.current.add(seq);
            if (seqSeen.current.size > 1000) {
              const first = [...seqSeen.current][0];
              seqSeen.current.delete(first);
            }
          }
          onMsg(payload as T);
        } catch {
          /* ignore parse errors */
        }
      };

      ws.onclose = () => {
        if (closed) return;
        setStatus("down");
        setTimeout(connect, Math.min(5000, backoff.current));
        backoff.current = Math.min(5000, backoff.current * 1.5);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();
    return () => {
      closed = true;
      wsRef.current?.close();
    };
  }, [url, onMsg]);

  return { status };
}

// ============================================================================
// Main Component
// ============================================================================

const WorkbenchInner: React.FC = () => {
  const sessionState = useSession();
  const { play: playSound } = useAudioFeedback();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = usePersistedState<string | undefined>("op.selected", undefined);
  const [chosen, setChosen] = usePersistedState<number | null>("op.chosen", 0);
  const [search, setSearch] = usePersistedState("workbench.search", "");
  const [statusFilter, setStatusFilter] = usePersistedState<"all" | "pending" | "unmatched" | "flagged" | "accepted" | "errors">(
    "workbench.filter",
    "pending"
  );
  const [zoom, setZoom] = usePersistedState("workbench.zoom", 1);
  const [pan, setPan] = usePersistedState("workbench.pan", { x: 0, y: 0 });
  const [rotation, setRotation] = usePersistedState("workbench.rotation", 0);
  const [ingestMode, setIngestMode] = usePersistedState<"capture" | "upload">(
    "workbench.ingestMode",
    "capture"
  );
  const [leftTab, setLeftTab] = usePersistedState<"jobs" | "sessions" | "analytics">(
    "workbench.leftTab",
    "jobs"
  );

  // Right pane layout controls (resizable with gentle auto-fit)
  const gridRef = useRef<HTMLDivElement | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const [rightPaneWidth, setRightPaneWidth] = usePersistedState<number>(
    "workbench.rightPaneWidth",
    380
  );
  const [userResizedRightPane, setUserResizedRightPane] = usePersistedState<boolean>(
    "workbench.rightPaneUserResized",
    false
  );
  const RIGHT_MIN = 320;
  const RIGHT_MAX = 680;
  const RESIZER_WIDTH = 6;

  // Variant disambiguation telemetry (T6/T7)
  const [selectionSource, setSelectionSource] = useState<"top3" | "expanded_family" | "manual_tab">("top3");
  const [variantTelemetry, setVariantTelemetry] = useState<Record<string, any>>({});
  const [selectedExpandedVariantId, setSelectedExpandedVariantId] = useState<string | null>(null);

  // Condition selection for Accept (Stage 2 inventory creation)
  const [condition, setCondition] = useState<string>("UNKNOWN");

  // Manual override drawer state (Phase 5)
  const [manualOverrideOpen, setManualOverrideOpen] = useState(false);
  const [manualOverrideScanId, setManualOverrideScanId] = useState<string | null>(null);

  // Manual editor validity state (Phase 6)
  const [hasValidManualEdits, setHasValidManualEdits] = useState(false);
  const [hasInvalidManualEdits, setHasInvalidManualEdits] = useState(false);

  type AcceptMacroPhase =
    | "idle"
    | "locking_front"
    | "countdown"
    | "capturing_back"
    | "waiting_back"
    | "locking_identity"
    | "accepting"
    | "error";

  const [acceptMacro, setAcceptMacro] = useState<{ phase: AcceptMacroPhase; countdown_s?: number; message?: string }>(
    { phase: "idle" },
  );

  // Session-level back-capture countdown (operator-adjustable mid-session)
  const [backCaptureDelayMs, setBackCaptureDelayMs] = useState<number>(3500);

  useEffect(() => {
    const sessionId = sessionState.session?.id;
    if (!sessionId) {
      setBackCaptureDelayMs(3500);
      return;
    }
    try {
      const raw = sessionStorage.getItem(`cm_back_capture_delay_ms_${sessionId}`);
      const parsed = raw ? Number(raw) : NaN;
      if (!Number.isNaN(parsed) && parsed > 0) {
        setBackCaptureDelayMs(parsed);
      } else {
        setBackCaptureDelayMs(3500);
      }
    } catch {
      setBackCaptureDelayMs(3500);
    }
  }, [sessionState.session?.id]);

  useEffect(() => {
    const sessionId = sessionState.session?.id;
    if (!sessionId) return;
    try {
      sessionStorage.setItem(`cm_back_capture_delay_ms_${sessionId}`, String(backCaptureDelayMs));
    } catch {
      /* ignore quota */
    }
  }, [sessionState.session?.id, backCaptureDelayMs]);
  // Use selectedId here to avoid referencing selectedJob before its declaration
  const { edits: stagedOverrides, isValid: stagedIsValid, clearEdits: clearStagedEdits } = useStagedEdits(selectedId ?? null);

  // Evidence state (ETag-cached per job - stores full quoted ETag header)
  const [evidenceCache, setEvidenceCache] = useState<Map<string, { evidence: Evidence; etagHeader: string }>>(
    new Map()
  );
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const lastEvidenceFetchKey = useRef<string | null>(null);

  const [metrics, setMetrics] = useState<MetricsState>({
    queueDepth: 0,
    backendUp: true,
    warning: false,
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [wsState, setWsState] = useState<WsStatus>("connecting");
  const backendWasUp = useRef(true);
  const wsWasUp = useRef(false);

  // Retrieval/Evidence readiness gate (operator UI holds actions until ready)
  const [evidenceReady, setEvidenceReady] = useState<boolean | null>(false);
  const [retrievalHash, setRetrievalHash] = useState<string | null>(null);

  const checkRetrievalHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health/retrieval");
      if (!res.ok) throw new Error(String(res.status));
      const data: { corpusReady: boolean; corpusHash: string | null } = await res.json();
      setEvidenceReady(data.corpusReady);
      setRetrievalHash(data.corpusHash);
      return data.corpusReady;
    } catch {
      setEvidenceReady(false);
      setRetrievalHash(null);
      return false;
    }
  }, []);

  // Poll retrieval health until ready (silent; UI shows subtle banner)
  useEffect(() => {
    let cancel = false;
    let iv: number | null = null;
    const boot = async () => {
      const ready = await checkRetrievalHealth();
      if (cancel) return;
      if (!ready) {
        iv = window.setInterval(async () => {
          const ok = await checkRetrievalHealth();
          if (cancel) return;
          if (ok && iv) {
            window.clearInterval(iv);
            iv = null;
          }
        }, RETRIEVAL_HEALTH_POLL_MS);
      }
    };
    void boot();
    return () => {
      cancel = true;
      if (iv) window.clearInterval(iv);
    };
  }, [checkRetrievalHealth]);

  const pushToast = useCallback((level: ToastLevel, title: string, body?: string) => {
    setToasts((prev) => {
      const id = Date.now() + Math.random();
      const next = [...prev, { id, title, body, level }];
      setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 3500);
      return next.slice(-4);
    });
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const r = await listRecentJobsAdapted();
      const nextJobs = r ?? [];
      setJobs(nextJobs);
      setSelectedId((current) => {
        if (current && nextJobs.some((job) => job.id === current)) {
          return current;
        }
        return nextJobs[0]?.id ?? undefined;
      });
    } catch (error) {
      pushToast(
        "error",
        "Failed to refresh jobs",
        error instanceof Error ? error.message : undefined
      );
    }
  }, [pushToast, setSelectedId]);

  // Polling: metrics + jobs
  useEffect(() => {
    let cancel = false;

    const pollMetrics = async () => {
      try {
        const m = await fetchMetrics();
        if (!cancel) {
          setMetrics({
            queueDepth: m.queueDepth,
            backendUp: true,
            warning: m.queueDepth >= WARN_THRESHOLD,
            p50: m.histograms?.inference_latency_ms?.p50,
            p95: m.histograms?.inference_latency_ms?.p95,
          });

          if (!backendWasUp.current) {
            pushToast("success", "Backend reconnected");
          }
          backendWasUp.current = true;
        }
      } catch {
        if (!cancel) {
          setMetrics((prev) => ({ ...prev, backendUp: false }));
          if (backendWasUp.current) {
            pushToast("error", "Backend offline");
          }
          backendWasUp.current = false;
        }
      }
    };

    const pollJobs = async () => {
      try {
        const r = await listRecentJobsAdapted();
        if (!cancel) {
          const nextJobs = r ?? [];
          setJobs(nextJobs);
          setSelectedId((current) => {
            if (current && nextJobs.some((job) => job.id === current)) {
              return current;
            }
            return nextJobs[0]?.id ?? undefined;
          });
        }
      } catch {
        // Silent failure - backend unreachable
      }
    };

    pollMetrics();
    pollJobs();
    const metricsIv = setInterval(pollMetrics, METRICS_POLL_MS);
    const jobsIv = setInterval(pollJobs, JOB_REFRESH_MS);

    return () => {
      cancel = true;
      clearInterval(metricsIv);
      clearInterval(jobsIv);
    };
  }, [pushToast, setSelectedId]);

  // Optional WebSocket feed
  const onMsg = useCallback(
    (e: any) => {
      if (e.type === "queue") {
        setMetrics((prev) => ({
          ...prev,
          queueDepth: e.depth,
          warning: e.depth >= WARN_THRESHOLD,
          p50: e.p50 ?? prev.p50,
          p95: e.p95 ?? prev.p95,
        }));
      }
      if (e.type === "job.updated") {
        setJobs((prev) => {
          const i = prev.findIndex((x) => x.id === e.job.id);
          const existing = i >= 0 ? prev[i] : null;
          // Preserve all fields from existing job, only update what WS provides
          const next: Job = {
            // Start with existing job data (preserves session_id and RFC fields)
            ...(existing || {}),
            // Update with WebSocket payload
            id: e.job.id,
            status: e.job.status,
            card_name: e.job.name,
            created_at: e.job.createdAt,
            updated_at: e.job.updatedAt,
            hp_value: e.job.hp,
            set_number: e.job.setNumber,
            image_path: e.job.imageUrl,
            candidates: e.job.topCandidates?.map((c: any) => ({
              title: c.name,
              confidence: c.confidence,
              source: c.source,
              // Preserve RFC-forward-compatible fields if present
              autoConfirm: c.autoConfirm,
              enrichmentSignals: c.enrichmentSignals,
            })),
            timings: e.job.timings ? {
              capture_ms: e.job.timings.capture_ms,
              preprocess_ms: e.job.timings.preprocess_ms,
              inference_ms: e.job.timings.inference_ms ?? e.job.timings.infer_ms,
              e2e_ms: e.job.timings.e2e_ms ?? e.job.timings.end_to_end_ms,
            } : existing?.timings,
            // Stage 1 lifecycle flags (Nov 19, 2025)
            // Support both camelCase (typical JS) and snake_case (backend DB)
            front_locked: e.job.frontLocked ?? e.job.front_locked ?? existing?.front_locked,
            back_ready: e.job.backReady ?? e.job.back_ready ?? existing?.back_ready,
            canonical_locked: e.job.canonicalLocked ?? e.job.canonical_locked ?? existing?.canonical_locked,
          };
          if (i >= 0) {
            const cp = [...prev];
            cp[i] = next;
            return cp;
          }
          return [next, ...prev].slice(0, 100);
        });
      }
      if (e.type === "notification") {
        pushToast(e.level || "info", e.title || "Notice", e.body);
      }
    },
    [pushToast]
  );

  const wsUrl = import.meta.env.VITE_WS_URL ? WS_URL : null;
  const { status: wsStatus } = useWs(wsUrl, onMsg);

  useEffect(() => {
    setWsState(wsStatus);
    if (wsStatus === "up" && !wsWasUp.current) {
      pushToast("success", "Realtime connected");
    } else if (wsStatus === "down" && wsWasUp.current) {
      pushToast("warning", "Realtime lost", "Falling back to polling");
    }
    wsWasUp.current = wsStatus === "up";
  }, [wsStatus, pushToast]);

  // Filtered jobs
  const filteredJobs = useMemo(() => {
    let list = jobs;
    if (statusFilter === "pending") {
      // Show jobs awaiting operator action OR jobs with preview images available during pipeline
      list = list.filter((j) =>
        ["OPERATOR_PENDING", "CANDIDATES_READY", "UNMATCHED_NO_REASONABLE_CANDIDATE"].includes(j.status) ||
        (j.image_path && ["QUEUED", "CAPTURING", "PREPROCESSING", "INFERENCING"].includes(j.status))
      );
    } else if (statusFilter === "unmatched") {
      // Phase 5: Show unmatched jobs (status UNMATCHED or !staging_ready)
      list = list.filter((j) =>
        j.status === "UNMATCHED_NO_REASONABLE_CANDIDATE" ||
        (j.staging_ready === false && !["ACCEPTED", "FLAGGED"].includes(j.status))
      );
    } else if (statusFilter === "accepted") {
      list = list.filter((j) => j.status === "ACCEPTED");
    } else if (statusFilter === "flagged") {
      list = list.filter((j) => j.status === "FLAGGED");
    } else if (statusFilter === "errors") {
      list = list.filter((j) => ["FAILED", "NEEDS_REVIEW"].includes(j.status));
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((j) =>
        [j.card_name ?? "", j.set_number ?? "", j.status ?? "", j.id].some((v) =>
          v.toLowerCase().includes(q)
        )
      );
    }
    return list;
  }, [jobs, statusFilter, search]);

  const selectedJob = useMemo(
    () => (selectedId ? filteredJobs.find((j) => j.id === selectedId) : filteredJobs[0]) ?? null,
    [filteredJobs, selectedId]
  );

  const selectedJobId = selectedJob?.id ?? null;
  const selectedJobStatus = selectedJob?.status ? String(selectedJob.status) : "";
  const normalizedStatus = selectedJobStatus.trim().toUpperCase();
  // Fetch evidence not only for OPERATOR_PENDING but also when candidates are
  // ready, when the job is unmatched (operator still needs context), and after
  // acceptance (read-only review). This avoids falling back to the legacy right
  // pane when operators click into already-accepted items.
  const EVIDENCE_FETCH_STATUSES = new Set([
    "OPERATOR_PENDING",
    "CANDIDATES_READY",
    "UNMATCHED_NO_REASONABLE_CANDIDATE",
    "ACCEPTED",
  ] as const);
  const cachedEvidenceEntry = selectedJobId ? evidenceCache.get(selectedJobId) ?? null : null;
  const cachedEvidenceEtag = cachedEvidenceEntry?.etagHeader;
  const shouldFetchEvidence = Boolean(
    EVIDENCE_UI_ENABLED &&
    selectedJobId &&
    (normalizedStatus ? EVIDENCE_FETCH_STATUSES.has(normalizedStatus as any) : false)
  );

  // Force evidence refresh (bypasses dedup, used after operator actions like enrichment)
  const refreshEvidence = useCallback(() => {
    if (!selectedJobId || !shouldFetchEvidence) {
      console.info("EVIDENCE_REFRESH_SKIPPED", { selectedJobId, shouldFetchEvidence });
      return;
    }

    console.info("EVIDENCE_REFRESH_FORCE", { jobId: selectedJobId });
    // Clear dedup key to force fresh fetch
    lastEvidenceFetchKey.current = null;
    setEvidenceLoading(true);

    fetchEvidence(selectedJobId, undefined) // No etag → force full fetch
      .then((result) => {
        if (result === "not-modified") {
          // Shouldn't happen with no etag, but handle gracefully
          setEvidenceLoading(false);
          return;
        }

        setEvidenceCache((prev) => {
          const next = new Map(prev);
          next.set(selectedJobId, { evidence: result.evidence, etagHeader: result.etagHeader });
          return next;
        });
        lastEvidenceFetchKey.current = `${selectedJobId}|${result.etagHeader ?? "no-etag"}`;
        console.info("EVIDENCE_REFRESH_SUCCESS", { jobId: selectedJobId });
        setEvidenceLoading(false);
      })
      .catch((error) => {
        console.error("EVIDENCE_REFRESH_ERROR", {
          jobId: selectedJobId,
          message: error instanceof Error ? error.message : String(error),
        });
        pushToast("error", "Evidence refresh failed", error instanceof Error ? error.message : undefined);
        setEvidenceLoading(false);
        lastEvidenceFetchKey.current = null;
      });
  }, [selectedJobId, shouldFetchEvidence, pushToast]);

  // Refresh selected job from backend (used after truth core save/lock)
  const refreshSelectedJob = useCallback(async () => {
    if (!selectedJobId) return;
    try {
      const updated = await fetchJobById(selectedJobId);
      if (updated) {
        setJobs((prev) =>
          prev.map((j) => (j.id === selectedJobId ? updated : j))
        );
        console.info("JOB_REFRESH_SUCCESS", { jobId: selectedJobId });
      }
    } catch (error) {
      console.error("JOB_REFRESH_ERROR", {
        jobId: selectedJobId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [selectedJobId]);

  // Fetch evidence when a pending job is selected and evidence UI is enabled
  useEffect(() => {
    if (!selectedJobId) {
      lastEvidenceFetchKey.current = null;
      setEvidenceLoading(false);
      return;
    }

    if (!shouldFetchEvidence) {
      if (normalizedStatus) {
        console.info("EVIDENCE_FETCH_SKIPPED", {
          jobId: selectedJobId,
          status: normalizedStatus,
          featureEnabled: EVIDENCE_UI_ENABLED,
        });
      }
      lastEvidenceFetchKey.current = null;
      setEvidenceLoading(false);
      return;
    }

    const fetchKey = `${selectedJobId}|${cachedEvidenceEtag ?? "no-etag"}`;
    if (lastEvidenceFetchKey.current === fetchKey) {
      console.info("EVIDENCE_FETCH_DEDUP", {
        jobId: selectedJobId,
        status: normalizedStatus,
        featureEnabled: EVIDENCE_UI_ENABLED,
        cached: Boolean(cachedEvidenceEtag),
      });
      return;
    }

    console.info("EVIDENCE_FETCH_TRIGGER", {
      jobId: selectedJobId,
      status: normalizedStatus,
      featureEnabled: EVIDENCE_UI_ENABLED,
      cachedEtag: cachedEvidenceEtag ?? null,
    });
    lastEvidenceFetchKey.current = fetchKey;
    setEvidenceLoading(true);

    fetchEvidence(selectedJobId, cachedEvidenceEtag)
      .then((result) => {
        if (result === "not-modified") {
          console.info("EVIDENCE_FETCH_NOT_MODIFIED", {
            jobId: selectedJobId,
            status: normalizedStatus,
            featureEnabled: EVIDENCE_UI_ENABLED,
          });
          lastEvidenceFetchKey.current = `${selectedJobId}|${cachedEvidenceEtag ?? "no-etag"}`;
          setEvidenceLoading(false);
          return;
        }

        setEvidenceCache((prev) => {
          const next = new Map(prev);
          next.set(selectedJobId, { evidence: result.evidence, etagHeader: result.etagHeader });
          return next;
        });
        lastEvidenceFetchKey.current = `${selectedJobId}|${result.etagHeader ?? "no-etag"}`;
        console.info("EVIDENCE_FETCH_SUCCESS", {
          jobId: selectedJobId,
          status: normalizedStatus,
          featureEnabled: EVIDENCE_UI_ENABLED,
        });
        setEvidenceLoading(false);

        // Gentle auto-retry if evidence is currently UNAVAILABLE (e.g., corpus warming)
        // Schedule background re-fetches at 5s and 15s to swap in the Evidence UI silently.
        try {
          const status = result.evidence?.status as any;
          if (status === "UNAVAILABLE") {
            const schedule = (delayMs: number) =>
              window.setTimeout(() => {
                // Re-evaluate conditions and job selection before retrying
                if (!EVIDENCE_UI_ENABLED) return;
                if (!selectedJobId || lastEvidenceFetchKey.current == null) return;
                const stillSelected = selectedJobId === (selectedJob?.id ?? null);
                if (!stillSelected) return;

                fetchEvidence(selectedJobId, evidenceCache.get(selectedJobId)?.etagHeader)
                  .then((retry) => {
                    if (retry === "not-modified") return;
                    setEvidenceCache((prev) => {
                      const next = new Map(prev);
                      next.set(selectedJobId, { evidence: retry.evidence, etagHeader: retry.etagHeader });
                      return next;
                    });
                    lastEvidenceFetchKey.current = `${selectedJobId}|${retry.etagHeader ?? "no-etag"}`;
                  })
                  .catch(() => void 0);
              }, delayMs);

            schedule(5000);
            schedule(15000);
          }
        } catch {
          /* no-op */
        }
      })
      .catch((error) => {
        console.error("EVIDENCE_FETCH_ERROR", {
          jobId: selectedJobId,
          status: normalizedStatus,
          featureEnabled: EVIDENCE_UI_ENABLED,
          message: error instanceof Error ? error.message : String(error),
        });
        pushToast("error", "Evidence fetch failed", error instanceof Error ? error.message : undefined);
        setEvidenceLoading(false);
        lastEvidenceFetchKey.current = null;
      });
  }, [
    cachedEvidenceEtag,
    normalizedStatus,
    pushToast,
    selectedJobId,
    shouldFetchEvidence,
  ]);

  // Gentle auto-fit of right pane to content when not manually resized
  useEffect(() => {
    if (userResizedRightPane) return; // respect manual sizing
    const el = rightPaneRef.current;
    if (!el) return;
    // Expand if content overflows current width
    const needsMore = el.scrollWidth > el.clientWidth + 16;
    if (needsMore) {
      const desired = Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, el.scrollWidth + 24));
      if (Math.abs(desired - rightPaneWidth) >= 12) {
        setRightPaneWidth(desired);
      }
    }
    // Do not auto-shrink to avoid jarring changes while reading
  }, [
    evidenceLoading,
    selectedJob?.id,
    evidenceCache,
    userResizedRightPane,
    rightPaneWidth,
  ]);

  const candidateCount = selectedJob?.candidates?.length ?? 0;

  // Reset chosen candidate when job changes to avoid out-of-bounds indices
  useEffect(() => {
    if (candidateCount > 0 && (chosen === null || chosen >= candidateCount)) {
      setChosen(0);
    }
  }, [selectedJob?.id, candidateCount, chosen, setChosen]);

  // Reset variant telemetry and selection source when job changes
  useEffect(() => {
    setSelectionSource("top3");
    setVariantTelemetry({});
    setSelectedExpandedVariantId(null);
  }, [selectedJob?.id]);

  // Actions
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [capturing, setCapturing] = useState(false);
  const [uploading, setUploading] = useState(false);

  const handleCapture = useCallback(async () => {
    // Allow capture even if evidence service is still warming
    if (capturing) {
      pushToast("info", "Capture already in progress");
      return;
    }
    setCapturing(true);
    try {
      if (ingestMode !== "capture") setIngestMode("capture");
      const placeholderJob = await triggerCapture();
      playSound("capture"); // Play camera click sound on successful capture
      pushToast("success", "Capture triggered");
      // Insert placeholder job immediately for instant UI feedback
      if (placeholderJob) {
        setJobs((prev) => {
          const filtered = prev.filter((job) => job.id !== placeholderJob.id);
          return [placeholderJob, ...filtered].slice(0, 100);
        });
        setSelectedId(placeholderJob.id);
      }
      // Refresh shortly after to pick up status updates from SFTP delivery
      setTimeout(() => {
        refreshJobs().catch(() => undefined);
      }, 600);
    } catch (error) {
      pushToast(
        "error",
        "Capture failed",
        error instanceof Error ? error.message : undefined
      );
    } finally {
      setCapturing(false);
    }
  }, [capturing, ingestMode, pushToast, refreshJobs, setIngestMode, setJobs, setSelectedId]);

  const handleUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setUploading(true);
      try {
        if (ingestMode !== "upload") setIngestMode("upload");
        const uploadedJob = await uploadImage(file);
        pushToast("success", "Image uploaded successfully");
        setJobs((prev) => {
          const filtered = prev.filter((job) => job.id !== uploadedJob.id);
          return [uploadedJob, ...filtered].slice(0, 100);
        });
      } catch (error) {
        pushToast(
          "error",
          "Upload failed",
          error instanceof Error ? error.message : undefined
        );
      } finally {
        setUploading(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [ingestMode, pushToast, setIngestMode, setJobs]
  );

  const triggerFileInput = useCallback(() => {
    // Allow upload even if evidence service is still warming
    if (uploading) {
      pushToast("info", "Upload already in progress");
      return;
    }
    fileInputRef.current?.click();
  }, [uploading, pushToast, evidenceReady]);

  const handleCaptureButton = useCallback(() => {
    if (ingestMode !== "capture") setIngestMode("capture");
    handleCapture();
  }, [handleCapture, ingestMode, setIngestMode]);

  const handleUploadButton = useCallback(() => {
    if (ingestMode !== "upload") setIngestMode("upload");
    triggerFileInput();
  }, [ingestMode, setIngestMode, triggerFileInput]);

  const triggerPrimaryAction = useCallback(() => {
    if (ingestMode === "upload") {
      triggerFileInput();
      return;
    }
    handleCapture();
  }, [handleCapture, ingestMode, triggerFileInput]);

  const handleAccept = useCallback(async () => {
    if (evidenceReady === false) return; // gated until evidence service ready
    if (!selectedJob) return;
    if (hasInvalidManualEdits) return; // Block accept if manual edits are invalid
    if (acceptMacro.phase !== "idle" && acceptMacro.phase !== "error") return;

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const actionableStatuses: JobStatus[] = [
      "OPERATOR_PENDING",
      "CANDIDATES_READY",
      "UNMATCHED_NO_REASONABLE_CANDIDATE",
    ];
    const statusOk = actionableStatuses.includes(selectedJob.status as JobStatus);
    // Truth Core validity check - from telemetry, job accepted fields, or canonical lock
    const truthCore = variantTelemetry?.truth_core as { name?: string; hp?: number | null; collector_no?: string; set_name?: string } | undefined;
    const truthFromTelemetry = !!truthCore && !!truthCore.name && !!truthCore.collector_no && !!truthCore.set_name;
    const truthFromJob = !!selectedJob.accepted_name && !!selectedJob.accepted_collector_no && !!selectedJob.accepted_set_name;
    // If canonical is locked, truth is valid by definition (locking requires complete truth core)
    const truthValid = variantTelemetry?.truth_valid === true || truthFromTelemetry || truthFromJob || selectedJob.canonical_locked;
    // Stage 1 prerequisites must be complete before Stage 2 (Accept)
    // In baseline mode, only front_locked is required (back_ready and canonical_locked are skipped)
    const stage1Complete = sessionState.isBaseline
      ? Boolean(selectedJob.front_locked)
      : Boolean(selectedJob.front_locked && selectedJob.back_ready && selectedJob.canonical_locked);
    // Verification: explicit set_verified OR canonical_locked (locking canonical implies truth verified)
    // In baseline mode, verification is always OK (relaxed gate)
    const verifiedOk = sessionState.isBaseline ? true : (variantTelemetry?.set_verified === true || selectedJob.canonical_locked);
    const canAccept = statusOk && verifiedOk && (truthValid || hasValidManualEdits) && stage1Complete;

    const truthCoreComplete = Boolean(truthCore?.name && truthCore?.collector_no && truthCore?.set_name);

	    const runAcceptMacro = async () => {
	      const scanId = selectedJob.id;
	      const start = Date.now();
	      const timeoutMs = 45_000;

	      const requireJob = async (): Promise<Job> => {
	        const latest = await fetchJobById(scanId);
	        if (!latest) throw new Error("Job not found");
	        return latest;
	      };

      const pollJobUntil = async (predicate: (job: Job) => boolean, label: string): Promise<Job> => {
        while (Date.now() - start < timeoutMs) {
          const latest = await fetchJobById(scanId);
          if (latest && predicate(latest)) return latest;
          await sleep(500);
        }
        throw new Error(`Timed out waiting for ${label}`);
      };

	      let latestJob = await requireJob();

      // Stage 1A: lock front (if needed)
      if (!latestJob.front_locked) {
        setAcceptMacro({ phase: "locking_front", message: "Locking front (Stage 1A)..." });
        await lockFrontImage(scanId);
        latestJob = await pollJobUntil((j) => Boolean(j.front_locked), "front lock");
        setJobs((prev) => prev.map((j) => (j.id === scanId ? latestJob : j)));
      }

      // Persist Truth Core best-effort before identity lock/accept
      if (truthCoreComplete && truthCore) {
        try {
          await saveTruthCore(scanId, truthCore as any);
        } catch {
          // Non-fatal: lockCanonical/accept will also persist via backend paths; keep macro moving.
        }
      }

      // Stage 1B: capture back (if needed), with countdown pad
	      latestJob = await requireJob();

      if (!latestJob.back_ready) {
        const delayMs = Math.max(0, Math.floor(backCaptureDelayMs));
        const countdownEnd = Date.now() + delayMs;
        while (true) {
          const remainingMs = countdownEnd - Date.now();
          if (remainingMs <= 0) break;
          const remainingS = Math.max(0, remainingMs / 1000);
          setAcceptMacro({
            phase: "countdown",
            countdown_s: Math.ceil(remainingS * 10) / 10,
            message: "Flip/align card for back capture…",
          });
          await sleep(Math.min(250, remainingMs));
        }

        setAcceptMacro({ phase: "capturing_back", message: "Triggering back capture (Stage 1B)..." });
        await captureBackForScan(scanId);
        setAcceptMacro({ phase: "waiting_back", message: "Waiting for back image attach..." });
        latestJob = await pollJobUntil((j) => Boolean(j.back_ready), "back image attach");
        setJobs((prev) => prev.map((j) => (j.id === scanId ? latestJob : j)));
      }

      // Stage 1C: lock identity (if needed)
	      latestJob = await requireJob();

      if (!latestJob.canonical_locked) {
        if (!truthCoreComplete || !truthCore) {
          throw new Error("Truth Core incomplete (need Name, Set Name, Set Number)");
        }
        setAcceptMacro({ phase: "locking_identity", message: "Locking identity (Stage 1C)..." });
        await lockCanonical(scanId, { truth_core: truthCore as any });
        latestJob = await pollJobUntil((j) => Boolean(j.canonical_locked), "identity lock");
        setJobs((prev) => prev.map((j) => (j.id === scanId ? latestJob : j)));
      }

      setAcceptMacro({ phase: "idle" });
    };

    // Non-baseline: Accept acts as a macro to satisfy Stage 1 before Stage 2.
    if (!canAccept) {
      if (!statusOk) return;
      if (sessionState.isBaseline) return; // Baseline uses its own accept button
      if (!truthCoreComplete) {
        pushToast("info", "Complete Truth Core first", "Name, Set Name, and Set Number are required");
        return;
      }
      try {
        await runAcceptMacro();
      } catch (error) {
        setAcceptMacro({ phase: "error", message: error instanceof Error ? error.message : String(error) });
        pushToast("error", "Accept macro failed", error instanceof Error ? error.message : String(error));
        return;
      }
    }

    try {
      setAcceptMacro({ phase: "accepting", message: "Accepting..." });
      // Determine what to send based on manual edits or selection source
      let idx: number | undefined;
      let telemetryToSend = { ...variantTelemetry };
      let effectiveSelectionSource = selectionSource;

      // If valid manual edits exist, they replace variant selection
      if (hasValidManualEdits && Object.keys(stagedOverrides).length > 0) {
        telemetryToSend.staged_overrides = stagedOverrides;
        telemetryToSend.validation_result = { schema_valid: stagedIsValid };
        idx = undefined; // Manual edits replace variant selection
        effectiveSelectionSource = "manual_tab"; // Override selection source for analytics
      } else if (selectionSource === "expanded_family" && selectedExpandedVariantId) {
        // Expanded variant selected - include variant ID in telemetry
        telemetryToSend.selected_variant_id = selectedExpandedVariantId;
        idx = undefined; // No top3 index for expanded variants
      } else {
        // Top3 selection
        idx = Math.min(chosen ?? 0, Math.max(candidateCount - 1, 0));
      }

      // Only send telemetry if it has data
      const finalTelemetry = Object.keys(telemetryToSend).length > 0 ? telemetryToSend : undefined;

      await patchJob(selectedJob.id, "ACCEPT", idx, effectiveSelectionSource, finalTelemetry, condition);
      playSound("success"); // Play objective complete sound on successful accept

      // Build diff summary for toast
      const truthFromTelemetry = variantTelemetry?.truth_core;
      const diffs: string[] = [];
      if (truthFromTelemetry) {
        if (truthFromTelemetry.name !== selectedJob.card_name) {
          diffs.push(`Name: ${selectedJob.card_name || '—'} → ${truthFromTelemetry.name}`);
        }
        if (truthFromTelemetry.hp !== selectedJob.hp_value) {
          diffs.push(`HP: ${selectedJob.hp_value ?? '—'} → ${truthFromTelemetry.hp ?? '—'}`);
        }
        if (truthFromTelemetry.collector_no !== selectedJob.set_number) {
          diffs.push(`Collector No: ${selectedJob.set_number || '—'} → ${truthFromTelemetry.collector_no}`);
        }
        if (truthFromTelemetry.set_name !== selectedJob.set_name) {
          diffs.push(`Set Name: ${selectedJob.set_name || '—'} → ${truthFromTelemetry.set_name}`);
        }
      }

      const diffMsg = diffs.length > 0 ? diffs.join(' • ') : 'No changes';
      // Use baseline-specific toast message when in baseline mode
      if (sessionState.isBaseline) {
        pushToast("success", "Baseline Contribution", "Card accepted for baseline validation");
      } else {
        pushToast("success", "Accepted", diffMsg);
      }
      setAcceptMacro({ phase: "idle" });
      setJobs((j) => j.map((x) => (x.id === selectedJob.id ? { ...x, status: "ACCEPTED" } : x)));

      // Auto-advance to next pending job
      const currentIndex = filteredJobs.findIndex((j) => j.id === selectedJob.id);
      const nextPendingJob = filteredJobs
        .slice(currentIndex + 1)
        .find((j) => ["OPERATOR_PENDING", "CANDIDATES_READY", "UNMATCHED_NO_REASONABLE_CANDIDATE"].includes(j.status));

      if (nextPendingJob) {
        setSelectedId(nextPendingJob.id);
      } else if (sessionState.isBaseline) {
        // In baseline mode, clear selection when no more pending jobs
        setSelectedId(undefined);
      }

      // Reset telemetry and clear staged edits after successful accept
      setSelectionSource("top3");
      setVariantTelemetry({});
      setSelectedExpandedVariantId(null);
      clearStagedEdits();
    } catch (error: any) {
      setAcceptMacro({ phase: "idle" });
      // Parse validation errors from 400 responses
      if (error?.response?.data?.validation_errors && Array.isArray(error.response.data.validation_errors)) {
        const firstError = error.response.data.validation_errors[0];
        const errorMsg = firstError?.message || "Invalid manual edits";
        pushToast("error", `Accept failed: ${errorMsg}`);
      } else {
        pushToast("error", "Accept failed");
      }
    }
  }, [
    selectedJob,
    candidateCount,
    chosen,
    pushToast,
    setJobs,
    playSound,
    selectionSource,
    variantTelemetry,
    acceptMacro.phase,
    backCaptureDelayMs,
    selectedExpandedVariantId,
    hasValidManualEdits,
    hasInvalidManualEdits,
    stagedOverrides,
    stagedIsValid,
    clearStagedEdits,
    evidenceReady,
    condition,
    sessionState.isBaseline,
    filteredJobs,
  ]);

  // Baseline accept completed callback - clear card and advance to next
  const handleBaselineAccepted = useCallback(() => {
    if (!selectedJob) return;

    // Update local state to ACCEPTED
    setJobs((j) => j.map((x) => (x.id === selectedJob.id ? { ...x, status: "ACCEPTED" } : x)));

    // Play success sound
    playSound("success");

    // Auto-advance to next pending job
    const currentIndex = filteredJobs.findIndex((j) => j.id === selectedJob.id);
    const nextPendingJob = filteredJobs
      .slice(currentIndex + 1)
      .find((j) => ["OPERATOR_PENDING", "CANDIDATES_READY", "UNMATCHED_NO_REASONABLE_CANDIDATE"].includes(j.status));

    if (nextPendingJob) {
      setSelectedId(nextPendingJob.id);
    } else {
      // No more pending jobs - clear selection
      setSelectedId(undefined);
    }

    // Reset telemetry for next card
    setSelectionSource("top3");
    setVariantTelemetry({});
    setSelectedExpandedVariantId(null);

    pushToast("success", "Baseline Contribution", "Card accepted for baseline validation");
  }, [selectedJob, filteredJobs, setJobs, playSound, pushToast]);

  const handleFlag = useCallback(async () => {
    if (evidenceReady === false) return; // gated until evidence service ready
    if (!selectedJob) return;
    if (selectedJob.status === "FLAGGED") return;

    try {
      await patchJob(selectedJob.id, "FLAG");
      pushToast("warning", "Flagged");
      setJobs((j) => j.map((x) => (x.id === selectedJob.id ? { ...x, status: "FLAGGED" } : x)));
    } catch {
      pushToast("error", "Flag failed");
    }
  }, [selectedJob, pushToast, setJobs]);

  // Manual override handlers (Phase 5)
  const handleOpenManualOverride = useCallback((scanId: string) => {
    setManualOverrideScanId(scanId);
    setManualOverrideOpen(true);
  }, []);

  // Manual validity change handler (Phase 6)
  const handleManualValidityChange = useCallback((hasValid: boolean, hasInvalid: boolean) => {
    setHasValidManualEdits(hasValid);
    setHasInvalidManualEdits(hasInvalid);
  }, []);

  const handleCloseManualOverride = useCallback(() => {
    setManualOverrideOpen(false);
    setManualOverrideScanId(null);
  }, []);

  const handleManualOverrideSuccess = useCallback(() => {
    pushToast("success", "Manual override submitted");
    refreshJobs();
  }, [pushToast, refreshJobs]);

  const handleManualOverrideError = useCallback((message: string) => {
    pushToast("error", "Manual override failed", message);
  }, [pushToast]);

  // Hotkeys
  useEffect(() => {
    const isTyping = (el: EventTarget | null): boolean => {
      const target = el as HTMLElement | null;
      if (!target) return false;
      const tag = target.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if ((target as HTMLElement).isContentEditable) return true;
      // Treat text-like input types as typing contexts
      if (tag === "input") {
        const input = target as HTMLInputElement;
        const t = (input.type || "").toLowerCase();
        const textTypes = new Set(["text", "search", "email", "number", "password", "tel", "url"]);
        if (textTypes.has(t)) return true;
      }
      return false;
    };

    const onKey = (ev: KeyboardEvent) => {
      // When typing in any editable element, ignore ALL hotkeys.
      // Prevents accidental Accept/Flag/etc while editing Truth Core fields.
      if (isTyping(ev.target)) return;

      if (ev.code === "Space") {
        ev.preventDefault();
        triggerPrimaryAction();
      }
      if (["Digit1", "Digit2", "Digit3"].includes(ev.code)) {
        const idx = Number(ev.code.slice(-1)) - 1;
        if (idx >= 0 && idx < candidateCount) {
          setChosen(idx);
          setSelectionSource("top3"); // Mark selection as from top3
          setSelectedExpandedVariantId(null); // Clear any expanded variant selection
        }
      }
      if (ev.code === "Enter" && selectedJob) {
        ev.preventDefault();
        handleAccept();
      }
      if (ev.code === "KeyF" && selectedJob) {
        ev.preventDefault();
        handleFlag();
      }
      if (ev.code === "ArrowDown") {
        const ix = filteredJobs.findIndex((j) => j.id === selectedId);
        if (ix < filteredJobs.length - 1) setSelectedId(filteredJobs[ix + 1].id);
      }
      if (ev.code === "ArrowUp") {
        const ix = filteredJobs.findIndex((j) => j.id === selectedId);
        if (ix > 0) setSelectedId(filteredJobs[ix - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    filteredJobs,
    selectedId,
    selectedJob,
    candidateCount,
    chosen,
    setChosen,
    setSelectedId,
    triggerPrimaryAction,
    handleAccept,
    handleFlag,
    hasInvalidManualEdits,
  ]);

  // Header status badges
  const connPill = useMemo(() => {
    const isUp = metrics.backendUp;
    return (
      <span className="pill" style={{
        borderColor: "transparent",
        background: isUp ? "var(--good-glow)" : "var(--bad-glow)",
        color: isUp ? "var(--good)" : "var(--bad)",
        fontWeight: 500,
      }}>
        <span style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: isUp ? "var(--good)" : "var(--bad)",
          marginRight: 4,
        }} />
        {isUp ? "Backend" : "Offline"}
      </span>
    );
  }, [metrics.backendUp]);

  const wsPill = useMemo(() => {
    if (!wsUrl) return null;
    const isUp = wsState === "up";
    const isReconnecting = wsState === "reconnecting";
    const color = isUp ? "var(--good)" : isReconnecting ? "var(--warn)" : "var(--bad)";
    const glow = isUp ? "var(--good-glow)" : isReconnecting ? "var(--warn-glow)" : "var(--bad-glow)";
    const label = isUp ? "Realtime" : isReconnecting ? "Reconnecting" : "WS Down";
    return (
      <span className="pill" style={{
        borderColor: "transparent",
        background: glow,
        color: color,
        fontWeight: 500,
      }}>
        <span style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: color,
          marginRight: 4,
          animation: isReconnecting ? "pulse 1.5s ease-in-out infinite" : undefined,
        }} />
        {label}
      </span>
    );
  }, [wsState, wsUrl]);

  // Disable capture/upload if session not RUNNING or heartbeat stale
  const gatingDisabled = evidenceReady === false; // Not ready yet → gate accept/flag via local checks and overlay
  const captureDisabled = capturing || sessionState.status !== "RUNNING" || sessionState.heartbeat_stale;
  const uploadDisabled = uploading || sessionState.status !== "RUNNING" || sessionState.heartbeat_stale;

  return (
    <div style={{
      display: "grid",
      gridTemplateRows: "auto 1fr",
      height: "100%",
      overflow: "hidden",
      background: "linear-gradient(180deg, var(--bg) 0%, var(--bg-elevated) 100%)",
    }}>
      {/* Header */}
      <header
        className="panel"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 18px",
          margin: "12px 12px 0 12px",
          borderColor: "var(--border-accent)",
          background: "linear-gradient(180deg, var(--panel-3) 0%, var(--panel) 100%)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}>
            <span style={{
              fontWeight: 700,
              fontSize: "var(--text-lg)",
              letterSpacing: "var(--tracking-tight)",
              color: "var(--accent)",
              textTransform: "uppercase",
            }}>
              CardMint
            </span>
            <span style={{
              fontWeight: 400,
              fontSize: "var(--text-sm)",
              color: "var(--sub)",
              letterSpacing: "var(--tracking-wide)",
            }}>
              Operator Workbench
            </span>
          </div>
          <div style={{ width: 1, height: 20, background: "var(--border)" }} />
          <SessionHeader
            backCaptureDelayMs={backCaptureDelayMs}
            onBackCaptureDelayChange={setBackCaptureDelayMs}
          />
          <QuotaChip />
          {connPill}
          {wsPill}
          <span className="pill" style={{
            fontFamily: "var(--mono)",
            borderColor: metrics.queueDepth >= WARN_THRESHOLD ? "var(--warn)" : undefined,
            background: metrics.queueDepth >= WARN_THRESHOLD ? "var(--warn-glow)" : undefined,
            color: metrics.queueDepth >= WARN_THRESHOLD ? "var(--warn)" : undefined,
          }}>
            Queue: {metrics.queueDepth}
            {metrics.queueDepth >= WARN_THRESHOLD ? " !" : ""}
          </span>
          {metrics.p50 != null && (
            <span className="pill" style={{ fontFamily: "var(--mono)" }}>
              p50 {Math.round(metrics.p50)}ms
            </span>
          )}
          {metrics.p95 != null && (
            <span className="pill" style={{ fontFamily: "var(--mono)" }}>
              p95 {Math.round(metrics.p95)}ms
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            className={`btn ${ingestMode === "capture" ? "primary" : ""}`.trim()}
            onClick={handleCaptureButton}
            disabled={captureDisabled}
            style={{
              gap: 8,
              ...(ingestMode === "capture" && !captureDisabled ? {
                boxShadow: "var(--shadow), 0 0 24px var(--accent-glow)",
              } : {}),
            }}
            title={
              captureDisabled
                ? sessionState.heartbeat_stale
                  ? "Heartbeat stale (>90s) — capture disabled"
                  : sessionState.status !== "RUNNING"
                    ? "Start a session and switch to RUNNING state to enable capture"
                    : ""
                : ""
            }
          >
            <span style={{ opacity: 0.7 }}>Space</span> Capture
          </button>
          <button
            className={`btn ${ingestMode === "upload" ? "primary" : ""}`.trim()}
            onClick={handleUploadButton}
            disabled={uploadDisabled}
            style={{
              gap: 8,
              ...(ingestMode === "upload" && !uploadDisabled ? {
                boxShadow: "var(--shadow), 0 0 24px var(--accent-glow)",
              } : {}),
            }}
            title={
              uploadDisabled
                ? sessionState.heartbeat_stale
                  ? "Heartbeat stale (>90s) — upload disabled"
                  : sessionState.status !== "RUNNING"
                    ? "Start a session and switch to RUNNING state to enable upload"
                    : ""
                : ""
            }
          >
            <span style={{ opacity: 0.7 }}>+</span> Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg"
            onChange={handleUpload}
            style={{ display: "none" }}
          />
        </div>
      </header>

      {/* Scrollable content area with bottom padding for fixed ribbon */}
      <div style={{ overflow: "auto", padding: "12px", paddingBottom: "56px" }}>
        {/* Workspace readiness banner */}
        {evidenceReady === false && (
          <div
            className="panel"
            style={{
              borderLeft: "3px solid var(--accent)",
              marginBottom: 12,
              padding: "12px 16px",
              display: "flex",
              alignItems: "center",
              gap: 12,
              background: "linear-gradient(90deg, var(--accent-glow) 0%, var(--panel) 30%)",
            }}
          >
            <span className="pill glow-pulse" style={{
              background: "var(--accent-glow)",
              color: "var(--accent)",
              borderColor: "var(--border-accent)",
            }}>
              Initializing
            </span>
            <span style={{ color: "var(--sub)", fontSize: "var(--text-sm)" }}>
              Evidence engine warming. Controls are temporarily disabled.
            </span>
            {retrievalHash && (
              <span className="pill" style={{
                marginLeft: "auto",
                fontFamily: "var(--mono)",
                fontSize: "var(--text-xs)",
              }} title="Corpus hash">
                {retrievalHash.slice(0, 8)}
              </span>
            )}
          </div>
        )}

        {/* Controls */}
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
          <input
            type="text"
            placeholder="Search by name, set, status, or job ID..."
            style={{
              flex: 1,
              padding: "10px 14px",
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r-sm)",
              fontSize: "var(--text-sm)",
            }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            style={{
              padding: "10px 14px",
              paddingRight: 32,
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r-sm)",
              fontSize: "var(--text-sm)",
              cursor: "pointer",
            }}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
          >
            <option value="all">All Jobs</option>
            <option value="pending">Pending</option>
            <option value="unmatched">Unmatched</option>
            <option value="accepted">Accepted</option>
            <option value="flagged">Flagged</option>
            <option value="errors">Errors</option>
          </select>
        </div>

        {/* Main grid */}
        <div
          ref={gridRef}
          style={{
            display: "grid",
            gridTemplateColumns: `340px 1fr ${RESIZER_WIDTH}px auto`,
            gap: 12,
            minHeight: "calc(100vh - 210px)",
            position: "relative",
          }}
        >
          {/* Left Panel with Tabs */}
          <div style={{
            display: "grid",
            gridTemplateRows: "auto 1fr",
            gap: 0,
            background: "var(--panel)",
            borderRadius: "var(--r)",
            border: "1px solid var(--border)",
            overflow: "hidden",
            boxShadow: "var(--shadow)",
          }}>
            <div style={{
              display: "flex",
              gap: 0,
              borderBottom: "1px solid var(--border)",
              background: "var(--panel-2)",
            }}>
              <button
                onClick={() => setLeftTab("jobs")}
                style={{
                  padding: "10px 16px",
                  background: leftTab === "jobs"
                    ? "linear-gradient(180deg, var(--accent-glow) 0%, transparent 100%)"
                    : "transparent",
                  color: leftTab === "jobs" ? "var(--accent)" : "var(--sub)",
                  border: "none",
                  cursor: sessionState.status === "RUNNING" ? "pointer" : "not-allowed",
                  fontSize: "var(--text-sm)",
                  fontWeight: 600,
                  letterSpacing: "var(--tracking-wide)",
                  borderBottom: leftTab === "jobs" ? "2px solid var(--accent)" : "2px solid transparent",
                  opacity: sessionState.status === "RUNNING" ? 1 : 0.5,
                  transition: "all var(--transition)",
                }}
                disabled={sessionState.status !== "RUNNING"}
              >
                Jobs {filteredJobs.length > 0 && (
                  <span style={{
                    marginLeft: 6,
                    padding: "2px 6px",
                    borderRadius: "var(--r-pill)",
                    background: leftTab === "jobs" ? "var(--accent)" : "var(--border)",
                    color: leftTab === "jobs" ? "var(--bg)" : "var(--sub)",
                    fontSize: "var(--text-xs)",
                    fontWeight: 600,
                  }}>
                    {filteredJobs.length}
                  </span>
                )}
              </button>
              <button
                onClick={() => setLeftTab("sessions")}
                style={{
                  padding: "10px 16px",
                  background: leftTab === "sessions"
                    ? "linear-gradient(180deg, var(--accent-glow) 0%, transparent 100%)"
                    : "transparent",
                  color: leftTab === "sessions" ? "var(--accent)" : "var(--sub)",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "var(--text-sm)",
                  fontWeight: 600,
                  letterSpacing: "var(--tracking-wide)",
                  borderBottom: leftTab === "sessions" ? "2px solid var(--accent)" : "2px solid transparent",
                  transition: "all var(--transition)",
                }}
              >
                Sessions
              </button>
              <button
                onClick={() => setLeftTab("analytics")}
                style={{
                  padding: "10px 16px",
                  background: leftTab === "analytics"
                    ? "linear-gradient(180deg, var(--accent-glow) 0%, transparent 100%)"
                    : "transparent",
                  color: leftTab === "analytics" ? "var(--accent)" : "var(--sub)",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "var(--text-sm)",
                  fontWeight: 600,
                  letterSpacing: "var(--tracking-wide)",
                  borderBottom: leftTab === "analytics" ? "2px solid var(--accent)" : "2px solid transparent",
                  transition: "all var(--transition)",
                }}
              >
                Analytics
              </button>
            </div>
            {leftTab === "jobs" ? (
              <RecentJobsPanel jobs={filteredJobs} selectedId={selectedId} onSelect={setSelectedId} />
            ) : leftTab === "sessions" ? (
              <SessionTimeline />
            ) : (
              <AnalyticsPanel />
            )}
          </div>

          <ImagePreviewPanel
            job={selectedJob}
            zoom={zoom}
            setZoom={setZoom}
            pan={pan}
            setPan={setPan}
            rotation={rotation}
            setRotation={setRotation}
            onOpenManualOverride={handleOpenManualOverride}
          />
          {/* Vertical resizer between center and right panes */}
          <div
            onMouseDown={(e) => {
              if (!gridRef.current) return;
              const containerRect = gridRef.current.getBoundingClientRect();
              const startX = e.clientX;
              const startWidth = rightPaneWidth;

              const onMove = (ev: MouseEvent) => {
                const dx = ev.clientX - startX;
                // Compute width by measuring distance from pointer to container's right edge
                const pointerBasedWidth = Math.round(containerRect.right - ev.clientX);
                const computed = isFinite(pointerBasedWidth)
                  ? pointerBasedWidth
                  : Math.round(startWidth - dx);
                const clamped = Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, computed));
                setRightPaneWidth(clamped);
                setUserResizedRightPane(true);
              };

              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };

              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
            onDoubleClick={() => {
              // Auto-fit width to content (clamped) or toggle back to default
              const defaultWidth = 380;
              const el = rightPaneRef.current;
              if (!el) {
                setRightPaneWidth(defaultWidth);
                setUserResizedRightPane(false);
                return;
              }
              const scrollW = el.scrollWidth;
              const desired = Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, scrollW + 24));
              const next = Math.abs(rightPaneWidth - desired) < 12 ? defaultWidth : desired;
              setRightPaneWidth(next);
              setUserResizedRightPane(false);
            }}
            style={{
              cursor: "col-resize",
              width: RESIZER_WIDTH,
              background: "transparent",
              position: "relative",
            }}
            title="Drag to resize right panel (double‑click to auto‑fit)"
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
                // Subtle visual handle
                background: "linear-gradient(to right, transparent 40%, var(--border) 40%, var(--border) 60%, transparent 60%)",
                opacity: 0.6,
              }}
            />
          </div>
          <div
            ref={rightPaneRef}
            style={{
              width: rightPaneWidth,
              minWidth: RIGHT_MIN,
              maxWidth: RIGHT_MAX,
              transition: "width 140ms ease",
            }}
          >
            <RightPaneTabs
              job={selectedJob}
              evidence={evidenceCache.get(selectedJob?.id ?? "")?.evidence ?? null}
              loading={evidenceLoading}
              variantTelemetry={variantTelemetry}
              chosen={chosen}
              setChosen={setChosen}
              onAccept={handleAccept}
              onFlag={handleFlag}
              featureEnabled={EVIDENCE_UI_ENABLED}
              setSelectionSource={setSelectionSource}
              setVariantTelemetry={setVariantTelemetry}
              setSelectedExpandedVariantId={setSelectedExpandedVariantId}
              onManualValidityChange={handleManualValidityChange}
              refreshEvidence={refreshEvidence}
              refreshJob={refreshSelectedJob}
              condition={condition}
              setCondition={setCondition}
              onBaselineAccepted={handleBaselineAccepted}
            />
          </div>
          {/* Interaction gate overlay when evidence not ready */}
          {gatingDisabled && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "transparent",
                zIndex: 5,
                cursor: "not-allowed",
              }}
              title="Evidence engine warming — please wait"
            />
          )}
        </div>
      </div>

      {/* Accept macro overlay (high-visibility countdown + progress) */}
      {acceptMacro.phase !== "idle" && acceptMacro.phase !== "error" && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: acceptMacro.phase === "countdown" ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.35)",
            pointerEvents: "auto",
            cursor: acceptMacro.phase === "countdown" ? "default" : "wait",
          }}
        >
          <div
            style={{
              minWidth: 360,
              maxWidth: 520,
              padding: 18,
              borderRadius: 14,
              background: "rgba(17, 24, 39, 0.96)",
              border: "1px solid rgba(255,255,255,0.10)",
              boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
              color: "#fff",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 14, opacity: 0.9, marginBottom: 10 }}>
              {acceptMacro.message ?? "Processing..."}
            </div>
            {acceptMacro.phase === "countdown" && (
              <div style={{ fontSize: 54, fontWeight: 800, letterSpacing: -1 }}>
                {(() => {
                  const v = acceptMacro.countdown_s ?? 0;
                  return Number.isInteger(v) ? String(v) : v.toFixed(1);
                })()}
              </div>
            )}
            {acceptMacro.phase !== "countdown" && (
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Accept macro in progress…
              </div>
            )}
          </div>
        </div>
      )}

      <HotkeyRibbon
        primaryLabel={ingestMode === "upload" ? "upload" : "capture"}
        onPrimary={triggerPrimaryAction}
        onChoose={setChosen}
        onAccept={handleAccept}
        onFlag={handleFlag}
        onNavigate={(dir) => {
          const ix = filteredJobs.findIndex((j) => j.id === selectedId);
          if (dir === "down" && ix < filteredJobs.length - 1) setSelectedId(filteredJobs[ix + 1].id);
          if (dir === "up" && ix > 0) setSelectedId(filteredJobs[ix - 1].id);
        }}
        candidateCount={candidateCount}
      />
      <ToastStack items={toasts} />

      {/* Manual Override Drawer */}
      {manualOverrideScanId && (
        <ManualOverrideDrawer
          scanId={manualOverrideScanId}
          isOpen={manualOverrideOpen}
          onClose={handleCloseManualOverride}
          onSuccess={handleManualOverrideSuccess}
          onError={handleManualOverrideError}
        />
      )}
    </div>
  );
};

// ============================================================================
// Inline Components
// ============================================================================

const RecentJobsPanel: React.FC<{
  jobs: Job[];
  selectedId?: string;
  onSelect: (id: string) => void;
}> = ({ jobs, selectedId, onSelect }) => {
  return (
    <div style={{ height: "100%", overflow: "auto", padding: 8 }}>
      {jobs.length === 0 && (
        <div style={{
          padding: 24,
          color: "var(--muted)",
          textAlign: "center",
          fontSize: "var(--text-sm)",
        }}>
          No jobs match filters
        </div>
      )}
      {jobs.map((j) => (
        <div
          key={j.id}
          className={`list-item ${selectedId === j.id ? "active" : ""}`}
          onClick={() => onSelect(j.id)}
          style={{
            cursor: "pointer",
            justifyContent: "space-between",
            marginBottom: 2,
            borderRadius: "var(--r-sm)",
          }}
        >
          <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 600,
                fontSize: "var(--text-sm)",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                overflow: "hidden",
                maxWidth: 200,
                color: selectedId === j.id ? "var(--text)" : "var(--text-secondary)",
              }}
            >
              {j.card_name || (j.session_id ? j.session_id.slice(0, 12) + "..." : "—")}
            </div>
            <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
              <StatusPill status={j.status as JobStatus} />
              {j.timings?.inference_ms != null && (
                <span className="pill" style={{ fontFamily: "var(--mono)" }} title="Inference ms">
                  {Math.round(j.timings.inference_ms)}ms
                </span>
              )}
              {j.manual_override && (
                <span
                  className="pill"
                  style={{
                    background: "var(--accent-glow)",
                    color: "var(--accent)",
                    borderColor: "var(--border-accent)",
                  }}
                  title="Manual override applied"
                >
                  Manual
                </span>
              )}
              {j.ppt_failure_count != null && j.ppt_failure_count > 0 && (
                <span
                  className="pill"
                  style={{
                    background: "var(--warn-glow)",
                    color: "var(--warn)",
                    borderColor: "transparent",
                  }}
                  title={`PriceCharting failed ${j.ppt_failure_count}×`}
                >
                  CSV×{j.ppt_failure_count}
                </span>
              )}
            </div>
          </div>
          <div style={{
            color: "var(--muted)",
            fontSize: "var(--text-xs)",
            fontFamily: "var(--mono)",
            whiteSpace: "nowrap",
          }}>
            {j.created_at ? new Date(j.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ""}
          </div>
        </div>
      ))}
    </div>
  );
};

const ImagePreviewPanel: React.FC<{
  job: Job | null;
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  pan: { x: number; y: number };
  setPan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  rotation: number;
  setRotation: React.Dispatch<React.SetStateAction<number>>;
  onOpenManualOverride: (scanId: string) => void;
}> = ({ job, zoom, setZoom, pan, setPan, rotation, setRotation, onOpenManualOverride }) => {
  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const imageRef = useRef<HTMLImageElement>(null);
  const trackedJobsRef = useRef<Set<string>>(new Set());

  const handleImageLoad = useCallback(() => {
    if (!job?.id || !job?.created_at) return;
    if (trackedJobsRef.current.has(job.id)) return;

    // Parse ISO string to timestamp (job.created_at is snake_case ISO string from adapter)
    const createdAtMs = Date.parse(job.created_at);
    if (isNaN(createdAtMs)) {
      console.warn(`Invalid created_at timestamp for job ${job.id}: ${job.created_at}`);
      return;
    }

    trackedJobsRef.current.add(job.id);
    void recordOperatorFirstView(job.id, createdAtMs);
  }, [job?.id, job?.created_at]);

  const onWheel = (e: React.WheelEvent) => {
    // Only zoom if mouse is over the image element itself
    if (imageRef.current && e.target === imageRef.current) {
      e.preventDefault();
      const next = Math.min(6, Math.max(0.5, zoom + (e.deltaY > 0 ? -0.1 : 0.1)));
      setZoom(next);
    }
  };

  const down = (e: React.MouseEvent) => {
    dragging.current = true;
    last.current = { x: e.clientX, y: e.clientY };
  };

  const move = (e: React.MouseEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - last.current.x;
    const dy = e.clientY - last.current.y;
    last.current = { x: e.clientX, y: e.clientY };
    setPan((curr: { x: number; y: number }) => ({ x: curr.x + dx, y: curr.y + dy }));
  };

  const up = () => {
    dragging.current = false;
  };

  const src =
    (job?.processed_image_path ??
      job?.raw_image_path ??
      job?.image_path) ??
    null;
  const isProcessing = job && ["CAPTURING", "QUEUED", "PREPROCESSING", "INFERENCING"].includes(job.status);
  const isAwaitingImage = job && !job.image_path && job.session_id;
  const showManualOverridePrompt = job && (job.ppt_failure_count ?? 0) >= 3;

  return (
    <div className="panel" style={{
      height: "100%",
      position: "relative",
      overflow: "hidden",
      background: "radial-gradient(ellipse at center, var(--panel-3) 0%, var(--panel) 100%)",
    }}>
      {/* Zoom controls */}
      <div style={{
        position: "absolute",
        top: 12,
        right: 12,
        display: "flex",
        gap: 6,
        zIndex: 1,
      }}>
        <button
          className="btn"
          onClick={() => {
            setPan({ x: 0, y: 0 });
            setZoom(1);
            setRotation(0);
          }}
          style={{ padding: "6px 12px", fontSize: "var(--text-xs)" }}
          title="Reset view"
        >
          Reset
        </button>
        <button
          className="btn"
          onClick={() => setRotation((r) => (r + 90) % 360)}
          style={{ padding: "6px 10px", fontSize: "var(--text-sm)", fontWeight: 600 }}
          title="Rotate 90°"
        >
          ↻
        </button>
        <button
          className="btn"
          onClick={() => setZoom(Math.min(6, zoom + 0.2))}
          style={{ padding: "6px 10px", fontSize: "var(--text-sm)", fontWeight: 600 }}
          title="Zoom in"
        >
          +
        </button>
        <button
          className="btn"
          onClick={() => setZoom(Math.max(0.5, zoom - 0.2))}
          style={{ padding: "6px 10px", fontSize: "var(--text-sm)", fontWeight: 600 }}
          title="Zoom out"
        >
          −
        </button>
      </div>

      {/* Zoom/rotation indicator */}
      {(zoom !== 1 || rotation !== 0) && (
        <div style={{
          position: "absolute",
          bottom: 12,
          right: 12,
          zIndex: 1,
          display: "flex",
          gap: 6,
        }}>
          {zoom !== 1 && (
            <span className="pill" style={{ fontFamily: "var(--mono)" }}>
              {Math.round(zoom * 100)}%
            </span>
          )}
          {rotation !== 0 && (
            <span className="pill" style={{ fontFamily: "var(--mono)" }}>
              {rotation}°
            </span>
          )}
        </div>
      )}

      {/* Processing overlay badge */}
      {isProcessing && (
        <div style={{ position: "absolute", top: 12, left: 12, zIndex: 1 }}>
          <span className="pill glow-pulse" style={{
            background: "var(--accent-glow)",
            color: "var(--accent)",
            borderColor: "var(--border-accent)",
          }}>
            {job.status.replace(/_/g, " ")}
          </span>
        </div>
      )}

      {/* Manual override prompt when ppt_failure_count >= 3 */}
      {showManualOverridePrompt && (
        <div style={{
          position: "absolute",
          bottom: 16,
          left: 16,
          right: 16,
          zIndex: 1,
          display: "flex",
          justifyContent: "center",
        }}>
          <button
            className="btn danger"
            onClick={() => job && onOpenManualOverride(job.id)}
            style={{
              padding: "10px 20px",
              fontWeight: 600,
              boxShadow: "var(--shadow-lg), 0 0 24px var(--bad-glow)",
            }}
          >
            PPT Failed {job.ppt_failure_count}× — Manual Override Required
          </button>
        </div>
      )}

      {src ? (
        <div
          onMouseDown={down}
          onMouseMove={move}
          onMouseUp={up}
          onMouseLeave={up}
          onWheel={onWheel}
          style={{
            width: "100%",
            height: "100%",
            display: "grid",
            placeItems: "center",
            cursor: dragging.current ? "grabbing" : "grab",
          }}
        >
          <img
            ref={imageRef}
            src={src}
            alt={job?.card_name ?? "card"}
            onLoad={handleImageLoad}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
              transition: "transform 0.15s ease",
              maxWidth: "100%",
              maxHeight: "100%",
              borderRadius: "var(--r-sm)",
              boxShadow: "var(--shadow-lg)",
            }}
          />
        </div>
      ) : isAwaitingImage ? (
        <div style={{
          display: "grid",
          placeItems: "center",
          height: "100%",
          color: "var(--muted)",
          textAlign: "center",
          padding: 24,
        }}>
          <div>
            <div style={{
              width: 48,
              height: 48,
              margin: "0 auto 16px",
              borderRadius: "50%",
              border: "2px solid var(--border)",
              borderTopColor: "var(--accent)",
              animation: "spin 1s linear infinite",
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <div style={{
              fontWeight: 600,
              marginBottom: 8,
              fontSize: "var(--text-sm)",
              color: "var(--sub)",
            }}>
              Awaiting image...
            </div>
            <div style={{
              fontSize: "var(--text-xs)",
              fontFamily: "var(--mono)",
              color: "var(--muted)",
            }}>
              {job.session_id?.slice(0, 16)}
            </div>
          </div>
        </div>
      ) : (
        <div style={{
          display: "grid",
          placeItems: "center",
          height: "100%",
          color: "var(--muted)",
          fontSize: "var(--text-sm)",
        }}>
          <div style={{ textAlign: "center" }}>
            <div style={{
              width: 64,
              height: 64,
              margin: "0 auto 16px",
              borderRadius: "var(--r)",
              background: "var(--panel-2)",
              border: "2px dashed var(--border)",
              display: "grid",
              placeItems: "center",
              color: "var(--muted)",
              fontSize: 24,
            }}>
              ?
            </div>
            No image selected
          </div>
        </div>
      )}
    </div>
  );
};

const DetailsPanel: React.FC<{
  job: Job | null;
  chosen: number | null;
  setChosen: (i: number) => void;
  onAccept: () => void;
  onFlag: () => void;
}> = ({ job, chosen, setChosen, onAccept, onFlag }) => {
  if (!job)
    return (
      <div className="panel" style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--muted)" }}>
        Select a job
      </div>
    );

  const candidates = job.candidates ?? [];
  const canAccept = ["OPERATOR_PENDING", "CANDIDATES_READY", "UNMATCHED_NO_REASONABLE_CANDIDATE"].includes(job.status) && candidates.length > 0;
  const canFlag = job.status !== "FLAGGED";

  return (
    <div
      className="panel"
      style={{ height: "100%", padding: 12, display: "grid", gridTemplateRows: "auto 1fr auto", gap: 12 }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>{job.card_name || "—"}</div>
          <div style={{ color: "var(--muted)" }}>
            HP {job.hp_value ?? "—"} • Set #{job.set_number ?? "—"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {job.timings?.inference_ms != null && (
            <span className="pill">{Math.round(job.timings.inference_ms)} ms</span>
          )}
          <StatusPill status={job.status as JobStatus} />
        </div>
      </header>

      <section style={{ display: "grid", gap: 8, alignContent: "start", overflowY: "auto" }}>
        <div style={{ fontWeight: 600, opacity: 0.85 }}>Top candidates</div>
        {candidates.slice(0, 3).map((c, idx) => (
          <label
            key={idx}
            className="list-item"
            style={{
              justifyContent: "space-between",
              border: "1px solid var(--border)",
              cursor: canAccept ? "pointer" : "not-allowed",
              opacity: canAccept ? 1 : 0.6,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="radio"
                checked={chosen === idx}
                onChange={() => canAccept && setChosen(idx)}
                disabled={!canAccept}
              />
              <div>
                <div style={{ fontWeight: 600 }}>{c.title}</div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>{c.source ?? "local"}</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "2px 6px",
                  borderRadius: 3,
                  backgroundColor:
                    (c.confidence ?? 0) >= 0.7
                      ? "#22c55e22"
                      : (c.confidence ?? 0) >= 0.5
                        ? "#f59e0b22"
                        : "#ef444422",
                  color:
                    (c.confidence ?? 0) >= 0.7
                      ? "#16a34a"
                      : (c.confidence ?? 0) >= 0.5
                        ? "#d97706"
                        : "#dc2626",
                }}
              >
                {(c.confidence ?? 0) >= 0.7 ? "HIGH" : (c.confidence ?? 0) >= 0.5 ? "MEDIUM" : "LOW"}
              </span>
              <div style={{ fontFamily: "var(--mono)" }}>{Math.round((c.confidence ?? 0) * 100)}%</div>
            </div>
          </label>
        ))}
        {candidates.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>No candidates available.</div>
        )}
      </section>

      <footer style={{ display: "flex", gap: 8 }}>
        <button className="btn danger" onClick={onFlag} disabled={!canFlag}>
          Flag (F)
        </button>
        <button className="btn primary" onClick={onAccept} disabled={!canAccept}>
          Accept (Enter)
        </button>
      </footer>
    </div>
  );
};

const HotkeyRibbon: React.FC<{
  primaryLabel: string;
  onPrimary: () => void;
  onChoose: (idx: number) => void;
  onAccept: () => void;
  onFlag: () => void;
  onNavigate: (dir: "up" | "down") => void;
  candidateCount: number;
}> = ({ primaryLabel, onPrimary, onChoose, onAccept, onFlag, onNavigate, candidateCount }) => {
  const primaryText = primaryLabel.length
    ? primaryLabel[0].toUpperCase() + primaryLabel.slice(1)
    : "Capture";
  return (
    <div className="hotkey-ribbon">
      <span>
        <kbd onClick={onPrimary}>Space</kbd> {primaryText}
      </span>
      <span>
        <kbd onClick={() => candidateCount > 0 && onChoose(0)}>1</kbd>
        <kbd onClick={() => candidateCount > 1 && onChoose(1)}>2</kbd>
        <kbd onClick={() => candidateCount > 2 && onChoose(2)}>3</kbd> choose
      </span>
      <span>
        <kbd onClick={onAccept}>Enter</kbd> accept
      </span>
      <span>
        <kbd onClick={onFlag}>F</kbd> flag
      </span>
      <span>
        <kbd onClick={() => onNavigate("up")}>↑</kbd>
        <kbd onClick={() => onNavigate("down")}>↓</kbd> navigate
      </span>
    </div>
  );
};

const ToastStack: React.FC<{ items: Toast[] }> = ({ items }) => {
  return (
    <div className="toast-stack">
      {items.map((t) => (
        <div
          key={t.id}
          className="toast"
          style={{
            borderLeft: `4px solid ${t.level === "error"
              ? "var(--bad)"
              : t.level === "warning"
                ? "var(--warn)"
                : t.level === "success"
                  ? "var(--good)"
                  : "var(--accent)"
              }`,
          }}
        >
          <div style={{ fontWeight: 600 }}>{t.title}</div>
          {t.body && <div style={{ color: "var(--sub)", fontSize: 13, marginTop: 4 }}>{t.body}</div>}
        </div>
      ))}
    </div>
  );
};

function StatusPill({ status }: { status: JobStatus }) {
  const statusConfig: Record<JobStatus, { color: string; glow: string; label?: string }> = {
    ACCEPTED: { color: "var(--good)", glow: "var(--good-glow)" },
    OPERATOR_PENDING: { color: "var(--accent)", glow: "var(--accent-glow)", label: "PENDING" },
    CANDIDATES_READY: { color: "#84cc16", glow: "rgba(132, 204, 22, 0.15)", label: "READY" },
    INFERENCING: { color: "var(--warn)", glow: "var(--warn-glow)" },
    PREPROCESSING: { color: "var(--info)", glow: "var(--info-glow)" },
    CAPTURING: { color: "#0ea5e9", glow: "rgba(14, 165, 233, 0.15)" },
    CAPTURED: { color: "#38bdf8", glow: "rgba(56, 189, 248, 0.15)" },
    QUEUED: { color: "var(--sub)", glow: "rgba(139, 149, 168, 0.1)" },
    FLAGGED: { color: "var(--warn)", glow: "var(--warn-glow)" },
    NEEDS_REVIEW: { color: "#f97316", glow: "rgba(249, 115, 22, 0.15)", label: "REVIEW" },
    FAILED: { color: "var(--bad)", glow: "var(--bad-glow)" },
    UNMATCHED_NO_REASONABLE_CANDIDATE: { color: "var(--bad)", glow: "var(--bad-glow)", label: "UNMATCHED" },
  };
  const config = statusConfig[status] ?? { color: "var(--sub)", glow: "rgba(139, 149, 168, 0.1)" };
  const label = config.label ?? status.replace(/_/g, " ");
  return (
    <span
      className="pill"
      style={{
        borderColor: "transparent",
        background: config.glow,
        color: config.color,
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
}

// ============================================================================
// Root Export
// ============================================================================

export default function OperatorWorkbench() {
  return <WorkbenchInner />;
}
