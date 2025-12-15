import React, { useEffect, useState } from "react";
import { canonicalizeScan } from "../api/client";

interface CanonicalizationDrawerProps {
  scanId: string;
  isOpen: boolean;
  currentCmCardId: string | null;
  onClose: () => void;
  onSuccess: (canonical_cm_card_id: string) => void;
  initialValue?: string | null;
}

/**
 * CanonicalizationDrawer: Minimal modal to resolve UNKNOWN_* -> canonical cm_card_id
 * Validates that the value does not start with UNKNOWN_
 */
const CanonicalizationDrawer: React.FC<CanonicalizationDrawerProps> = ({
  scanId,
  isOpen,
  currentCmCardId,
  onClose,
  onSuccess,
  initialValue = "",
}) => {
  const sanitizedInitial = (initialValue ?? "").trim();
  const [value, setValue] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // Hydrate from suggestion on open AND when suggestion changes while pristine
  useEffect(() => {
    if (isOpen) {
      if (!isDirty) {
        // Auto-update only if operator hasn't edited yet (intent wins once dirty)
        setValue(sanitizedInitial);
      }
      // Always clear error when drawer opens or suggestion updates
      setError(null);
    }
  }, [isOpen, sanitizedInitial, isDirty]);

  // Reset all state when drawer opens for the first time
  useEffect(() => {
    if (isOpen) {
      setIsDirty(false);
    }
  }, [isOpen]);

  // Clear stale state when drawer closes
  useEffect(() => {
    if (!isOpen) {
      setValue("");
      setIsDirty(false);
      setError(null);
    }
  }, [isOpen]);

  const startsWithUnknown = (s: string) => s.trim().toUpperCase().startsWith("UNKNOWN_");
  const inputValid = value.trim().length > 0 && !startsWithUnknown(value);

  // Keyboard accessibility: ESC to close, Enter to submit
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && inputValid && !submitting) {
        e.preventDefault();
        void handleSubmit();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, inputValid, submitting]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!inputValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const nextId = value.trim();
      const result = await canonicalizeScan(scanId, nextId);
      console.info("CANONICALIZE_OK", {
        scanId,
        canonical_cm_card_id: result.canonical_cm_card_id,
        previous_cm_card_id: currentCmCardId,
        timestamp: new Date().toISOString(),
      });
      onSuccess(result.canonical_cm_card_id);
      onClose();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Canonicalization failed";
      console.error("CANONICALIZE_FAILED", {
        scanId,
        attempted_cm_card_id: value.trim(),
        current_cm_card_id: currentCmCardId,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });
      setError(errorMessage);
      // Keep dialog open for correction
    } finally {
      setSubmitting(false);
    }
  };

  const Spinner: React.FC<{ size?: number }> = ({ size = 14 }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 50 50"
      style={{ marginRight: 6, verticalAlign: "middle" }}
    >
      <circle
        cx="25"
        cy="25"
        r="20"
        stroke="#3b82f6"
        strokeWidth="6"
        fill="none"
        strokeLinecap="round"
        strokeDasharray="31.4 188.4"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 25 25"
          to="360 25 25"
          dur="0.8s"
          repeatCount="indefinite"
        />
      </circle>
    </svg>
  );

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

      {/* Drawer */}
      <div
        className="panel"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(90%, 560px)",
          maxHeight: "90vh",
          overflow: "auto",
          zIndex: 1000,
          padding: 20,
          display: "grid",
          gap: 16,
        }}
      >
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>Canonicalize Scan</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
              Scan {scanId.slice(0, 8)} • Current ID: {currentCmCardId ?? "—"}
            </div>
          </div>
          <button className="btn" onClick={onClose} style={{ padding: "4px 8px" }}>
            ✕
          </button>
        </header>

        <div style={{ display: "grid", gap: 6 }}>
          <label style={{ fontWeight: 600, fontSize: 14 }}>
            Canonical cm_card_id <span style={{ color: "var(--bad)" }}>*</span>
          </label>
          <input
            className="panel"
            style={{ padding: 8, borderColor: value && !inputValid ? "var(--bad)" : undefined }}
            placeholder="e.g. cm::base_set::4/102::charizard_holo"
            value={value}
            onChange={(e) => {
              if (!isDirty) setIsDirty(true);
              setValue(e.target.value);
              setError(null);
            }}
            disabled={submitting}
          />
          {sanitizedInitial && (
            <div style={{ fontSize: 11, color: "var(--muted)", display: "flex", alignItems: "center", gap: 8 }}>
              <span>Suggestion: {sanitizedInitial}</span>
              {isDirty && value.trim() !== sanitizedInitial && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setValue(sanitizedInitial);
                    setError(null);
                  }}
                  style={{ fontSize: 11, padding: "2px 6px" }}
                  disabled={submitting}
                >
                  Use suggestion
                </button>
              )}
            </div>
          )}
          {value && !inputValid && (
            <div style={{ fontSize: 12, color: "var(--bad)" }}>
              Value must not start with UNKNOWN_
            </div>
          )}
          {error && (
            <div
              style={{
                fontSize: 12,
                color: "#991b1b",
                padding: 8,
                background: "#fef2f2",
                borderRadius: 4,
                border: "1px solid #fecaca",
              }}
            >
              <strong>Canonicalization failed:</strong> {error}
            </div>
          )}
        </div>

        <footer style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="btn" onClick={onClose} disabled={submitting} style={{ flex: 1 }}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={handleSubmit}
            disabled={!inputValid || submitting}
            style={{ flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}
          >
            {submitting && <Spinner />}
            {submitting ? "Submitting..." : "Resolve Canonical"}
          </button>
        </footer>
      </div>
    </>
  );
};

export default CanonicalizationDrawer;
