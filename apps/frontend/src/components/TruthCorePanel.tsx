import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import type { Job } from "../api/adapters";
import { lockCanonical, saveTruthCore, lockFrontImage, patchJob } from "../api/client";
import { useSession } from "../hooks/useSession";

// Debounce helper
function debounce<T extends (...args: any[]) => any>(fn: T, ms: number) {
  let timeoutId: ReturnType<typeof setTimeout>;
  const debounced = (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => clearTimeout(timeoutId);
  return debounced;
}

interface TruthCorePanelProps {
  job: Job | null;
  onTruthChange: (truth: TruthCore) => void;
  onVerifyChange: (verified: boolean) => void;
  verified: boolean;
  initialTruth?: Partial<TruthCore> | null;
  bestGuess?: BestGuess | null;
  condition: string;
  onConditionChange: (condition: string) => void;
  refreshJob?: () => Promise<void>;
  onBaselineAccepted?: () => void;
}

export interface TruthCore {
  name: string;
  hp: number | null;
  collector_no: string;
  set_name: string;
  // Parsed from collector_no for backend
  set_size: number | null;
  // Optional variant tags for disambiguation (non-gating)
  variant_tags?: string[];
}

export interface BestGuess {
  name?: string | null;
  hp?: number | null;
  collector_no?: string | null;
  set_name?: string | null;
}

interface ParsedSetNo {
  collector_no: string;
  set_size: number | null;
}

/**
 * Parse Set No input (e.g., "14/108", "SWSH001", "14") into collector_no and set_size
 */
function parseSetNo(input: string): ParsedSetNo {
  const trimmed = input.trim();
  if (!trimmed) {
    return { collector_no: "", set_size: null };
  }

  // Check for X/Y format
  const slashMatch = trimmed.match(/^(.+?)\/(\d+)$/);
  if (slashMatch) {
    return {
      collector_no: slashMatch[1].trim(),
      set_size: parseInt(slashMatch[2], 10),
    };
  }

  // No denominator - just numerator (may be alphanumeric)
  return {
    collector_no: trimmed,
    set_size: null,
  };
}

/**
 * Format collector_no and set_size for display (e.g., "14/108" or "SWSH001")
 */
function formatSetNo(collector_no: string, set_size: number | null): string {
  if (!collector_no) return "";
  if (set_size != null) {
    return `${collector_no}/${set_size}`;
  }
  return collector_no;
}

const TruthCorePanel: React.FC<TruthCorePanelProps> = ({
  job,
  onTruthChange,
  onVerifyChange,
  verified,
  initialTruth,
  bestGuess,
  condition,
  onConditionChange,
  refreshJob,
  onBaselineAccepted,
}) => {
  const { isBaseline } = useSession();
  const [masterSetOptions, setMasterSetOptions] = useState<string[]>([]);
  const [isLockingCanonical, setIsLockingCanonical] = useState(false);
  const [isSavingTruth, setIsSavingTruth] = useState(false);
  const [isAcceptingBaseline, setIsAcceptingBaseline] = useState(false);

  // Current truth state (resolved from initialTruth, job, bestGuess)
  const [currentTruth, setCurrentTruth] = useState<TruthCore>({
    name: "",
    hp: null,
    collector_no: "",
    set_name: "",
    set_size: null,
    variant_tags: [],
  });

  // Derived values for the modal (what the system thinks)
  const [derived, setDerived] = useState({
    name: "",
    hp: "",
    setNumber: "",
    setName: "",
  });

  const [variantTags, setVariantTags] = useState<string[]>([]);
  const VARIANT_PRESETS = [
    "First Edition",
    "Reverse Holo",
    "Holo",
    "Full Art",
    "Shadowless",
  ];

  // Load master set list for dropdown options
  useEffect(() => {
    let cancelled = false;
    fetch("/api/master-sets")
      .then(async (res) => (res.ok ? res.json() : Promise.reject(new Error(`http_${res.status}`))))
      .then((data) => {
        if (cancelled) return;
        const names = Array.isArray(data?.sets)
          ? (data.sets.map((s: any) => s.set_name).filter(Boolean) as string[])
          : [];
        const unique = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
        setMasterSetOptions(unique);
      })
      .catch(() => {
        if (!cancelled) {
          setMasterSetOptions([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Initialize from job fields when job changes
  useEffect(() => {
    if (!job) return;

    // 1. Calculate Derived Values (System Opinion)
    // Priority: Job Data (extracted) -> Best Guess (inference)
    // Note: Derived does NOT include user overrides (initialTruth). 
    // Derived is "what would we use if you didn't override?"
    const extractedName = job.card_name || "";
    const extractedHp = job.hp_value;
    const extractedCollectorNo = job.set_number || "";
    const extractedSetName = job.set_name || "";

    const derivedName = extractedName || bestGuess?.name || "";

    let derivedHp = "";
    if (extractedHp != null) derivedHp = String(extractedHp);
    else if (bestGuess?.hp != null) derivedHp = String(bestGuess.hp);

    const derivedSetNo = extractedCollectorNo || bestGuess?.collector_no || "";
    const derivedSetName = extractedSetName || bestGuess?.set_name || "";

    setDerived({
      name: derivedName,
      hp: derivedHp,
      setNumber: derivedSetNo,
      setName: derivedSetName,
    });

    // 2. Calculate Current Truth (Effective Value)
    // Priority: InitialTruth (persisted overrides) -> Derived
    const resolvedName = initialTruth?.name || derivedName;

    let resolvedHp: number | null = null;
    if (initialTruth?.hp !== undefined) resolvedHp = initialTruth.hp;
    else if (derivedHp) resolvedHp = parseInt(derivedHp, 10);

    const resolvedSetNo = initialTruth?.collector_no || derivedSetNo;
    const resolvedSetName = initialTruth?.set_name || derivedSetName;

    // Parse set size from resolved set no if needed, or use initialTruth's set_size
    // If initialTruth has set_size, use it. Else parse from resolvedSetNo.
    let resolvedSetSize = initialTruth?.set_size ?? null;
    if (resolvedSetSize === null && resolvedSetNo) {
      resolvedSetSize = parseSetNo(resolvedSetNo).set_size;
    }

    const newTruth = {
      name: resolvedName,
      hp: resolvedHp,
      collector_no: resolvedSetNo,
      set_name: resolvedSetName,
      set_size: resolvedSetSize,
      variant_tags: initialTruth?.variant_tags ?? [],
    };

    setCurrentTruth(newTruth);
    setVariantTags(initialTruth?.variant_tags ?? []);

  }, [job?.id, initialTruth, bestGuess]); // Re-run if any input changes

  const persistTruthCore = async (truth: TruthCore) => {
    // Cancel any pending debounced save to avoid race condition
    debouncedSaveRef.current?.cancel();

    // Persist to backend so subsequent renders rehydrate accepted_* correctly
    if (job?.id) {
      setIsSavingTruth(true);
      try {
        await saveTruthCore(job.id, truth);
        // Clear localStorage fallback on successful save
        if (pendingVariantsKey) {
          try { localStorage.removeItem(pendingVariantsKey); } catch { /* ignore */ }
        }
        // Mutate job snapshot so badge and summary reflect saved truth without a refetch
        job.accepted_name = truth.name;
        job.accepted_hp = truth.hp ?? null;
        job.accepted_collector_no = truth.collector_no;
        job.accepted_set_name = truth.set_name;
        job.accepted_set_size = truth.set_size ?? null;
        // Full job refresh to sync reconciliation_status and other backend-derived fields
        if (refreshJob) {
          await refreshJob();
        }
      } catch (error) {
        console.error("Failed to save Truth Core:", error);
        alert(`Failed to save Truth Core: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setIsSavingTruth(false);
      }
    }
  };

  const handleResetDefaults = () => {
    // Revert to derived values
    const newTruth: TruthCore = {
      name: derived.name,
      hp: derived.hp ? parseInt(derived.hp, 10) : null,
      collector_no: derived.setNumber,
      set_name: derived.setName,
      set_size: null, // We'd need to re-parse if we wanted to be precise, but derived setNumber is raw
      variant_tags: [],
    };

    // Parse set size if possible from derived set number
    const parsed = parseSetNo(derived.setNumber);
    newTruth.set_size = parsed.set_size;

    setCurrentTruth(newTruth);
    setVariantTags([]);

    // Notify parent
    onTruthChange(newTruth);

    // Un-verify
    onVerifyChange(false);

    // Best-effort persist (if complete). If incomplete, backend rejects; UI keeps local state.
    debouncedSaveRef.current?.cancel();
    debouncedSaveRef.current?.(newTruth);
  };

  // Debounced save for variant tags (auto-persist after 800ms)
  const debouncedSaveRef = useRef<ReturnType<typeof debounce<(truth: TruthCore) => void>> | null>(null);

  // localStorage key for pending variant tags (fallback when Truth Core incomplete)
  const pendingVariantsKey = job?.id ? `cm_pending_variants_${job.id}` : null;

  // Restore pending variants from localStorage on job load
  useEffect(() => {
    if (!pendingVariantsKey || !job?.id) return;
    // Only restore if not already set from initialTruth (backend)
    if (initialTruth?.variant_tags && initialTruth.variant_tags.length > 0) {
      // Backend has authoritative tags, clear localStorage
      try { localStorage.removeItem(pendingVariantsKey); } catch { /* ignore */ }
      return;
    }
    try {
      const pending = localStorage.getItem(pendingVariantsKey);
      if (pending) {
        const tags = JSON.parse(pending) as string[];
        if (Array.isArray(tags) && tags.length > 0) {
          setVariantTags(tags);
          setCurrentTruth((prev) => ({ ...prev, variant_tags: tags }));
        }
      }
    } catch { /* ignore parse errors */ }
  }, [job?.id, pendingVariantsKey, initialTruth?.variant_tags?.length]);

  // Create debounced save function on mount
  // Note: We attempt saves even with incomplete Truth Core - backend will reject (400) if
  // name/collector_no/set_name are missing. Pending variants stored in localStorage as fallback.
  useEffect(() => {
    debouncedSaveRef.current = debounce((truth: TruthCore) => {
      if (!job?.id) return;
      const hasVariants = (truth.variant_tags?.length ?? 0) > 0;
      const isComplete = truth.name && truth.collector_no && truth.set_name;

      // Store to localStorage as fallback (survives refresh when backend rejects)
      if (pendingVariantsKey && hasVariants) {
        try { localStorage.setItem(pendingVariantsKey, JSON.stringify(truth.variant_tags)); } catch { /* ignore */ }
      } else if (pendingVariantsKey) {
        try { localStorage.removeItem(pendingVariantsKey); } catch { /* ignore */ }
      }

      // Attempt backend save
      if (hasVariants || isComplete) {
        saveTruthCore(job.id, truth)
          .then(() => {
            // Success - clear localStorage fallback
            if (pendingVariantsKey) {
              try { localStorage.removeItem(pendingVariantsKey); } catch { /* ignore */ }
            }
          })
          .catch((err) => {
            // Expected 400 when Truth Core incomplete - variants preserved in localStorage
            const is400 = err?.message?.includes("400") || err?.message?.includes("TRUTH_CORE_INCOMPLETE");
            if (!is400) {
              console.error("Auto-save variant tags failed:", err);
            }
          });
      }
    }, 800);

    return () => {
      debouncedSaveRef.current?.cancel();
    };
  }, [job?.id, pendingVariantsKey]);

  // Handle variant tag changes with auto-save
  const handleVariantChange = (newTags: string[]) => {
    setVariantTags(newTags);
    const updatedTruth = { ...currentTruth, variant_tags: newTags };
    setCurrentTruth(updatedTruth);
    onTruthChange(updatedTruth);
    // Auto-save after debounce
    debouncedSaveRef.current?.(updatedTruth);
  };

  const updateTruth = (partial: Partial<TruthCore> | ((prev: TruthCore) => TruthCore)) => {
    setCurrentTruth((prev) => {
      const next = typeof partial === "function" ? partial(prev) : { ...prev, ...partial };
      onTruthChange(next);
      onVerifyChange(false);
      debouncedSaveRef.current?.(next);
      return next;
    });
  };

  if (!job) {
    return (
      <div style={{ padding: "16px", color: "var(--text-dim)" }}>
        No job selected
      </div>
    );
  }

  const isValid = currentTruth.name.trim() !== "" &&
    currentTruth.collector_no.trim() !== "" &&
    currentTruth.set_name.trim() !== "";

  // Prepare options for Set Name dropdown (Stage 0: Candidates + Best Guess)
  const setNameOptions = Array.from(
    new Set(
      [
        bestGuess?.set_name,
        job.set_name,
        ...masterSetOptions,
      ].filter(Boolean) as string[]
    )
  ).sort();

  // Nov 21 Relaxed: Handler for locking canonical without cm_card_id match
  const handleLockCanonical = async () => {
    if (!job?.id) return;
    setIsLockingCanonical(true);
    try {
      // Cancel any pending debounced save to avoid race condition
      debouncedSaveRef.current?.cancel();
      const resp = await lockCanonical(job.id, {
        truth_core: {
          name: currentTruth.name,
          collector_no: currentTruth.collector_no,
          set_name: currentTruth.set_name,
          hp: currentTruth.hp,
          set_size: currentTruth.set_size,
          variant_tags: currentTruth.variant_tags ?? [],
        },
      });
      onVerifyChange(true);
      // Optimistically set locked and cm_card_id to avoid waiting for next poll
      job.canonical_locked = resp.canonical_locked ?? true;
      if (resp.cm_card_id) {
        job.cm_card_id = resp.cm_card_id;
      }
      // Full job refresh to sync reconciliation_status and other backend-derived fields
      if (refreshJob) {
        await refreshJob();
      }
    } catch (error) {
      console.error("Failed to lock canonical:", error);
      alert(`Failed to lock canonical: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsLockingCanonical(false);
    }
  };

  // Check if Truth Core is complete and canonical not yet locked
  const truthCoreComplete = Boolean(
    currentTruth.name && currentTruth.collector_no && currentTruth.set_name
  );
  const canLockCanonical = truthCoreComplete && job.front_locked && job.back_ready && !job?.canonical_locked;

  // Baseline accept handler: auto-lock front if needed, then accept
  const handleBaselineAccept = async () => {
    if (!job?.id || !isBaseline) return;
    if (!truthCoreComplete) return;

    setIsAcceptingBaseline(true);
    try {
      // Auto-lock front if not already locked
      if (!job.front_locked) {
        await lockFrontImage(job.id);
      }

      // Persist current Truth Core so accepted_* fields reflect operator input
      await saveTruthCore(job.id, currentTruth);

      // Call accept endpoint with default condition (backend handles baseline mode)
      await patchJob(
        job.id,
        "ACCEPT",
        undefined,
        undefined,
        { truth_core: currentTruth },
        "Near Mint"
      );

      // Notify parent to clear card and advance
      if (onBaselineAccepted) {
        onBaselineAccepted();
      }
    } catch (error) {
      console.error("Baseline accept failed:", error);
      alert(`Baseline accept failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsAcceptingBaseline(false);
    }
  };

  return (
    <div
      style={{
        padding: "16px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-secondary)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }} title="Single source of truth for card identity">
            Truth Core
          </h3>
          {/* Nov 21 Relaxed: Show warning if canonical locked but no database match */}
          {job?.canonical_locked &&
            (!job?.cm_card_id ||
              job.cm_card_id.trim().length === 0 ||
              job.cm_card_id.toUpperCase().startsWith("UNKNOWN_")) && (
              <span
                style={{
                  fontSize: "11px",
                  padding: "2px 6px",
                  borderRadius: "3px",
                  background: "#fef3c7",
                  color: "#92400e",
                  border: "1px solid #fcd34d",
                  fontWeight: 500,
                }}
                title="This card's identity is locked but has no database match. It will be marked for reconciliation."
              >
                ⚠️ Database match pending
              </span>
            )}
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            className="btn secondary"
            onClick={() => persistTruthCore(currentTruth)}
            disabled={!truthCoreComplete || isSavingTruth}
            style={{ fontSize: "12px", padding: "4px 12px" }}
            title={
              truthCoreComplete
                ? "Persist Truth Core (auto-saves while editing too)"
                : "Complete Name, Set No, and Set Name first"
            }
          >
            {isSavingTruth ? "Saving..." : "Save"}
          </button>
          {canLockCanonical && (
            <button
              type="button"
              className="btn primary"
              onClick={handleLockCanonical}
              disabled={isLockingCanonical}
              style={{ fontSize: "12px", padding: "4px 12px" }}
              title="Stage 1C: Lock canonical identity. Required before Accept"
            >
              {isLockingCanonical ? "Locking..." : "Lock Identity"}
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={handleResetDefaults}
            disabled={isSavingTruth || isLockingCanonical}
            style={{ fontSize: "12px", padding: "4px 12px" }}
            title="Revert to derived values"
          >
            Defaults
          </button>
        </div>
      </div>

      {/* Inline Truth Core editor (replaces modal) */}
      <div style={{ marginTop: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 700 }}>•</span>
            <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 700 }}>Derived</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 700 }}>•</span>
            <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 700 }}>Truth Core (edit)</span>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {/* Name */}
          <div>
            <label style={{ fontSize: 11, color: "var(--text-dim)", display: "block", marginBottom: 4 }}>Name</label>
            <input
              type="text"
              value={derived.name}
              disabled
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-tertiary)", fontSize: 12 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--text-dim)", display: "block", marginBottom: 4 }}>Name</label>
            <input
              type="text"
              value={currentTruth.name}
              onChange={(e) => updateTruth({ name: e.target.value })}
              placeholder={derived.name || "Enter card name"}
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", fontSize: 12 }}
            />
          </div>

          {/* HP */}
          <div>
            <label style={{ fontSize: 11, color: "var(--text-dim)", display: "block", marginBottom: 4 }}>HP</label>
            <input
              type="text"
              value={derived.hp}
              disabled
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-tertiary)", fontSize: 12 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--text-dim)", display: "block", marginBottom: 4 }}>HP</label>
            <input
              type="text"
              value={currentTruth.hp === null ? "" : String(currentTruth.hp)}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw.trim() === "") {
                  updateTruth({ hp: null });
                  return;
                }
                const parsed = Number(raw);
                if (!Number.isNaN(parsed)) {
                  updateTruth({ hp: parsed });
                } else {
                  updateTruth({ hp: null });
                }
              }}
              placeholder={derived.hp || "Optional"}
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", fontSize: 12 }}
            />
          </div>

          {/* Set Number */}
          <div>
            <label style={{ fontSize: 11, color: "var(--text-dim)", display: "block", marginBottom: 4 }}>Set Number</label>
            <input
              type="text"
              value={derived.setNumber}
              disabled
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-tertiary)", fontSize: 12 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--text-dim)", display: "block", marginBottom: 4 }}>Set Number (e.g., 14/108)</label>
            <input
              type="text"
              value={formatSetNo(currentTruth.collector_no, currentTruth.set_size)}
              onChange={(e) => {
                const parsed = parseSetNo(e.target.value);
                updateTruth({ collector_no: parsed.collector_no, set_size: parsed.set_size });
              }}
              placeholder={derived.setNumber || "Enter set number"}
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", fontSize: 12 }}
            />
          </div>

          {/* Set Name */}
          <div>
            <label style={{ fontSize: 11, color: "var(--text-dim)", display: "block", marginBottom: 4 }}>Set Name</label>
            <input
              type="text"
              value={derived.setName || "—"}
              disabled
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-tertiary)", fontSize: 12 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--text-dim)", display: "block", marginBottom: 4 }}>Set Name</label>
            <input
              type="text"
              list={job?.id ? `cm-setname-${job.id}` : undefined}
              value={currentTruth.set_name}
              onChange={(e) => updateTruth({ set_name: e.target.value })}
              placeholder={derived.setName || "Enter set name"}
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", fontSize: 12 }}
            />
            {job?.id && (
              <datalist id={`cm-setname-${job.id}`}>
                {setNameOptions.map((opt) => (
                  <option key={opt} value={opt} />
                ))}
              </datalist>
            )}
          </div>
        </div>
      </div>

      {/* Condition selector (shared for Accept) */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
        <label style={{ fontSize: 12, fontWeight: 600, minWidth: 90 }}>Condition</label>
        <select
          value={condition}
          onChange={(e) => onConditionChange(e.target.value)}
          style={{
            flex: 1,
            maxWidth: 240,
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg)",
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

      {/* Variant Disambiguation (optional) - Kept Inline */}
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", userSelect: "none", fontSize: 12, color: "var(--text-dim)" }}>
          Variants ({variantTags.length})
        </summary>
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {VARIANT_PRESETS.map((tag) => {
            const selected = variantTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => {
                  const newTags = selected
                    ? variantTags.filter((t) => t !== tag)
                    : [...variantTags, tag];
                  handleVariantChange(newTags);
                }}
                className="pill variant-pill"
                style={{
                  border: selected ? "2px solid var(--accent)" : "1px solid var(--border)",
                  background: selected ? "var(--accent)" : "var(--bg-secondary)",
                  color: selected ? "#fff" : "var(--text)",
                  fontSize: 11,
                  padding: "3px 10px",
                  cursor: "pointer",
                  fontWeight: selected ? 600 : 400,
                  transition: "all 0.15s ease",
                  transform: selected ? "scale(1.02)" : "scale(1)",
                }}
                onMouseEnter={(e) => {
                  if (!selected) {
                    e.currentTarget.style.background = "var(--bg-tertiary)";
                    e.currentTarget.style.borderColor = "var(--accent)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!selected) {
                    e.currentTarget.style.background = "var(--bg-secondary)";
                    e.currentTarget.style.borderColor = "var(--border)";
                  }
                }}
                onMouseDown={(e) => {
                  e.currentTarget.style.transform = "scale(0.96)";
                }}
                onMouseUp={(e) => {
                  e.currentTarget.style.transform = selected ? "scale(1.02)" : "scale(1)";
                }}
              >
                {tag}
              </button>
            );
          })}
        </div>
        {/* Freeform editable field for rare cases */}
        <div style={{ marginTop: 8 }}>
          <input
            type="text"
            placeholder="Add custom tag..."
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const val = (e.target as HTMLInputElement).value.trim();
                if (val && !variantTags.includes(val)) {
                  handleVariantChange([...variantTags, val]);
                }
                (e.target as HTMLInputElement).value = "";
              }
            }}
            style={{
              width: "100%",
              padding: "4px 8px",
              fontSize: "12px",
              border: "1px solid var(--border)",
              borderRadius: 4,
              background: "var(--bg)",
            }}
          />
        </div>
      </details>

      {/* Validation messages */}
      {!isValid && (
        <div
          style={{
            marginTop: "12px",
            padding: "8px 12px",
            background: "var(--error-bg)",
            border: "1px solid var(--error)",
            borderRadius: "4px",
            fontSize: "12px",
            color: "var(--error)",
          }}
        >
          Required: Name, Collector No, and Set Name must be non-empty
        </div>
      )}

      {/* Baseline accept button (only shown in baseline mode) */}
      {isBaseline && job && (
        <div style={{ marginTop: "12px" }}>
          <button
            className="btn primary"
            onClick={handleBaselineAccept}
            disabled={!truthCoreComplete || isAcceptingBaseline}
            title={
              !truthCoreComplete
                ? "Complete Truth Core fields (Name, Collector No, Set Name) to accept"
                : "Accept this card for baseline validation"
            }
            style={{
              width: "100%",
              padding: "10px 16px",
              fontSize: "14px",
              fontWeight: 600,
              background: truthCoreComplete ? "#059669" : undefined,
              borderColor: truthCoreComplete ? "#059669" : undefined,
            }}
          >
            {isAcceptingBaseline ? "Accepting..." : "Accept as Baseline Contribution"}
          </button>
        </div>
      )}

  </div>
);
};

export default TruthCorePanel;
