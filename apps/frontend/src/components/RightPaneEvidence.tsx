import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Evidence, EvidenceSignal } from "../api/client";
import { attachScanToItem, splitItemScans, fetchVariants, jobImageUrl, captureBackImage, publishBackImage, lockFrontImage, captureBackForScan, lockCanonical } from "../api/client";
import type { Job } from "../api/adapters";
import TruthCorePanel from "./TruthCorePanel";
import { useSession } from "../hooks/useSession";

export type PPTStrategy = "pricecharting_bridge" | "pricecharting_bridge_fallback_parse_title" | "parse_title";

export interface PPTEnrichmentContext {
  strategy?: PPTStrategy | null;
  bridgeId?: string | null;
  parseTitleRequest?: string | null;
  signals?: Record<string, any> | null;
}

export interface PPTBestGuess {
  title: string;
  setName?: string | null;
  cardNumber?: string | null;
  confidence?: number | null;
}

export interface PPTMatchCandidate {
  rank: number;
  id: string;
  name: string;
  setName: string;
  cardNumber: string | null;
  totalSetNumber: string | null;
  hp: number | null;
  cardType: string | null;
  rarity: string | null;
  confidence: number | null;
  marketPrice: number | null;
  isBestMatch: boolean;
}

interface RightPaneEvidenceProps {
  job: Job | null;
  evidence: Evidence | null;
  loading: boolean;
  chosen: number | null;
  setChosen: (i: number) => void;
  onAccept: () => void;
  onFlag: () => void;
  featureEnabled: boolean;
  setSelectionSource: (source: "top3" | "expanded_family") => void;
  setVariantTelemetry: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  setSelectedExpandedVariantId: (id: string | null) => void;
  pptBestGuess?: PPTBestGuess | null;
  pptEnrichmentContext?: PPTEnrichmentContext | null;
  refreshEvidence?: () => void; // Phase 2J: Refresh after back capture
  refreshJob?: () => Promise<void>; // Refresh job data after truth core save/lock
  condition: string;
  setCondition: (condition: string) => void;
  variantTelemetry?: Record<string, any>;
  onBaselineAccepted?: () => void; // Called when baseline accept completes
}

const RightPaneEvidence: React.FC<RightPaneEvidenceProps> = ({
  job,
  evidence,
  loading,
  chosen,
  setChosen,
  onAccept,
  onFlag,
  featureEnabled,
  setSelectionSource,
  setVariantTelemetry,
  setSelectedExpandedVariantId,
  pptBestGuess = null,
  pptEnrichmentContext = null,
  refreshEvidence,
  refreshJob,
  condition,
  setCondition,
  variantTelemetry,
  onBaselineAccepted,
}) => {
  // Get baseline mode from session hook
  const { isBaseline } = useSession();
  const jobId = job?.id ?? null;
  const evidenceStatus = evidence?.status ?? null;
  const fallbackReason = !featureEnabled
    ? "feature-disabled"
    : !evidence
      ? "missing"
      : evidence.status === "UNAVAILABLE"
        ? "unavailable"
        : null;
  const renderKey = `${jobId ?? "none"}|${loading ? "loading" : fallbackReason ?? evidenceStatus ?? "ready"}`;
  const lastRenderKey = useRef<string | null>(null);

  // Collapsible sections state
  const [sectionsCollapsed, setSectionsCollapsed] = useState({
    signalsAndChecks: true,
    inventory: true,
    telemetry: true,
  });

  // Truth Core verification & state (MVP gating)
  const [truthVerified, setTruthVerified] = useState(false);
  const [truthCore, setTruthCore] = useState<{ name: string; hp: number | null; collector_no: string; set_name: string; set_size: number | null }>({
    name: "",
    hp: null,
    collector_no: "",
    set_name: "",
    set_size: null,
  });
  useEffect(() => {
    // reset when job changes & log view
    setTruthVerified(false);
    // Clear truth_core to prevent cross-job bleed (QA finding: truth from job A appearing on job B)
    setVariantTelemetry((t) => {
      const { truth_core, truth_valid, truth_verified, truth_verified_at, truth_last_changed_at, ...rest } = t;
      return { ...rest, truth_view_shown_at: Date.now() };
    });
  }, [job?.id, setVariantTelemetry]);

  // Variant drawer state
  const [variantDrawerExpanded, setVariantDrawerExpanded] = useState(false);
  const [expandedVariants, setExpandedVariants] = useState<Array<{
    id: string;
    title: string;
    confidence: number;
    source: string;
  }>>([]);
  const [variantsFetching, setVariantsFetching] = useState(false);
  const [variantsError, setVariantsError] = useState<string | null>(null);
  const [selectedExpandedVariant, setSelectedExpandedVariant] = useState<{
    id: string;
    title: string;
    index: number;
  } | null>(null);

  // Variant filters
  const [variantFilters, setVariantFilters] = useState({
    firstEdition: false,
    shadowless: false,
    holoType: null as string | null,
    yearMin: null as number | null,
    yearMax: null as number | null,
    setNumber: null as string | null,
  });

  // Flyout preview state
  const [flyoutVariant, setFlyoutVariant] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const flyoutTimeoutRef = useRef<number | null>(null);

  // Inventory actions state
  const [showInventoryActions, setShowInventoryActions] = useState(false);
  const [targetItemUid, setTargetItemUid] = useState("");
  const [inventoryActionInProgress, setInventoryActionInProgress] = useState(false);
  const [inventoryActionResult, setInventoryActionResult] = useState<string | null>(null);

  // Stage 1 lock front state (Nov 19: two-stage capture flow)
  const [lockingFront, setLockingFront] = useState(false);
  const [lockFrontResult, setLockFrontResult] = useState<string | null>(null);
  const lockFrontResultTimeoutRef = useRef<number | null>(null);

  // Back capture state (Phase 2J: two-capture workflow)
  const [capturingBack, setCapturingBack] = useState(false);
  const [captureBackResult, setCaptureBackResult] = useState<string | null>(null);
  const captureBackResultTimeoutRef = useRef<number | null>(null);

  // Lock+Accept combo state (Codex UX optimization)
  const [lockingAndAccepting, setLockingAndAccepting] = useState(false);

  const scheduleCaptureBackResultClear = useCallback(() => {
    if (captureBackResultTimeoutRef.current) {
      window.clearTimeout(captureBackResultTimeoutRef.current);
    }
    captureBackResultTimeoutRef.current = window.setTimeout(() => {
      setCaptureBackResult(null);
      captureBackResultTimeoutRef.current = null;
    }, 5000);
  }, []);

  const showCaptureBackResult = useCallback(
    (message: string) => {
      setCaptureBackResult(message);
      scheduleCaptureBackResultClear();
    },
    [scheduleCaptureBackResultClear]
  );

  // Lock front result helpers (Nov 19: two-stage capture flow)
  const scheduleLockFrontResultClear = useCallback(() => {
    if (lockFrontResultTimeoutRef.current) {
      window.clearTimeout(lockFrontResultTimeoutRef.current);
    }
    lockFrontResultTimeoutRef.current = window.setTimeout(() => {
      setLockFrontResult(null);
      lockFrontResultTimeoutRef.current = null;
    }, 5000);
  }, []);

  const showLockFrontResult = useCallback(
    (message: string) => {
      setLockFrontResult(message);
      scheduleLockFrontResultClear();
    },
    [scheduleLockFrontResultClear]
  );

  useEffect(() => {
    return () => {
      if (captureBackResultTimeoutRef.current) {
        window.clearTimeout(captureBackResultTimeoutRef.current);
      }
      if (lockFrontResultTimeoutRef.current) {
        window.clearTimeout(lockFrontResultTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (lastRenderKey.current === renderKey) {
      return;
    }
    console.info("EVIDENCE_RENDER_STATE", {
      jobId,
      loading,
      evidenceStatus,
      featureEnabled,
      fallbackReason,
    });
    lastRenderKey.current = renderKey;
  }, [renderKey, jobId, loading, evidenceStatus, featureEnabled, fallbackReason]);

  // Reset drawer state when job changes
  useEffect(() => {
    setVariantDrawerExpanded(false);
    setExpandedVariants([]);
    setVariantsError(null);
    setSelectedExpandedVariant(null);
    dismissFlyout();
  }, [jobId]);

  // Keyboard shortcuts: 'v' toggles Truth Verified; 4-9/0 previews expanded variants when drawer open
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const typing = tag === "input" || tag === "textarea" || tag === "select";
      if (typing) return; // Do not trigger hotkeys while the operator is typing
      if (e.key.toLowerCase() === "v") {
        setTruthVerified((prev) => {
          const next = !prev;
          setVariantTelemetry((t) => ({ ...t, set_verified: next, truth_verified: next, truth_verified_at: Date.now() }));
          return next;
        });
        return;
      }

      if (!variantDrawerExpanded || expandedVariants.length === 0) return;

      const keyMap: Record<string, number> = { "4": 0, "5": 1, "6": 2, "7": 3, "8": 4, "9": 5, "0": 6 };
      const index = keyMap[e.key];
      if (index !== undefined && index < expandedVariants.length) {
        const variant = expandedVariants[index];
        showFlyout(variant);
      }
    };

    window.addEventListener("keydown", handleKeyPress);
    return () => window.removeEventListener("keydown", handleKeyPress);
  }, [variantDrawerExpanded, expandedVariants, setVariantTelemetry]);

  // Auto-select top canonical candidate when confidence >= 0.7 (Codex UX optimization)
  useEffect(() => {
    if (chosen !== null) return; // Already selected
    const variants = evidence?.variants;
    if (!variants || variants.length === 0) return;
    const top = variants[0];
    const topSource = inferVariantSource(top.productId);
    if (top.score >= 0.7 && topSource === "canonical") {
      setChosen(0);
      setSelectionSource("top3");
      setVariantTelemetry((prev) => ({
        ...prev,
        auto_selected: true,
        auto_selected_confidence: top.score,
        auto_selected_source: topSource,
      }));
    }
  }, [evidence?.variants, chosen, setChosen, setSelectionSource, setVariantTelemetry]);

  // Fetch expanded variants
  const handleFetchVariants = async () => {
    if (!jobId) return;

    setVariantsFetching(true);
    setVariantsError(null);

    try {
      const data = await fetchVariants(jobId, 20);

      // Client-side deduplication: filter out variants already in top3
      const top3Ids = new Set(data.top3_ids);
      const dedupedVariants = data.variants.filter((v) => !top3Ids.has(v.id));

      setExpandedVariants(dedupedVariants);
      setVariantDrawerExpanded(true);

      // Track drawer open telemetry
      setVariantTelemetry((prev) => ({
        ...prev,
        drawer_opened_at: Date.now(),
        drawer_opened_count: (prev.drawer_opened_count ?? 0) + 1,
        expanded_variant_count: dedupedVariants.length,
      }));
    } catch (error) {
      setVariantsError(error instanceof Error ? error.message : String(error));
    } finally {
      setVariantsFetching(false);
    }
  };

  // Show flyout with auto-dismiss
  const showFlyout = (variant: { id: string; title: string }) => {
    // Clear existing timeout
    if (flyoutTimeoutRef.current) {
      window.clearTimeout(flyoutTimeoutRef.current);
    }

    setFlyoutVariant(variant);

    // Auto-dismiss after 5s
    flyoutTimeoutRef.current = window.setTimeout(() => {
      setFlyoutVariant(null);
    }, 5000);
  };

  // Dismiss flyout
  const dismissFlyout = () => {
    if (flyoutTimeoutRef.current) {
      window.clearTimeout(flyoutTimeoutRef.current);
    }
    setFlyoutVariant(null);
  };

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (flyoutTimeoutRef.current) {
        window.clearTimeout(flyoutTimeoutRef.current);
      }
    };
  }, []);

  // Inventory action handlers
  const handleSplitToNewItem = async () => {
    if (!job || !evidence?.inventory?.item_uid) return;

    setInventoryActionInProgress(true);
    setInventoryActionResult(null);

    try {
      const result = await splitItemScans(evidence.inventory.item_uid, [job.id]);
      setInventoryActionResult(`✓ Split complete. New item: ${result.affected_items[1]?.slice(0, 8)}...`);
      setTimeout(() => setInventoryActionResult(null), 5000);
    } catch (error) {
      setInventoryActionResult(`✗ Split failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setInventoryActionInProgress(false);
    }
  };

  const handleAttachToItem = async () => {
    if (!job || !targetItemUid.trim()) return;

    setInventoryActionInProgress(true);
    setInventoryActionResult(null);

    try {
      const result = await attachScanToItem(targetItemUid.trim(), job.id);
      setInventoryActionResult(`✓ Attached scan to item ${targetItemUid.slice(0, 8)}...`);
      setTargetItemUid("");
      setTimeout(() => setInventoryActionResult(null), 5000);
    } catch (error) {
      setInventoryActionResult(`✗ Attach failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setInventoryActionInProgress(false);
    }
  };

  // Lock front handler (Nov 19: Stage 1A transition)
  const handleLockFront = async () => {
    if (!job) {
      showLockFrontResult("✗ No job selected");
      return;
    }

    if (job.front_locked) {
      showLockFrontResult("⚠ Front already locked");
      return;
    }

    setLockingFront(true);
    setLockFrontResult(null);

    try {
      const result = await lockFrontImage(job.id);
      showLockFrontResult(`✓ ${result.message}`);

      // Refresh evidence to show updated Stage 1 status
      if (refreshEvidence) {
        refreshEvidence();
      }
    } catch (error) {
      showLockFrontResult(`✗ Lock front failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLockingFront(false);
    }
  };

  // Capture back image handler (Nov 19: Stage 1A → Stage 1B transition)
  const handleCaptureBack = async () => {
    if (!job) {
      showCaptureBackResult("✗ No job selected");
      return;
    }

    // Nov 19: Check front_locked instead of product_uid (Stage 1A prerequisite)
    if (!job.front_locked) {
      showCaptureBackResult("✗ Front must be locked first (lock front to enable back capture)");
      return;
    }

    if (job.back_ready) {
      showCaptureBackResult("⚠ Back already captured");
      return;
    }

    setCapturingBack(true);
    setCaptureBackResult(null);

    try {
      // Nov 19: Use scan-based capture endpoint (Stage 1 flow)
      const result = await captureBackForScan(job.id);
      showCaptureBackResult(`✓ ${result.message}`);

      // Refresh evidence to show updated Stage 1B status
      if (refreshEvidence) {
        refreshEvidence();
      }
    } catch (error) {
      showCaptureBackResult(`✗ Back capture failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCapturingBack(false);
    }
  };

  // Lock+Accept combo handler (Codex UX optimization)
  const handleLockAndAccept = async () => {
    if (!job) return;
    setLockingAndAccepting(true);
    try {
      // Step 1: Lock canonical identity
      await lockCanonical(job.id, { truth_core: truthCore });
      // Step 2: Refresh evidence to get updated job state
      if (refreshEvidence) {
        await refreshEvidence();
      }
      // Step 3: Trigger accept (parent component handles the actual accept logic)
      onAccept();
    } catch (error) {
      console.error("Lock+Accept failed:", error);
    } finally {
      setLockingAndAccepting(false);
    }
  };

  // Toggle collapsible section
  const toggleSection = (section: keyof typeof sectionsCollapsed) => {
    setSectionsCollapsed((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  // Keyboard shortcuts: L for Lock, Arrow keys for candidate navigation (Codex UX optimization)
  useEffect(() => {
    const handleLockAndNav = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      // L = Lock (front if not locked, else canonical if not locked)
      if (e.key.toLowerCase() === "l") {
        if (job && !job.front_locked) {
          handleLockFront();
        }
        return;
      }

      // Arrow keys for candidate navigation
      const variantCount = evidence?.variants?.length ?? 0;
      if (variantCount === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (chosen === null) {
          setChosen(0);
        } else if (chosen < variantCount - 1) {
          setChosen(chosen + 1);
        }
        setSelectionSource("top3");
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (chosen === null) {
          setChosen(0);
        } else if (chosen > 0) {
          setChosen(chosen - 1);
        }
        setSelectionSource("top3");
      }
    };

    window.addEventListener("keydown", handleLockAndNav);
    return () => window.removeEventListener("keydown", handleLockAndNav);
  }, [job, evidence?.variants, chosen, setChosen, setSelectionSource, handleLockFront]);

  // Memoize TruthCorePanel props to prevent useEffect reset on every render.
  // MUST be before any early returns to maintain consistent hook call order.
  const memoizedInitialTruth = useMemo(() => {
    if (job?.accepted_name) {
      return {
        name: job.accepted_name,
        hp: job.accepted_hp ?? null,
        collector_no: job.accepted_collector_no ?? "",
        set_name: job.accepted_set_name ?? "",
        set_size: job.accepted_set_size ?? null,
        variant_tags: job.accepted_variant_tags ?? [],
      };
    }
    return variantTelemetry?.truth_core;
  }, [
    job?.accepted_name,
    job?.accepted_hp,
    job?.accepted_collector_no,
    job?.accepted_set_name,
    job?.accepted_set_size,
    job?.accepted_variant_tags,
    variantTelemetry?.truth_core
  ]);

  // Compute bestGuess from evidence.modelVerdict and pptBestGuess prop
  const memoizedBestGuess = useMemo(() => {
    const hasPptOverride = Boolean(pptBestGuess?.title);
    const mvProductName = evidence?.modelVerdict?.productName;
    const mvSetName = evidence?.modelVerdict?.setName;
    const mvSetNumber = evidence?.modelVerdict?.setNumber;

    const name = (hasPptOverride && pptBestGuess?.title) || mvProductName || "Unknown Card";
    const setName = (hasPptOverride && (pptBestGuess?.setName || null)) || mvSetName || "Unknown Set";
    const setNumber = (hasPptOverride && (pptBestGuess?.cardNumber || null)) || mvSetNumber || "—";

    return {
      name: name !== "Unknown Card" ? name : null,
      set_name: setName !== "Unknown Set" ? setName : null,
      collector_no: setNumber !== "—" ? setNumber : null,
      hp: null,
    };
  }, [evidence?.modelVerdict, pptBestGuess]);

  // No job selected
  if (!job) {
    return (
      <div className="panel" style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--muted)" }}>
        Select a job
      </div>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="panel" style={{ height: "100%", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--muted)" }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
          <div>Loading evidence...</div>
        </div>
      </div>
    );
  }

  // Fallback UI when evidence is unavailable or null
  if (!evidence || evidence.status === "UNAVAILABLE") {
    // In production, avoid alarming banner text; show a subtle info state instead.
    const showBanner = !(import.meta.env && import.meta.env.PROD);
    const bannerMessage = !featureEnabled
      ? "Evidence UI disabled via feature flag — showing legacy candidates."
      : evidence
        ? "Evidence marked unavailable — falling back to legacy review."
        : "Evidence not returned — falling back to legacy review.";

    return (
      <LegacyDetailsPanel
        job={job}
        chosen={chosen}
        setChosen={setChosen}
        onAccept={onAccept}
        onFlag={onFlag}
        setVariantTelemetry={setVariantTelemetry}
        condition={condition}
        setCondition={setCondition}
        bannerMessage={bannerMessage}
        showBanner={showBanner}
      />
    );
  }

  // Evidence available - render full UI
  const { status, provenance, modelVerdict, checks, variants: rawVariants, alerts, breadcrumbs, inventory } = evidence;
  const variants = rawVariants.map((variant) => ({
    ...variant,
    confidence: variant.score,
    source: inferVariantSource(variant.productId),
  }));
  const enrichmentSignals = (pptEnrichmentContext?.signals ?? (inventory as any)?.enrichment_signals ?? null) as
    | { [key: string]: any }
    | null;
  const parseTitleSignals = enrichmentSignals?.parseTitle ?? null;
  const pptMatchCandidates: PPTMatchCandidate[] | null = Array.isArray(parseTitleSignals?.allMatches)
    ? parseTitleSignals.allMatches
    : null;
  const pptStrategy = (pptEnrichmentContext?.strategy ?? enrichmentSignals?.lookupStrategy ?? null) as PPTStrategy | null;
  const pptBridgeId = pptEnrichmentContext?.bridgeId ?? null;
  const pptRequestedTitle = pptEnrichmentContext?.parseTitleRequest
    ?? (parseTitleSignals && typeof parseTitleSignals === "object" ? parseTitleSignals.requestedTitle ?? null : null);
  const pptCardSummary = enrichmentSignals?.cardSummary ?? null;
  const hasPptOverride = Boolean(pptBestGuess?.title);
  const bestGuessName =
    (hasPptOverride && pptBestGuess?.title) || modelVerdict.productName || "Unknown Card";
  const bestGuessSetName =
    (hasPptOverride && (pptBestGuess?.setName || null)) || modelVerdict.setName || "Unknown Set";
  const bestGuessSetNumber =
    (hasPptOverride && (pptBestGuess?.cardNumber || null)) || modelVerdict.setNumber || "—";
  const bestGuessConfidence =
    (hasPptOverride && typeof pptBestGuess?.confidence === "number" ? pptBestGuess?.confidence : null) ??
    (typeof modelVerdict.confidence === "number" ? modelVerdict.confidence : null);

  // Best guess source: canonical > pricecharting > model inference
  const bestGuessSource: string | undefined =
    variants?.[0]?.source === "canonical"
      ? "canonical"
      : hasPptOverride
      ? "pricecharting"
      : undefined;
  const candidates = job.candidates ?? [];
  // Image readiness checks (Stage 1 flow)
  const hasFrontImage = Boolean(
    inventory?.cdn_image_url ||
    job?.image_path ||
    job?.processed_image_path ||
    job?.raw_image_path
  );
  // Stage 1: Use back_ready flag instead of inventory.cdn_back_image_url
  const hasBackImage = Boolean(job.back_ready);
  // Gate back capture on front_locked (Stage 1A complete)
  const canAttemptBackCapture = Boolean(job.front_locked && !hasBackImage);
  const pillInteractive = canAttemptBackCapture && !capturingBack;
  const isFallbackCardId = Boolean(inventory?.cm_card_id && inventory.cm_card_id.startsWith("UNKNOWN_"));
  // Accept gating: Stage 1 prerequisites must be met before Stage 2 (Accept)
  // Stage 1A: front_locked
  // Stage 1B: back_ready (back image captured) - SKIPPED in baseline mode
  // Stage 1C: canonical_locked (canonical ID resolved) - SKIPPED in baseline mode
  const stage1Complete = isBaseline
    ? Boolean(job.front_locked) // Baseline: only front_locked required
    : Boolean(job.front_locked && job.back_ready && job.canonical_locked);
  // Verification: explicit truthVerified OR canonical_locked (locking canonical implies truth verified)
  // In baseline mode, truthVerified alone is sufficient
  const verifiedOk = isBaseline ? true : (truthVerified || Boolean(job.canonical_locked));
  const actionableStatus = ["OPERATOR_PENDING", "CANDIDATES_READY", "UNMATCHED_NO_REASONABLE_CANDIDATE"].includes(job.status as any);
  const truthCoreComplete = Boolean(truthCore.name.trim() !== "" && truthCore.collector_no.trim() !== "" && truthCore.set_name.trim() !== "");
  // Non-baseline: Accept acts as a macro (locks front → countdown → captures back → locks identity → Accept).
  // Baseline: keep strict gating (baseline has its own accept button).
  const canAccept = isBaseline
    ? Boolean(stage1Complete && actionableStatus && verifiedOk && truthCoreComplete)
    : Boolean(actionableStatus && truthCoreComplete && hasFrontImage);
  const canFlag = job.status !== "FLAGGED";



  // Accept tooltip logic
  const getAcceptTooltip = (): string => {
    if (!hasFrontImage) return "Front image missing";
    if (!truthCoreComplete) return "Complete Truth Core (Name, Set Name, Set Number)";
    if (!isBaseline && (!job.front_locked || !job.back_ready || !job.canonical_locked)) {
      return "Accept will lock front, start a short countdown, capture back, lock identity, then accept";
    }
    if (truthCore.name.trim() === "") return "Enter card name before accepting";
    if (truthCore.collector_no.trim() === "") return "Enter collector number before accepting";
    if (truthCore.set_name.trim() === "") return "Enter set name before accepting";
    return isBaseline ? "Accept (Baseline Mode)" : "Accept";
  };

  return (
    <div
      className="panel"
      style={{ height: "100%", padding: 12, display: "grid", gridTemplateRows: "auto auto 1fr auto", gap: 12, overflowY: "auto" }}
    >
      {/* Truth Core Panel (MVP) */}
      <TruthCorePanel
        job={job}
        verified={truthVerified}
        onVerifyChange={(v) => {
          setTruthVerified(v);
          setVariantTelemetry((prev) => ({ ...prev, set_verified: v, truth_verified: v, truth_verified_at: Date.now() }));
        }}
        onTruthChange={(tc) => {
          setTruthCore(tc);
          const valid = tc.name.trim() !== "" && tc.collector_no.trim() !== "" && tc.set_name.trim() !== "";
          setVariantTelemetry((prev) => ({ ...prev, truth_core: tc, truth_valid: valid, truth_last_changed_at: Date.now() }));
        }}
        initialTruth={memoizedInitialTruth}
        bestGuess={memoizedBestGuess}
        condition={condition}
        onConditionChange={setCondition}
        refreshJob={refreshJob}
        onBaselineAccepted={onBaselineAccepted}
      />
      {/* Image Readiness Status (Phase 2J: two-capture workflow) */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>Images:</span>
          <span
            className="pill"
            style={{
              fontSize: 11,
              background: hasFrontImage ? "#dcfce7" : "#fee2e2",
              color: hasFrontImage ? "#166534" : "#991b1b",
              borderColor: "transparent",
            }}
          >
            {hasFrontImage ? "✓ Front ready" : "⚠ Front missing"}
          </span>
          <span
            className="pill"
            role="button"
            tabIndex={pillInteractive ? 0 : -1}
            aria-disabled={!pillInteractive}
            onClick={pillInteractive ? handleCaptureBack : undefined}
            onKeyDown={(event) => {
              if (!pillInteractive) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleCaptureBack();
              }
            }}
            style={{
              fontSize: 11,
              background: hasBackImage ? "#dcfce7" : "#fee2e2",
              color: hasBackImage ? "#166534" : "#991b1b",
              borderColor: "transparent",
              cursor: pillInteractive ? "pointer" : "default",
              opacity: capturingBack ? 0.6 : 1,
            }}
            title={
              pillInteractive
                ? "Click or press Enter/Space to capture back image"
                : capturingBack
                  ? "Capturing back image..."
                  : ""
            }
          >
            {capturingBack ? "⏳ Capturing..." : hasBackImage ? "✓ Back ready" : "⚠ Back missing"}
          </span>
        </div>
        {/* Back image thumbnail preview */}
        {hasBackImage && inventory?.cdn_back_image_url && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)" }}>Back Image:</span>
            <img
              src={inventory.cdn_back_image_url}
              alt="Card back"
              style={{
                width: 200,
                height: 200,
                objectFit: "contain",
                border: "1px solid var(--border)",
                borderRadius: 4,
                background: "var(--bg-secondary)",
              }}
            />
          </div>
        )}
      </div>
      {/* Header - compact card info */}
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            {(() => {
              // Check if operator has edited truth core
              const truthCore = variantTelemetry?.truth_core as { name?: string; hp?: number | null; collector_no?: string; set_name?: string } | undefined;
              const hasOperatorTruth = Boolean(
                truthCore && (truthCore.name || truthCore.collector_no || truthCore.set_name)
              );

              const displayName = hasOperatorTruth && truthCore?.name ? truthCore.name : (job.card_name || "—");
              const displayHp = hasOperatorTruth && truthCore?.hp !== undefined ? truthCore.hp : job.hp_value;
              const displaySetNumber = hasOperatorTruth && truthCore?.collector_no ? truthCore.collector_no : job.set_number;

              return (
                <>
                  <div style={{
                    fontWeight: 700,
                    fontSize: 18,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: hasOperatorTruth ? "4px 8px" : "0",
                    background: hasOperatorTruth ? "rgba(147, 197, 253, 0.15)" : "transparent",
                    borderRadius: hasOperatorTruth ? 4 : 0,
                    border: hasOperatorTruth ? "1px solid rgba(59, 130, 246, 0.3)" : "none",
                  }}>
                    {displayName}
                    {hasOperatorTruth && (
                      <span
                        className="pill"
                        title={`Original inference:\nName: ${job.card_name || "—"}\nHP: ${job.hp_value ?? "—"}\nSet #: ${job.set_number ?? "—"}`}
                        style={{
                          background: "#dbeafe",
                          color: "#1e40af",
                          borderColor: "transparent",
                          fontSize: 10,
                          padding: "2px 6px",
                          fontWeight: 600,
                          cursor: "help",
                        }}
                      >
                        Operator Truth
                      </span>
                    )}
                  </div>
                  <div style={{
                    color: "var(--muted)",
                    fontSize: 13,
                    padding: hasOperatorTruth ? "2px 8px" : "0",
                  }}>
                    HP {displayHp ?? "—"} • Set #{displaySetNumber ?? "—"}
                  </div>
                </>
              );
            })()}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {/* Export readiness */}
            {job.staging_ready !== undefined && (
              <span
                className="pill"
                title="EverShop export readiness"
                style={{
                  background: job.staging_ready ? "#dcfce7" : "#eef2f7",
                  color: job.staging_ready ? "#166534" : "#374151",
                  borderColor: "transparent",
                  fontSize: 12,
                }}
              >
                {job.staging_ready ? "Staging Ready" : "Not Staging"}
              </span>
            )}
            {/* Truth verification handled via TruthCorePanel checkbox */}
            <StatusBadge status={status} />
          </div>
        </div>
      </header>

      {/* Scrollable content */}
      <section style={{ display: "grid", gap: 16, alignContent: "start", overflowY: "auto" }}>
        {/* Alerts (always visible) */}
        {alerts.length > 0 && (
          <div style={{ background: "var(--warn)22", border: "1px solid var(--warn)", borderRadius: 4, padding: 10 }}>
            {alerts.map((alert, i) => (
              <div key={i} style={{ fontSize: 13, color: "var(--warn)", marginBottom: i < alerts.length - 1 ? 6 : 0 }}>
                {alert}
              </div>
            ))}
          </div>
        )}

        {/* Model Verdict (always visible) */}
        <div>
          <div style={{ fontWeight: 600, marginBottom: 8, opacity: 0.85, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Best Guess</span>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              {hasPptOverride && (
                <span className="pill" style={{ fontSize: 11, background: "#0ea5e922", color: "#0369a1", borderColor: "transparent" }}>
                  PPT
                </span>
              )}
              <span
                className="pill"
                style={{
                  fontSize: 11,
                  background: bestGuessSource === "canonical" ? "#dcfce7" : "#f3f4f6",
                  color: bestGuessSource === "canonical" ? "#166534" : "var(--muted)",
                  borderColor: "transparent",
                }}
                title={getSourceTooltip(bestGuessSource)}
              >
                {bestGuessSource ?? "model"}
              </span>
            </div>
          </div>
          <div className="list-item" style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600 }}>{bestGuessName}</div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  {bestGuessSetNumber} • {bestGuessSetName}
                </div>
              </div>
              {typeof bestGuessConfidence === "number" ? (
                <ConfidenceBadge confidence={bestGuessConfidence} />
              ) : (
                <span style={{ fontSize: 11, color: "var(--muted)" }}>—</span>
              )}
            </div>
            {/* PriceCharting link */}
            <a
              href={generatePriceChartingSearchUrl(bestGuessName, bestGuessSetNumber)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12, color: "var(--accent)" }}
            >
              View on PriceCharting →
            </a>
          </div>
        </div>

        {/* PPT Panel - Band 1: Identity & Actions */}
        <PPTPanel
          pptRequestedTitle={pptRequestedTitle}
          pptMatchCandidates={pptMatchCandidates}
          pptStrategy={pptStrategy}
          pptBridgeId={pptBridgeId}
          truthCoreSetName={truthCore.set_name}
          onApplySetName={(setName: string) => {
            const updatedCore = { ...truthCore, set_name: setName };
            setTruthCore(updatedCore);
            const valid = updatedCore.name.trim() !== "" && updatedCore.collector_no.trim() !== "" && updatedCore.set_name.trim() !== "";
            setVariantTelemetry((prev) => ({
              ...prev,
              truth_core: updatedCore,
              truth_valid: valid,
              truth_last_changed_at: Date.now(),
              ppt_set_name_applied: true,
              ppt_set_name_applied_at: Date.now(),
            }));
          }}
        />

        {/* Variants (advanced) — collapsed by default for MVP */}
        {variants.length > 0 && (
          <details>
            <summary style={{ cursor: "pointer", userSelect: "none" }}>Show candidates (advanced)</summary>
            {/* Fallback banner when non-canonical candidates present */}
            {variants.some((v) => v.source !== "canonical") && (
              <div
                style={{
                  fontSize: 11,
                  padding: "4px 8px",
                  margin: "6px 0",
                  background: "#fef3c7",
                  color: "#92400e",
                  border: "1px solid #fcd34d",
                  borderRadius: 4,
                }}
              >
                Some candidates from fallback source. Manual verification recommended.
              </div>
            )}
            <div>
              <div style={{ fontWeight: 600, marginBottom: 8, opacity: 0.85, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Variants ({variants.length})</span>
                {!variantDrawerExpanded && (
                  <button
                    onClick={handleFetchVariants}
                    disabled={variantsFetching}
                    style={{
                      fontSize: 11,
                      padding: "4px 8px",
                      background: "var(--bg-secondary)",
                      border: "1px solid var(--accent)",
                      borderRadius: 4,
                      cursor: "pointer",
                      color: "var(--accent)",
                    }}
                    title="Show expanded variants (advanced)"
                  >
                    {variantsFetching ? "Loading..." : "More variants →"}
                  </button>
                )}
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {variants.map((variant, i) => (
                  <VariantRow
                    key={variant.productId}
                    variant={variant}
                    index={i}
                    chosen={chosen === i}
                    canSelect={canAccept}
                    onSelect={() => {
                      if (canAccept) {
                        setChosen(i);
                        setSelectionSource("top3");
                        setSelectedExpandedVariantId(null);
                      }
                    }}
                    onPreview={() => showFlyout({ id: variant.productId, title: variant.productName })}
                  />
                ))}
              </div>
            </div>
          </details>
        )}

        {/* Expanded Variant Drawer */}
        {variantDrawerExpanded && (
          <div style={{ border: "1px solid var(--accent)", borderRadius: 4, padding: 12, background: "var(--bg-secondary)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontWeight: 600 }}>Family Variants ({expandedVariants.length})</div>
              <button
                onClick={() => {
                  setVariantDrawerExpanded(false);
                  // Track drawer close telemetry
                  setVariantTelemetry((prev) => ({
                    ...prev,
                    drawer_closed_at: Date.now(),
                  }));
                }}
                style={{
                  fontSize: 11,
                  padding: "4px 8px",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                Collapse ▲
              </button>
            </div>

            {/* Filter Controls - Simplified for MVP */}
            <div style={{ marginBottom: 12, fontSize: 11, color: "var(--muted)" }}>
              <div>Use hotkeys 4-9, 0 to select expanded variants</div>
            </div>

            {/* Expanded Variant List */}
            {variantsError ? (
              <div style={{ color: "var(--bad)", fontSize: 12, padding: 8 }}>
                ✗ {variantsError}
              </div>
            ) : expandedVariants.length === 0 ? (
              <div style={{ color: "var(--muted)", fontSize: 12, padding: 8 }}>
                No additional variants found in this family
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8, maxHeight: 400, overflowY: "auto" }}>
                {expandedVariants.map((variant, i) => (
                  <div
                    key={variant.id}
                    className="list-item"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      cursor: "pointer",
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                    }}
                    onClick={() => {
                      // Store the selected expanded variant locally (for UI feedback)
                      setSelectedExpandedVariant({
                        id: variant.id,
                        title: variant.title,
                        index: i,
                      });

                      // Store in parent for accept handler
                      setSelectedExpandedVariantId(variant.id);

                      // Set selection source to expanded_family
                      setSelectionSource("expanded_family");

                      // Track telemetry
                      setVariantTelemetry((prev) => ({
                        ...prev,
                        expanded_variant_selected_at: Date.now(),
                        expanded_variant_index: i,
                        expanded_variant_id: variant.id,
                        expanded_variant_title: variant.title,
                      }));

                      console.log("Selected expanded variant:", variant, "index:", i);
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        <span className="pill" style={{ fontSize: 10, marginRight: 6, background: "var(--accent)22", color: "var(--accent)" }}>
                          {i + 4 <= 9 ? i + 4 : 0}
                        </span>
                        {variant.title}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>
                        <span title={getSourceTooltip(variant.source)}>{variant.source}</span>
                        {" • "}
                        <a
                          href={generatePriceChartingUrl(variant.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "var(--accent)" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          PriceCharting →
                        </a>
                        {" • "}
                        <button
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--accent)",
                            cursor: "pointer",
                            fontSize: 11,
                            padding: 0,
                            textDecoration: "underline",
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            showFlyout({ id: variant.id, title: variant.title });
                          }}
                        >
                          Preview 🔍
                        </button>
                      </div>
                    </div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                      {Math.round(variant.confidence * 100)}%
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Collapsible: Signals & Checks */}
        <CollapsibleSection
          title="Signals & Checks"
          collapsed={sectionsCollapsed.signalsAndChecks}
          onToggle={() => toggleSection("signalsAndChecks")}
        >
          {/* Top Signals */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>Top Signals</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {modelVerdict.why.slice(0, 5).map((signal, i) => (
                <SignalPill key={i} signal={signal} />
              ))}
            </div>
          </div>

          {/* Field Checks Table */}
          <div>
            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>Field Checks</div>
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600 }}>Field</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600 }}>Extracted</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600 }}>Canonical</th>
                  <th style={{ textAlign: "center", padding: "6px 8px", fontWeight: 600 }}>✓</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((check, i) => (
                  <tr key={i} style={{ borderBottom: i < checks.length - 1 ? "1px solid var(--border)" : "none" }}>
                    <td style={{ padding: "6px 8px", fontWeight: 600 }}>{check.field}</td>
                    <td style={{ padding: "6px 8px", fontFamily: "var(--mono)" }}>{check.extracted ?? "—"}</td>
                    <td style={{ padding: "6px 8px", fontFamily: "var(--mono)" }}>{check.canonical ?? "—"}</td>
                    <td style={{ padding: "6px 8px", textAlign: "center" }}>
                      {check.pass ? "✓" : "✗"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {checks.some((c) => c.note) && (
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
                {checks.filter((c) => c.note).map((c, i) => (
                  <div key={i}>
                    <strong>{c.field}:</strong> {c.note}
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* Collapsible: Inventory & Actions */}
        {inventory && (
          <CollapsibleSection
            title="Inventory & Actions"
            collapsed={sectionsCollapsed.inventory}
            onToggle={() => toggleSection("inventory")}
          >
            <div style={{ display: "grid", gap: 8, fontSize: 12 }}>
              {/* Product SKU */}
              {inventory.product_sku && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "var(--muted)", minWidth: 100 }}>Product SKU:</span>
                  <span
                    className="pill"
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      backgroundColor: "var(--accent)22",
                      color: "var(--accent)",
                    }}
                  >
                    {inventory.product_sku}
                  </span>
                </div>
              )}

              {/* Item UID */}
              {inventory.item_uid && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "var(--muted)", minWidth: 100 }}>Item UID:</span>
                  <span
                    className="pill"
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      backgroundColor: "var(--good)22",
                      color: "var(--good)",
                    }}
                  >
                    {inventory.item_uid.slice(0, 8)}...
                  </span>
                </div>
              )}

              {/* CardMint ID */}
              {inventory.cm_card_id && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ color: "var(--muted)", minWidth: 100 }}>CardMint ID:</span>
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: isFallbackCardId ? "var(--bad)" : "inherit",
                    }}
                    title={isFallbackCardId ? "Fallback CardMint ID — canonicalize when ready" : "CardMint canonical identifier"}
                  >
                    {inventory.cm_card_id}
                  </span>
                  {isFallbackCardId && (
                    <>
                      <span
                        className="pill"
                        style={{
                          fontSize: 10,
                          background: "#fef3c7",
                          color: "#92400e",
                          borderColor: "transparent",
                        }}
                      >
                        Fallback ID
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          // Scroll to and expand the variants section for candidate selection
                          const details = document.querySelector("details:has(summary)");
                          if (details instanceof HTMLDetailsElement) {
                            details.open = true;
                            details.scrollIntoView({ behavior: "smooth", block: "center" });
                          }
                        }}
                        style={{
                          fontSize: 10,
                          padding: "2px 8px",
                          background: "#dbeafe",
                          border: "1px solid #3b82f6",
                          borderRadius: 3,
                          cursor: "pointer",
                          color: "#1e40af",
                          fontWeight: 600,
                        }}
                        title="Open candidate picker to resolve canonical ID"
                      >
                        Resolve
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Listing SKU */}
              {inventory.listing_sku && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "var(--muted)", minWidth: 100 }}>Listing SKU:</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>
                    {inventory.listing_sku}
                  </span>
                </div>
              )}

              {/* Staging Ready Status */}
              {job?.staging_ready !== undefined && (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ color: "var(--muted)", minWidth: 100 }}>Staging:</span>
                    <span
                      className="pill"
                      style={{
                        fontSize: 11,
                        background: job.staging_ready ? "#dcfce7" : "#eef2f7",
                        color: job.staging_ready ? "#166534" : "#6b7280",
                        borderColor: "transparent",
                      }}
                    >
                      {job.staging_ready ? "Ready" : "Not ready"}
                    </span>
                  </div>
                  {/* Readiness blockers (when not staging_ready) */}
                  {!job.staging_ready && ((!inventory.cm_card_id) || inventory.cm_card_id.startsWith("UNKNOWN_") || !inventory.cdn_image_url) && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginLeft: 108 }}>
                      {/* Needs canonicalization */}
                      {(!inventory.cm_card_id || inventory.cm_card_id.startsWith("UNKNOWN_")) && (
                        <span
                          className="pill"
                          style={{
                            fontSize: 10,
                            background: "#fecaca",
                            color: "#991b1b",
                            borderColor: "transparent",
                          }}
                          title="Canonical card ID required (not UNKNOWN_*)"
                        >
                          ⚠️ Needs canonicalization
                        </span>
                      )}
                      {/* Image not published */}
                      {!inventory.cdn_image_url && (
                        <span
                          className="pill"
                          style={{
                            fontSize: 10,
                            background: "#fef3c7",
                            color: "#92400e",
                            borderColor: "transparent",
                          }}
                          title="Image must be published to CDN"
                        >
                          ⚠️ Image not published
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Image Publication Status */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "var(--muted)", minWidth: 100 }}>Image:</span>
                {inventory.cdn_image_url ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      className="pill"
                      style={{
                        fontSize: 11,
                        background: "#dcfce7",
                        color: "#166534",
                        borderColor: "transparent",
                      }}
                    >
                      Published
                    </span>
                    <a
                      href={inventory.cdn_image_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 11, color: "var(--accent)" }}
                    >
                      View CDN →
                    </a>
                  </div>
                ) : (
                  <span
                    className="pill"
                    style={{
                      fontSize: 11,
                      background: "#fee2e2",
                      color: "#991b1b",
                      borderColor: "transparent",
                    }}
                  >
                    Not published
                  </span>
                )}
              </div>
            </div>

            {/* Inventory Actions */}
            <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <button
                onClick={() => setShowInventoryActions(!showInventoryActions)}
                style={{
                  fontSize: 11,
                  padding: "4px 8px",
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  cursor: "pointer",
                  width: "100%",
                  textAlign: "left",
                }}
              >
                {showInventoryActions ? "▼" : "▶"} Inventory Actions
              </button>

              {showInventoryActions && (
                <div style={{ marginTop: 8, display: "grid", gap: 8, fontSize: 12 }}>
                  {/* Split to New Item */}
                  <div>
                    <button
                      onClick={handleSplitToNewItem}
                      disabled={!inventory.item_uid || inventoryActionInProgress}
                      className="btn"
                      style={{ width: "100%", fontSize: 11, padding: "6px 10px" }}
                    >
                      Split to New Item
                    </button>
                    <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
                      Create a new item for this scan (if wrongly merged)
                    </div>
                  </div>

                  {/* Attach to Item */}
                  <div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        type="text"
                        placeholder="Target item UID"
                        value={targetItemUid}
                        onChange={(e) => setTargetItemUid(e.target.value)}
                        disabled={inventoryActionInProgress}
                        style={{
                          flex: 1,
                          padding: "6px 10px",
                          fontSize: 11,
                          fontFamily: "var(--mono)",
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          background: "var(--bg)",
                        }}
                      />
                      <button
                        onClick={handleAttachToItem}
                        disabled={!targetItemUid.trim() || inventoryActionInProgress}
                        className="btn"
                        style={{ fontSize: 11, padding: "6px 10px" }}
                      >
                        Attach
                      </button>
                    </div>
                    <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
                      Attach this scan to a different item (fix wrong SKU)
                    </div>
                  </div>

                  {/* Action Result */}
                  {inventoryActionResult && (
                    <div
                      style={{
                        padding: 8,
                        fontSize: 11,
                        borderRadius: 4,
                        background: inventoryActionResult.startsWith("✓") ? "var(--good)22" : "var(--bad)22",
                        color: inventoryActionResult.startsWith("✓") ? "var(--good)" : "var(--bad)",
                        border: `1px solid ${inventoryActionResult.startsWith("✓") ? "var(--good)" : "var(--bad)"}`,
                      }}
                    >
                      {inventoryActionResult}
                    </div>
                  )}
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}

        {/* Collapsible: Telemetry & Provenance */}
        <CollapsibleSection
          title="Telemetry & Provenance"
          collapsed={sectionsCollapsed.telemetry}
          onToggle={() => toggleSection("telemetry")}
        >
          {/* Provenance Metadata */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>Provenance</div>
            <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>
              <div>Scorer: {provenance.scorer_version}</div>
              <div>Signal Schema: {provenance.signal_schema}</div>
              <div>Corpus Hash: {provenance.corpus_hash.slice(0, 8)}</div>
            </div>
          </div>

          {/* Breadcrumbs */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>Breadcrumbs</div>
            <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>
              {job.timings?.distortion_ms != null && (
                <div>Distortion Correction: {Math.round(job.timings.distortion_ms)} ms</div>
              )}
              {job.timings?.processing_ms != null && (
                <div>Resize/Compress: {Math.round(job.timings.processing_ms)} ms</div>
              )}
              {job.timings?.preprocessing_ms != null && (
                <div>Preprocessing Total: {Math.round(job.timings.preprocessing_ms)} ms</div>
              )}
              {job.timings?.inference_ms != null && (
                <div>Inference: {Math.round(job.timings.inference_ms)} ms</div>
              )}
              {breadcrumbs.inference_path && <div>Inference Path: {breadcrumbs.inference_path}</div>}
              {breadcrumbs.pathA_ms != null && <div>Path A: {breadcrumbs.pathA_ms} ms</div>}
              {breadcrumbs.retries > 0 && <div>Retries: {breadcrumbs.retries}</div>}
              {breadcrumbs.captureUid && <div>Capture UID: {breadcrumbs.captureUid.slice(0, 16)}</div>}
            </div>
          </div>

          {/* Path C Set Triangulation (only when Path C ran) */}
          {breadcrumbs.pathC?.ran && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>
                Path C Triangulation
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span>Action:</span>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 6px",
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      background:
                        breadcrumbs.pathC.action === "hard_filter"
                          ? "var(--good)22"
                          : breadcrumbs.pathC.action === "soft_rerank"
                          ? "#fef3c7"
                          : breadcrumbs.pathC.action === "error"
                          ? "var(--bad)22"
                          : "var(--muted)22",
                      color:
                        breadcrumbs.pathC.action === "hard_filter"
                          ? "var(--good)"
                          : breadcrumbs.pathC.action === "soft_rerank"
                          ? "#92400e"
                          : breadcrumbs.pathC.action === "error"
                          ? "var(--bad)"
                          : "var(--muted)",
                    }}
                  >
                    {breadcrumbs.pathC.action === "hard_filter" && "✓ "}
                    {breadcrumbs.pathC.action === "soft_rerank" && "↗ "}
                    {breadcrumbs.pathC.action === "discard" && "× "}
                    {breadcrumbs.pathC.action === "error" && "! "}
                    {breadcrumbs.pathC.action.replace("_", " ")}
                  </span>
                </div>
                {breadcrumbs.pathC.confidence != null && (
                  <div style={{ marginBottom: 4 }}>
                    <span>Confidence: </span>
                    <span
                      style={{
                        fontWeight: 600,
                        color:
                          breadcrumbs.pathC.action === "hard_filter"
                            ? "var(--good)"
                            : breadcrumbs.pathC.action === "soft_rerank"
                            ? "#92400e"
                            : "var(--muted)",
                      }}
                    >
                      {Math.round(breadcrumbs.pathC.confidence * 100)}%
                    </span>
                  </div>
                )}
                {breadcrumbs.pathC.setHint && (
                  <div style={{ marginBottom: 4 }}>Set Hint: {breadcrumbs.pathC.setHint}</div>
                )}
                {breadcrumbs.pathC.latencyMs != null && (
                  <div style={{ marginBottom: 4 }}>Latency: {breadcrumbs.pathC.latencyMs} ms</div>
                )}
                {breadcrumbs.pathC.matchingSignals.length > 0 && (
                  <div>Signals: {breadcrumbs.pathC.matchingSignals.join(", ")}</div>
                )}
              </div>
            </div>
          )}

          {/* PPT Raw Signals (debug) */}
          {(pptStrategy || pptBridgeId || pptCardSummary || enrichmentSignals) && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>PPT Raw Signals</div>
              <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>
                {pptStrategy && (
                  <div>Strategy: {pptStrategy}</div>
                )}
                {pptBridgeId && (
                  <div>Bridge ID: {pptBridgeId}</div>
                )}
                {pptRequestedTitle && (
                  <div>Requested Title: {pptRequestedTitle}</div>
                )}
                {pptCardSummary && (
                  <div>
                    Matched Card: {pptCardSummary.name ?? "Unknown"}
                    {pptCardSummary.cardNumber && ` #${pptCardSummary.cardNumber}`}
                    {pptCardSummary.totalSetNumber && `/${pptCardSummary.totalSetNumber}`}
                    {pptCardSummary.setName && ` (${pptCardSummary.setName})`}
                  </div>
                )}
                {enrichmentSignals && (
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ cursor: "pointer", userSelect: "none" }}>
                      Raw Enrichment Signals (JSON)
                    </summary>
                    <pre style={{ fontSize: 10, marginTop: 6, overflow: "auto", maxHeight: 200 }}>
                      {JSON.stringify(enrichmentSignals, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            </div>
          )}
        </CollapsibleSection>
      </section>

      {/* Footer actions - always visible */}
      <footer style={{ display: "grid", gap: 8 }}>
        {/* Lock front status message (Nov 19: Stage 1A) */}
        {lockFrontResult && (
          <div
            style={{
              padding: 8,
              fontSize: 12,
              borderRadius: 4,
              background: lockFrontResult.startsWith("✓") ? "var(--good)22" : lockFrontResult.startsWith("⚠") ? "#fef3c7" : "var(--bad)22",
              color: lockFrontResult.startsWith("✓") ? "var(--good)" : lockFrontResult.startsWith("⚠") ? "#92400e" : "var(--bad)",
              border: `1px solid ${lockFrontResult.startsWith("✓") ? "var(--good)" : lockFrontResult.startsWith("⚠") ? "#fbbf24" : "var(--bad)"}`,
            }}
          >
            {lockFrontResult}
          </div>
        )}
        {/* Back capture status message (Nov 19: Stage 1B) */}
        {captureBackResult && (
          <div
            style={{
              padding: 8,
              fontSize: 12,
              borderRadius: 4,
              background: captureBackResult.startsWith("✓") ? "var(--good)22" : captureBackResult.startsWith("⚠") ? "#fef3c7" : "var(--bad)22",
              color: captureBackResult.startsWith("✓") ? "var(--good)" : captureBackResult.startsWith("⚠") ? "#92400e" : "var(--bad)",
              border: `1px solid ${captureBackResult.startsWith("✓") ? "var(--good)" : captureBackResult.startsWith("⚠") ? "#fbbf24" : "var(--bad)"}`,
            }}
          >
            {captureBackResult}
          </div>
        )}
        {/* Stage Progress Pills - inline checklist */}
        <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
          <StagePill done={Boolean(job?.front_locked)} label="Front locked" stage="1A" />
          <StagePill done={Boolean(job?.back_ready)} label="Back captured" stage="1B" />
          <StagePill done={Boolean(job?.canonical_locked)} label="Identity locked" stage="1C" />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {/* Lock Front button (Nov 19: Stage 1A - shown when front exists but not locked) */}
          {hasFrontImage && !job?.front_locked && (
            <button
              className="btn"
              onClick={handleLockFront}
              disabled={lockingFront}
              title="Stage 1A: Lock front image for canonical matching"
              style={{
                background: "#dbeafe",
                color: "#1e40af",
                borderColor: "#3b82f6",
                fontWeight: 600,
              }}
            >
              {lockingFront ? "⏳ Locking..." : "🔒 Lock Front"}
            </button>
          )}
          {/* Capture Back button (Nov 19: Stage 1A → Stage 1B - shown when front locked but back missing) */}
          {job?.front_locked && !job?.back_ready && (
            <button
              className="btn"
              onClick={handleCaptureBack}
              disabled={capturingBack}
              title="Stage 1B: Capture back image for variant context"
              style={{
                background: "#fef3c7",
                color: "#92400e",
                borderColor: "#fbbf24",
                fontWeight: 600,
              }}
            >
              {capturingBack ? "⏳ Capturing..." : "📸 Capture Back"}
            </button>
          )}
          {/* Lock+Accept combo button (Codex UX: shown when Stage 1A+1B done, 1C pending, high confidence, truth verified+complete) */}
          {job?.front_locked && job?.back_ready && !job?.canonical_locked &&
           bestGuessConfidence !== null && bestGuessConfidence >= 0.7 &&
           truthCore.name.trim() !== "" && truthCore.collector_no.trim() !== "" && truthCore.set_name.trim() !== "" && (
            <button
              className="btn"
              onClick={handleLockAndAccept}
              disabled={lockingAndAccepting}
              title="Lock canonical identity and accept in one step (high confidence)"
              style={{
                background: "#dcfce7",
                color: "#166534",
                borderColor: "#86efac",
                fontWeight: 600,
              }}
            >
              {lockingAndAccepting ? "⏳ Processing..." : "⚡ Lock + Accept"}
            </button>
          )}
          <button className="btn danger" onClick={onFlag} disabled={!canFlag}>
            Flag (F)
          </button>
          <button
            className="btn primary"
            onClick={onAccept}
            disabled={!canAccept}
            title={getAcceptTooltip()}
            style={{ flex: 1 }}
          >
            Accept (Enter)
          </button>
        </div>
      </footer>

      {/* Flyout Preview Overlay */}
      {flyoutVariant && jobId && (
        <FlyoutPreview
          variant={flyoutVariant}
          imageUrl={jobImageUrl(jobId)}
          onDismiss={dismissFlyout}
        />
      )}
    </div>
  );
};

// ============================================================================
// PPT Panel Component (Step 1: Band 1 - Identity & Actions)
// ============================================================================

function PPTPanel({
  pptRequestedTitle,
  pptMatchCandidates,
  pptStrategy,
  pptBridgeId,
  truthCoreSetName,
  onApplySetName,
}: {
  pptRequestedTitle: string | null;
  pptMatchCandidates: PPTMatchCandidate[] | null;
  pptStrategy: PPTStrategy | null;
  pptBridgeId: string | null;
  truthCoreSetName: string;
  onApplySetName: (setName: string) => void;
}) {
  // Don't render if no PPT data
  if (!pptRequestedTitle && (!pptMatchCandidates || pptMatchCandidates.length === 0)) {
    return null;
  }

  const formatStrategyChip = (strategy: PPTStrategy | null): string => {
    if (!strategy) return "";
    if (strategy === "pricecharting_bridge") return "Bridge";
    if (strategy === "pricecharting_bridge_fallback_parse_title") return "Bridge→Parse";
    return "Parse";
  };

  return (
    <div className="list-item" style={{ display: "grid", gap: 12 }}>
      {/* Header with title and strategy chips */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>PriceCharting Enrichment</div>
        <div style={{ display: "flex", gap: 4 }}>
          {pptStrategy && (
            <span className="pill" style={{ fontSize: 10, background: "#0ea5e922", color: "#0369a1", borderColor: "transparent" }}>
              {formatStrategyChip(pptStrategy)}
            </span>
          )}
          {pptBridgeId && (
            <span className="pill" style={{ fontSize: 10, background: "#0ea5e922", color: "#0369a1", borderColor: "transparent" }}>
              Bridge
            </span>
          )}
        </div>
      </div>

      {/* Requested Title (query) */}
      {pptRequestedTitle && (
        <div style={{ fontSize: 12 }}>
          <span style={{ color: "var(--muted)" }}>Query: </span>
          <code style={{ fontSize: 11 }}>{pptRequestedTitle}</code>
        </div>
      )}

      {/* Top-N Candidates */}
      {pptMatchCandidates && pptMatchCandidates.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.85 }}>
            Top Matches ({pptMatchCandidates.length})
          </div>
          {pptMatchCandidates.slice(0, 5).map((match) => {
            const isCurrentTruthSet = truthCoreSetName.trim() !== "" && match.setName === truthCoreSetName;
            return (
              <div
                key={match.id}
                className="list-item"
                style={{
                  padding: 10,
                  border: isCurrentTruthSet ? "2px solid #16a34a" : "1px solid var(--border)",
                  background: isCurrentTruthSet ? "#16a34a22" : match.isBestMatch ? "#0ea5e922" : "transparent",
                  borderRadius: 4,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: 10, opacity: 0.6 }}>#{match.rank}</span>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{match.name}</span>
                      {match.isBestMatch && (
                        <span className="pill" style={{ fontSize: 10, background: "#0ea5e922", color: "#0369a1", borderColor: "transparent" }}>
                          Best
                        </span>
                      )}
                      {isCurrentTruthSet && (
                        <span className="pill" style={{ fontSize: 10, background: "#16a34a22", color: "#16a34a", borderColor: "transparent" }}>
                          Current
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
                      {match.setName}
                      {match.cardNumber && ` • #${match.cardNumber}`}
                      {match.totalSetNumber && `/${match.totalSetNumber}`}
                    </div>
                    {/* Apply set name button */}
                    <button
                      onClick={() => onApplySetName(match.setName)}
                      disabled={isCurrentTruthSet}
                      style={{
                        fontSize: 11,
                        padding: "4px 8px",
                        background: isCurrentTruthSet ? "var(--bg-secondary)" : "var(--accent)22",
                        border: `1px solid ${isCurrentTruthSet ? "var(--border)" : "var(--accent)"}`,
                        borderRadius: 4,
                        cursor: isCurrentTruthSet ? "not-allowed" : "pointer",
                        color: isCurrentTruthSet ? "var(--muted)" : "var(--accent)",
                        opacity: isCurrentTruthSet ? 0.6 : 1,
                      }}
                      title={isCurrentTruthSet ? "This set name is already applied" : "Apply this set name to Truth Core"}
                    >
                      {isCurrentTruthSet ? "✓ Applied" : "Apply set name →"}
                    </button>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {typeof match.confidence === "number" && (
                      <ConfidenceBadge confidence={match.confidence} />
                    )}
                    {typeof match.marketPrice === "number" && (
                      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4, color: "var(--good)" }}>
                        ${match.marketPrice.toFixed(2)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Helper Components
// ============================================================================

function StatusBadge({ status }: { status: "AVAILABLE" | "UNAVAILABLE" | "PARTIAL" }) {
  const color =
    status === "AVAILABLE" ? "var(--good)" : status === "PARTIAL" ? "var(--warn)" : "var(--bad)";
  return (
    <span
      className="pill"
      style={{ borderColor: "transparent", background: `${color}22`, color, fontSize: "0.7rem" }}
    >
      {status}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const level = confidence >= 0.7 ? "HIGH" : confidence >= 0.5 ? "MEDIUM" : "LOW";
  const color = confidence >= 0.7 ? "#16a34a" : confidence >= 0.5 ? "#d97706" : "#dc2626";
  const bg = confidence >= 0.7 ? "#22c55e22" : confidence >= 0.5 ? "#f59e0b22" : "#ef444422";

  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 6px",
        borderRadius: 3,
        backgroundColor: bg,
        color,
      }}
      title={getConfidenceTooltip(confidence)}
    >
      {level} {Math.round(confidence * 100)}%
    </span>
  );
}

function SignalPill({ signal }: { signal: EvidenceSignal }) {
  const color =
    signal.strength === "strong" ? "var(--good)" : signal.strength === "medium" ? "var(--warn)" : "var(--muted)";
  return (
    <span
      className="pill"
      style={{
        fontSize: 10,
        background: `${color}11`,
        color,
        border: `1px solid ${color}44`,
      }}
      title={signal.detail}
    >
      {signal.key} {signal.detail && `(${signal.detail})`}
    </span>
  );
}

function CollapsibleSection({
  title,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          padding: "8px 12px",
          background: "var(--bg-secondary)",
          border: "none",
          borderBottom: collapsed ? "none" : "1px solid var(--border)",
          cursor: "pointer",
          textAlign: "left",
          fontSize: 13,
          fontWeight: 600,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>{title}</span>
        <span style={{ fontSize: 10, color: "var(--muted)" }}>{collapsed ? "▶" : "▼"}</span>
      </button>
      {!collapsed && (
        <div style={{ padding: 12 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function VariantRow({
  variant,
  index,
  chosen,
  canSelect,
  onSelect,
  onPreview,
}: {
  variant: {
    productId: string;
    productName: string;
    variantSuffix: string;
    setNumber: string | null;
    rarity: string | null;
    releaseYear: number | null;
    score: number;
    deltas: {
      name?: "suffixMismatch" | "nameOverlap" | null;
      setNumber?: "match" | "mismatch";
      total?: "match" | "mismatch";
    };
  };
  index: number;
  chosen: boolean;
  canSelect: boolean;
  onSelect: () => void;
  onPreview: () => void;
}) {
  return (
    <label
      className="list-item"
      style={{
        marginBottom: 0,
        cursor: canSelect ? "pointer" : "not-allowed",
        opacity: canSelect ? 1 : 0.6,
        border: chosen ? "2px solid var(--accent)" : "1px solid var(--border)",
        background: chosen ? "var(--accent)11" : "var(--bg)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
        <input
          type="radio"
          checked={chosen}
          onChange={onSelect}
          disabled={!canSelect}
        />
        <div style={{ display: "grid", gap: 4, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            <span className="pill" style={{ fontSize: 10, marginRight: 6 }}>
              {index + 1}
            </span>
            {variant.productName}
            {variant.variantSuffix && <span style={{ color: "var(--accent)" }}> {variant.variantSuffix}</span>}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            {variant.setNumber ?? "—"} • {variant.rarity ?? "Unknown"} • {variant.releaseYear ?? "—"}
            {" • "}
            <a
              href={generatePriceChartingUrl(variant.productId)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--accent)" }}
              onClick={(e) => e.stopPropagation()}
            >
              PriceCharting →
            </a>
            {" • "}
            <button
              style={{
                background: "none",
                border: "none",
                color: "var(--accent)",
                cursor: "pointer",
                fontSize: 11,
                padding: 0,
                textDecoration: "underline",
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onPreview();
              }}
            >
              Preview 🔍
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, fontSize: 11 }}>
            {variant.deltas.name && (
              <span className="pill" style={{ fontSize: 10 }}>
                name: {variant.deltas.name}
              </span>
            )}
            {variant.deltas.setNumber && (
              <span className="pill" style={{ fontSize: 10 }}>
                set: {variant.deltas.setNumber}
              </span>
            )}
            {variant.deltas.total && (
              <span className="pill" style={{ fontSize: 10 }}>
                total: {variant.deltas.total}
              </span>
            )}
          </div>
        </div>
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
        {Math.round(variant.score * 100)}%
      </div>
    </label>
  );
}

function FlyoutPreview({
  variant,
  imageUrl,
  onDismiss,
}: {
  variant: { id: string; title: string };
  imageUrl: string;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0, 0, 0, 0.7)",
        display: "grid",
        placeItems: "center",
        zIndex: 1000,
      }}
      onClick={onDismiss}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "2px solid var(--accent)",
          borderRadius: 8,
          padding: 20,
          maxWidth: 500,
          maxHeight: "80vh",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 16 }}>{variant.title}</div>
        <img
          src={imageUrl}
          alt={variant.title}
          style={{ width: "100%", borderRadius: 4, marginBottom: 12 }}
        />
        <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center" }}>
          Click anywhere to dismiss (auto-closes in 5s)
        </div>
      </div>
    </div>
  );
}

/**
 * Derive variant source from prefixed productId.
 */
function inferVariantSource(productId: string): "canonical" | "pricecharting" | "ppt" | "fallback" | "unknown" {
  if (productId.startsWith("canonical::")) return "canonical";
  if (productId.startsWith("pricecharting::")) return "pricecharting";
  if (productId.startsWith("ppt::")) return "ppt";
  if (productId.startsWith("fallback::")) return "fallback";
  return "unknown";
}

/**
 * Generate PriceCharting search URL from card name and set number
 * Format: https://www.pricecharting.com/search-products?type=prices&q={name}+{setNumber}
 */
function generatePriceChartingSearchUrl(productName: string, setNumber?: string | null): string {
  let query = productName;
  if (setNumber) {
    query += ` ${setNumber}`;
  }
  // URL encode and replace spaces with +
  const encodedQuery = encodeURIComponent(query).replace(/%20/g, '+');
  return `https://www.pricecharting.com/search-products?type=prices&q=${encodedQuery}`;
}

/**
 * Generate PriceCharting URL from productId
 * Format: https://www.pricecharting.com/offers?s={id}
 * Strips "pricecharting::" prefix if present
 */
function generatePriceChartingUrl(productId: string): string {
  // Strip pricecharting:: prefix if present
  const rawId = productId.replace(/^pricecharting::/, "");
  return `https://www.pricecharting.com/offers?s=${encodeURIComponent(rawId)}`;
}

/**
 * Get tooltip text for source indicators (canonical-first UX)
 */
function getSourceTooltip(source: string | undefined): string {
  if (source === "canonical") return "Canonical: from CardMint catalog (authoritative)";
  if (source === "pricecharting") return "PriceCharting: external enrichment (reference only)";
  if (source === "csv") return "CSV fallback: used when primary sources unavailable";
  return "Model inference: extracted by vision/OCR";
}

/**
 * Get tooltip text for confidence badges (canonical-first UX)
 */
function getConfidenceTooltip(score: number): string {
  if (score >= 0.7) return "Strong match to canonical record";
  if (score >= 0.5) return "Moderate match; verify recommended";
  return "Weak match; operator correction likely needed";
}

/**
 * Stage progress pill for inline stage checklist
 */
function StagePill({ done, label, stage }: { done: boolean; label: string; stage: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: "2px 6px",
        borderRadius: 3,
        background: done ? "#dcfce7" : "#f3f4f6",
        color: done ? "#166534" : "#6b7280",
        border: `1px solid ${done ? "#86efac" : "#d1d5db"}`,
        fontWeight: 500,
      }}
      title={done ? `${stage}: Complete` : `${stage}: Pending`}
    >
      {done ? "✓" : "○"} {label}
    </span>
  );
}

// ============================================================================
// Legacy Fallback Panel (when evidence unavailable)
// ============================================================================

const LegacyDetailsPanel: React.FC<{
  job: Job;
  chosen: number | null;
  setChosen: (i: number) => void;
  onAccept: () => void;
  onFlag: () => void;
  setVariantTelemetry: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  condition: string;
  setCondition: (condition: string) => void;
  bannerMessage?: string;
  showBanner?: boolean;
}> = ({
  job,
  chosen,
  setChosen,
  onAccept,
  onFlag,
  setVariantTelemetry,
  condition,
  setCondition,
  bannerMessage,
  showBanner = true,
}) => {
    const candidates = job.candidates ?? [];
    const [setVerified, setSetVerified] = useState(false);
    const canAccept = [
      "OPERATOR_PENDING",
      "CANDIDATES_READY",
      "UNMATCHED_NO_REASONABLE_CANDIDATE",
    ].includes(job.status as any) && candidates.length > 0 && setVerified;
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
            <button
              className="pill"
              title={setVerified ? "Set verified" : "Verify the card set before accepting"}
              onClick={() => {
                const next = !setVerified;
                setSetVerified(next);
                setVariantTelemetry((prev) => ({ ...prev, set_verified: next, set_verified_at: Date.now() }));
              }}
              style={{
                borderColor: "transparent",
                cursor: "pointer",
                background: setVerified ? "#dcfce7" : "#fee2e2",
                color: setVerified ? "#166534" : "#991b1b",
                fontSize: 12,
              }}
            >
              {setVerified ? "Set Verified" : "Verify Set"}
            </button>
          </div>
        </header>

        <section style={{ display: "grid", gap: 8, alignContent: "start", overflowY: "auto" }}>
          {/* Evidence banner (hidden for production by default) */}
          {showBanner && (
            <div
              style={{
                background: "var(--warn)22",
                border: "1px solid var(--warn)",
                borderRadius: 4,
                padding: 10,
                fontSize: 13,
                color: "var(--warn)",
              }}
            >
              ⚠️ {bannerMessage ?? "Evidence unavailable — PriceCharting corpus not loaded. Manual review required."}
            </div>
          )}

          {!showBanner && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--sub)", fontSize: 12 }}>
              <span className="pill" style={{ background: "#3b82f611", color: "#3b82f6", borderColor: "transparent" }}>
                Data pending
              </span>
              <span>Showing candidates while evidence prepares…</span>
            </div>
          )}

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
                  <div style={{ fontSize: 12, color: "var(--muted)" }} title={getSourceTooltip(c.source)}>{c.source ?? "local"}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <ConfidenceBadge confidence={c.confidence ?? 0} />
              </div>
            </label>
          ))}
          {candidates.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>No candidates available.</div>
          )}
        </section>

        <footer style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, minWidth: 70 }}>Condition:</label>
            <select
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              style={{
                flex: 1,
                padding: "6px 8px",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg-secondary)",
                color: "var(--fg)",
                fontSize: 12,
              }}
            >
              <option value="NM">Near Mint (NM)</option>
              <option value="LP">Lightly Played (LP)</option>
              <option value="MP">Moderately Played (MP)</option>
              <option value="HP">Heavily Played (HP)</option>
              <option value="DMG">Damaged (DMG)</option>
              <option value="UNKNOWN">Unknown</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn danger" onClick={onFlag} disabled={!canFlag}>
              Flag (F)
            </button>
            <button className="btn primary" onClick={onAccept} disabled={!canAccept} title={setVerified ? "Accept" : "Verify Set to enable Accept"}>
              Accept (Enter)
            </button>
          </div>
        </footer>
      </div>
    );
  };

export default RightPaneEvidence;
