import React, { useEffect, useRef, useState } from "react";
import type { Job } from "../api/adapters";
import { useStagedEdits } from "../hooks/useStagedEdits";

interface ManualEditorProps {
  job: Job | null;
  onAccept: () => void;
  onFlag: () => void;
  onValidityChange?: (hasValidEdits: boolean, hasInvalidEdits: boolean) => void;
  condition: string;
  setCondition: (condition: string) => void;
}

const VARIANT_HINT_OPTIONS = [
  { value: "NONE", label: "None / Standard" },
  { value: "HOLO", label: "Holo" },
  { value: "REVERSE_HOLO", label: "Reverse Holo" },
  { value: "FULL_ART", label: "Full Art" },
  { value: "PROMO", label: "Promo" },
  { value: "FIRST_EDITION", label: "1st Edition" },
  { value: "SHADOWLESS", label: "Shadowless" },
];

const ManualEditor: React.FC<ManualEditorProps> = ({ job, onAccept, onFlag, onValidityChange, condition, setCondition }) => {
  const { edits, setEdits, isValid, errors, hasValidEdits, hasInvalidEdits } = useStagedEdits(job?.id ?? null);

  const [cardName, setCardName] = useState("");
  const [setNumber, setSetNumber] = useState("");
  const [hpValue, setHpValue] = useState("");
  const [variantHint, setVariantHint] = useState("NONE");

  // Path A manifest (single JSON file per scan)
  type ManifestLite = {
    uid: string;
    inference: { engine: "PathA" | "PathB"; cm_card_id: string };
  } | null;
  const [manifest, setManifest] = useState<ManifestLite>(null);
  const [manifestEtag, setManifestEtag] = useState<string | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);

  const tabOpenedEmitted = useRef<Set<string>>(new Set());

  // Pre-populate fields from job when job changes
  useEffect(() => {
    if (!job) {
      setCardName("");
      setSetNumber("");
      setHpValue("");
      setVariantHint("NONE");
      setManifest(null);
      setManifestEtag(null);
      setManifestError(null);
      setManifestLoading(false);
      return;
    }

    // Check if we have staged edits, otherwise pre-populate from job
    setCardName(edits.card_name ?? job.card_name ?? "");
    setSetNumber(edits.set_number ?? job.set_number ?? "");
    setHpValue(edits.hp_value != null ? String(edits.hp_value) : job.hp_value != null ? String(job.hp_value) : "");
    setVariantHint(edits.variant_hint ?? "NONE");
  }, [job?.id, edits]);

  // Load manifest for the selected scan (correlate UI with single JSON file; Path A only)
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!job?.id) return;
      setManifestLoading(true);
      setManifestError(null);
      try {
        const headers: HeadersInit = {};
        if (manifestEtag) headers["If-None-Match"] = manifestEtag;
        const resp = await fetch(`/api/scans/${job.id}/manifest`, { headers });
        if (resp.status === 304) return;
        if (!resp.ok) {
          let data: any = null;
          try { data = await resp.json(); } catch {}
          const msg = data?.message || data?.error || `Manifest fetch failed: ${resp.status}`;
          throw new Error(msg);
        }
        const etag = resp.headers.get("ETag") ?? null;
        const m = await resp.json();
        if (!cancelled) {
          const lite: ManifestLite = m && m.inference ? { uid: m.uid, inference: { engine: m.inference.engine, cm_card_id: m.inference.cm_card_id } } : null;
          setManifest(lite);
          setManifestEtag(etag);
        }
      } catch (err) {
        if (!cancelled) setManifestError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setManifestLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [job?.id]);

  // Emit manual_tab_opened event once per job
  useEffect(() => {
    if (!job?.id) return;
    if (tabOpenedEmitted.current.has(job.id)) return;

    console.info("MANUAL_TAB_OPENED", {
      jobId: job.id,
      opened_at: new Date().toISOString(),
    });

    tabOpenedEmitted.current.add(job.id);
  }, [job?.id]);

  // Update staged edits when fields change
  useEffect(() => {
    if (!job) return;

    const newEdits: any = {};
    const trimmedCardName = cardName.trim();
    const trimmedSetNumber = setNumber.trim();
    const parsedHp = hpValue.trim() !== "" ? parseInt(hpValue, 10) : undefined;

    // Only include fields that differ from job defaults
    if (trimmedCardName && trimmedCardName !== (job.card_name ?? "")) {
      newEdits.card_name = trimmedCardName;
    }
    if (trimmedSetNumber && trimmedSetNumber !== (job.set_number ?? "")) {
      newEdits.set_number = trimmedSetNumber;
    }
    if (parsedHp !== undefined && !isNaN(parsedHp) && parsedHp !== job.hp_value) {
      newEdits.hp_value = parsedHp;
    }
    if (variantHint !== "NONE") {
      newEdits.variant_hint = variantHint;
    }

    setEdits(newEdits);
  }, [cardName, setNumber, hpValue, variantHint, job, setEdits]);

  // Notify parent of validity state changes
  useEffect(() => {
    if (onValidityChange) {
      onValidityChange(hasValidEdits, hasInvalidEdits);
    }
  }, [hasValidEdits, hasInvalidEdits, onValidityChange]);

  if (!job) {
    return (
      <div style={{ padding: "2rem", textAlign: "center", color: "#6b7280" }}>
        No job selected
      </div>
    );
  }

  const isReadOnly = job.status === "ACCEPTED";

  // Accept disabled when manual edits exist but are invalid
  const acceptDisabled = hasInvalidEdits;

  return (
    <div style={{ padding: "1.5rem", maxWidth: "600px" }}>
      {/* Header */}
      <div style={{ marginBottom: "1.5rem" }}>
        <h3 style={{ margin: 0, fontSize: "1.125rem", fontWeight: "600", color: "#1f2937" }}>
          Manual Identity Editor
        </h3>
        <p style={{ margin: "0.5rem 0 0 0", fontSize: "0.875rem", color: "#6b7280" }}>
          {isReadOnly
            ? "Read-only: This job has been accepted"
            : "Override extracted fields with definitive operator corrections"}
        </p>
        {/* Path A / Manifest source confirmation */}
        <div style={{ marginTop: "0.5rem", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span
            className="pill"
            title="Manual tab uses Path A extracted fields only"
            style={{ borderColor: "transparent", background: "#dbeafe", color: "#1e40af", fontSize: 11 }}
          >
            Path A only
          </span>
          {manifestLoading && (
            <span className="pill" style={{ borderColor: "transparent", background: "#eef2f7", color: "#374151", fontSize: 11 }}>
              Loading manifest…
            </span>
          )}
          {manifestError && (
            <span className="pill" style={{ borderColor: "transparent", background: "#fee2e2", color: "#991b1b", fontSize: 11 }}>
              Manifest: {manifestError}
            </span>
          )}
          {manifest && (
            <>
              <span
                className="pill"
                title={`Capture UID: ${manifest.uid}`}
                style={{ borderColor: "transparent", background: "#ecfeff", color: "#155e75", fontSize: 11 }}
              >
                UID {manifest.uid.slice(0, 8)}…
              </span>
              <span
                className="pill"
                title={`JSON file: ${manifest.uid}.json`}
                style={{ borderColor: "transparent", background: "#eef2f7", color: "#374151", fontSize: 11 }}
              >
                {manifest.uid}.json
              </span>
              <span
                className="pill"
                title={`Inference engine: ${manifest.inference.engine}`}
                style={{
                  borderColor: "transparent",
                  background: manifest.inference.engine === "PathA" ? "#dcfce7" : "#fef3c7",
                  color: manifest.inference.engine === "PathA" ? "#166534" : "#92400e",
                  fontSize: 11,
                }}
              >
                {manifest.inference.engine}
              </span>
              {manifest.inference.engine !== "PathA" && (
                <span
                  className="pill"
                  title="Manual tab reads Path A fields only"
                  style={{ borderColor: "transparent", background: "#fff7ed", color: "#9a3412", fontSize: 11 }}
                >
                  Manual tab limited to Path A
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Fields */}
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {/* Read-only parsed (Path A) context */}
        <div className="panel" style={{ padding: "0.75rem", background: "#f9fafb" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6 }} title="Read-only: extracted values from vision/OCR">Parsed (Path A)</div>
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", rowGap: 4, columnGap: 8, alignItems: "center" }}>
            <div style={{ color: "#6b7280", fontSize: 12 }}>Card Name</div>
            <div style={{ fontSize: 12, color: "#111827" }}>{job.card_name || "—"}</div>
            <div style={{ color: "#6b7280", fontSize: 12 }}>Set Number</div>
            <div style={{ fontSize: 12, color: "#111827" }}>{job.set_number || "—"}</div>
            <div style={{ color: "#6b7280", fontSize: 12 }}>HP</div>
            <div style={{ fontSize: 12, color: "#111827" }}>{job.hp_value ?? "—"}</div>
            <div style={{ color: "#6b7280", fontSize: 12 }}>cm_card_id</div>
            <div style={{ fontSize: 12, color: "#111827" }}>{manifest?.inference?.cm_card_id || "—"}</div>
          </div>
        </div>
        {/* Card Name */}
        <div>
          <label
            htmlFor="manual-card-name"
            style={{
              display: "block",
              fontSize: "0.875rem",
              fontWeight: "500",
              color: "#374151",
              marginBottom: "0.25rem",
            }}
            title="Override extracted name. Match canonical catalog name"
          >
            Card Name
          </label>
          <input
            id="manual-card-name"
            type="text"
            value={cardName}
            onChange={(e) => setCardName(e.target.value)}
            disabled={isReadOnly}
            placeholder="e.g., Pikachu"
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              border: `1px solid ${errors.card_name ? "#ef4444" : "#d1d5db"}`,
              borderRadius: "0.375rem",
              fontSize: "0.875rem",
              backgroundColor: isReadOnly ? "#f9fafb" : "#ffffff",
              color: "#1f2937",
            }}
          />
          {errors.card_name && (
            <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.75rem", color: "#ef4444" }}>
              {errors.card_name}
            </p>
          )}
          {/* Divergence guardrail: show when manual differs from extracted */}
          {cardName && job.card_name && cardName.trim() !== job.card_name.trim() && (
            <div style={{ fontSize: "0.75rem", color: "#d97706", marginTop: "0.25rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span>Name differs from extracted.</span>
              <button
                type="button"
                onClick={() => setCardName(job.card_name || "")}
                style={{
                  fontSize: "0.75rem",
                  padding: "1px 6px",
                  background: "#fef3c7",
                  border: "1px solid #fcd34d",
                  borderRadius: 3,
                  cursor: "pointer",
                  color: "#92400e",
                }}
              >
                Reset to extracted
              </button>
            </div>
          )}
        </div>

        {/* Set Number */}
        <div>
          <label
            htmlFor="manual-set-number"
            style={{
              display: "block",
              fontSize: "0.875rem",
              fontWeight: "500",
              color: "#374151",
              marginBottom: "0.25rem",
            }}
            title="Override set number. Format: card/total or card#"
          >
            Set Number
          </label>
          <input
            id="manual-set-number"
            type="text"
            value={setNumber}
            onChange={(e) => setSetNumber(e.target.value)}
            disabled={isReadOnly}
            placeholder="e.g., 25/102"
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              border: `1px solid ${errors.set_number ? "#ef4444" : "#d1d5db"}`,
              borderRadius: "0.375rem",
              fontSize: "0.875rem",
              backgroundColor: isReadOnly ? "#f9fafb" : "#ffffff",
              color: "#1f2937",
            }}
          />
          {errors.set_number ? (
            <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.75rem", color: "#ef4444" }}>
              {errors.set_number}
            </p>
          ) : (
            <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.75rem", color: "#6b7280" }}>
              Format: card/total (e.g., 25/102) or just card number
            </p>
          )}
        </div>

        {/* HP Value */}
        <div>
          <label
            htmlFor="manual-hp-value"
            style={{
              display: "block",
              fontSize: "0.875rem",
              fontWeight: "500",
              color: "#374151",
              marginBottom: "0.25rem",
            }}
          >
            HP Value
          </label>
          <input
            id="manual-hp-value"
            type="number"
            value={hpValue}
            onChange={(e) => setHpValue(e.target.value)}
            disabled={isReadOnly}
            placeholder="e.g., 60"
            min="0"
            max="400"
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              border: `1px solid ${errors.hp_value ? "#ef4444" : "#d1d5db"}`,
              borderRadius: "0.375rem",
              fontSize: "0.875rem",
              backgroundColor: isReadOnly ? "#f9fafb" : "#ffffff",
              color: "#1f2937",
            }}
          />
          {errors.hp_value ? (
            <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.75rem", color: "#ef4444" }}>
              {errors.hp_value}
            </p>
          ) : (
            <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.75rem", color: "#6b7280" }}>
              0-400 (leave empty if not applicable)
            </p>
          )}
        </div>

        {/* Variant Hint */}
        <div>
          <label
            htmlFor="manual-variant-hint"
            style={{
              display: "block",
              fontSize: "0.875rem",
              fontWeight: "500",
              color: "#374151",
              marginBottom: "0.25rem",
            }}
          >
            Variant Hint
          </label>
          <select
            id="manual-variant-hint"
            value={variantHint}
            onChange={(e) => setVariantHint(e.target.value)}
            disabled={isReadOnly}
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              border: "1px solid #d1d5db",
              borderRadius: "0.375rem",
              fontSize: "0.875rem",
              backgroundColor: isReadOnly ? "#f9fafb" : "#ffffff",
              color: "#1f2937",
            }}
          >
            {VARIANT_HINT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.75rem", color: "#6b7280" }}>
            Optional: helps narrow variant disambiguation
          </p>
        </div>
      </div>

      {/* Condition Selection */}
      {!isReadOnly && (
        <div style={{ marginTop: "2rem" }}>
          <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.875rem", fontWeight: "600" }}>
            Condition
          </label>
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            style={{
              width: "100%",
              padding: "0.5rem",
              borderRadius: "0.375rem",
              border: "1px solid #d1d5db",
              fontSize: "0.875rem",
            }}
          >
            <option value="NM">Near Mint (NM)</option>
            <option value="LP">Lightly Played (LP)</option>
            <option value="MP">Moderately Played (MP)</option>
            <option value="HP">Heavily Played (HP)</option>
            <option value="UNKNOWN">Unknown</option>
          </select>
          <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.75rem", color: "#6b7280" }}>
            Condition grade for inventory creation
          </p>
        </div>
      )}

      {/* Action Buttons */}
      {!isReadOnly && (
        <div style={{ marginTop: "1rem", display: "flex", gap: "0.75rem" }}>
          <button
            onClick={onAccept}
            style={{
              flex: 1,
              padding: "0.625rem 1rem",
              backgroundColor: acceptDisabled ? "#a7f3d0" : "#10b981",
              color: acceptDisabled ? "#065f46" : "#ffffff",
              border: "none",
              borderRadius: "0.375rem",
              fontSize: "0.875rem",
              fontWeight: "500",
              cursor: acceptDisabled ? "not-allowed" : "pointer",
            }}
            disabled={acceptDisabled}
            >
            Accept
          </button>
          <button
            onClick={onFlag}
            style={{
              flex: 1,
              padding: "0.625rem 1rem",
              backgroundColor: "#ef4444",
              color: "#ffffff",
              border: "none",
              borderRadius: "0.375rem",
              fontSize: "0.875rem",
              fontWeight: "500",
              cursor: "pointer",
            }}
          >
            Flag
          </button>
        </div>
      )}

      {/* Read-only message for accepted jobs */}
      {isReadOnly && (
        <div
          style={{
            marginTop: "2rem",
            padding: "0.75rem 1rem",
            backgroundColor: "#f3f4f6",
            border: "1px solid #d1d5db",
            borderRadius: "0.375rem",
            fontSize: "0.875rem",
            color: "#6b7280",
          }}
        >
          This job has been accepted. Fields are read-only.
        </div>
      )}
    </div>
  );
};

export default ManualEditor;
