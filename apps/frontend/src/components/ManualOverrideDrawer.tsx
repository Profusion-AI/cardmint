import React, { useState } from "react";
import { submitManualOverride, type ManualOverridePayload } from "../api/client";

interface ManualOverrideDrawerProps {
  scanId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}

/**
 * Manual reason codes from 20251103_manual_override_schema.sql
 * These match the backend CHECK constraint exactly
 */
const MANUAL_REASON_CODES = [
  { value: "PPT_OUTAGE_OR_RATE_LIMIT", label: "PPT Outage or Rate Limit" },
  { value: "PPT_NO_MATCH_OR_INCOMPLETE_DATA", label: "PPT No Match or Incomplete Data" },
  { value: "VARIANT_MISMATCH_OR_EDGE_CASE", label: "Variant Mismatch or Edge Case" },
  { value: "CONDITION_DRIVEN_ADJUSTMENT", label: "Condition-Driven Adjustment" },
  { value: "MARKET_ANOMALY_OR_SUDDEN_SWING", label: "Market Anomaly or Sudden Swing" },
  { value: "OTHER", label: "Other (explain in note)" },
] as const;

const MIN_NOTE_LENGTH = 15;

/**
 * ManualOverrideDrawer: Modal for operator manual card identification
 * Opened when ppt_failure_count >= 3 or operator manually triggers
 * Validates: reason code enum, note ≥15 chars, optional price
 */
export const ManualOverrideDrawer: React.FC<ManualOverrideDrawerProps> = ({
  scanId,
  isOpen,
  onClose,
  onSuccess,
  onError,
}) => {
  const [reasonCode, setReasonCode] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [price, setPrice] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  // Validation
  const noteValid = note.trim().length >= MIN_NOTE_LENGTH;
  const reasonCodeValid = reasonCode.length > 0;
  const priceValid = price.trim() === "" || (!isNaN(parseFloat(price)) && parseFloat(price) >= 0);
  const canSubmit = reasonCodeValid && noteValid && priceValid && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      const payload: ManualOverridePayload = {
        accepted: true,
        manual_override: true,
        manual_reason_code: reasonCode,
        manual_note: note.trim(),
      };

      // Add optional price if provided
      if (price.trim() !== "") {
        payload.manual_price = parseFloat(price);
      }

      await submitManualOverride(scanId, payload);
      onSuccess();
      handleReset();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to submit manual override";
      onError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    setReasonCode("");
    setNote("");
    setPrice("");
  };

  const handleCancel = () => {
    handleReset();
    onClose();
  };

  if (!isOpen) return null;

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
        onClick={handleCancel}
      />

      {/* Drawer */}
      <div
        className="panel"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(90%, 500px)",
          maxHeight: "90vh",
          overflow: "auto",
          zIndex: 1000,
          padding: 20,
          display: "grid",
          gap: 16,
        }}
      >
        {/* Header */}
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>Manual Override</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
              Card identification for scan {scanId.slice(0, 8)}
            </div>
          </div>
          <button className="btn" onClick={handleCancel} style={{ padding: "4px 8px" }}>
            ✕
          </button>
        </header>

        {/* Reason Code Dropdown */}
        <div style={{ display: "grid", gap: 6 }}>
          <label style={{ fontWeight: 600, fontSize: 14 }}>
            Reason Code <span style={{ color: "var(--bad)" }}>*</span>
          </label>
          <select
            className="panel"
            style={{ padding: 8 }}
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
            disabled={submitting}
          >
            <option value="">Select reason...</option>
            {MANUAL_REASON_CODES.map((code) => (
              <option key={code.value} value={code.value}>
                {code.label}
              </option>
            ))}
          </select>
          {!reasonCodeValid && reasonCode.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Please select a reason code</div>
          )}
        </div>

        {/* Note Textarea */}
        <div style={{ display: "grid", gap: 6 }}>
          <label style={{ fontWeight: 600, fontSize: 14 }}>
            Operator Note <span style={{ color: "var(--bad)" }}>*</span>
          </label>
          <textarea
            className="panel"
            style={{
              padding: 8,
              minHeight: 80,
              fontFamily: "inherit",
              resize: "vertical",
              borderColor: note.trim().length > 0 && !noteValid ? "var(--bad)" : undefined,
            }}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Explain why this override is necessary..."
            disabled={submitting}
          />
          <div
            style={{
              fontSize: 12,
              color: noteValid || note.trim().length === 0 ? "var(--muted)" : "var(--bad)",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>Minimum {MIN_NOTE_LENGTH} characters required</span>
            <span>
              {note.trim().length}/{MIN_NOTE_LENGTH}
            </span>
          </div>
        </div>

        {/* Optional Price */}
        <div style={{ display: "grid", gap: 6 }}>
          <label style={{ fontWeight: 600, fontSize: 14 }}>Manual Price (optional)</label>
          <input
            type="number"
            className="panel"
            style={{
              padding: 8,
              borderColor: price.trim().length > 0 && !priceValid ? "var(--bad)" : undefined,
            }}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
            step="0.01"
            min="0"
            disabled={submitting}
          />
          {price.trim().length > 0 && !priceValid && (
            <div style={{ fontSize: 12, color: "var(--bad)" }}>Price must be a positive number</div>
          )}
        </div>

        {/* Actions */}
        <footer style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="btn" onClick={handleCancel} disabled={submitting} style={{ flex: 1 }}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{ flex: 1 }}
          >
            {submitting ? "Submitting..." : "Submit Override"}
          </button>
        </footer>

        {/* Helper text */}
        <div
          style={{
            fontSize: 11,
            color: "var(--muted)",
            borderTop: "1px solid var(--border)",
            paddingTop: 12,
          }}
        >
          Manual overrides are logged and tracked. Ensure your reason code and note accurately
          reflect the situation.
        </div>
      </div>
    </>
  );
};
