import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { TruthCore } from "./TruthCorePanel";

interface TruthCoreModalProps {
  isOpen: boolean;
  onClose: () => void;
  derived: {
    name: string;
    hp: string;
    setNumber: string;
    setName: string;
  };
  initialOverrides: TruthCore;
  onSave: (overrides: TruthCore) => void;
  onReset: () => void;
  setNameOptions?: string[];
  condition: string;
  onConditionChange: (condition: string) => void;
}

const TruthCoreModal: React.FC<TruthCoreModalProps> = ({
  isOpen,
  onClose,
  derived,
  initialOverrides,
  onSave,
  onReset,
  setNameOptions = [],
  condition,
  onConditionChange,
}) => {
  const [overrides, setOverrides] = useState({
    name: initialOverrides.name || "",
    hp: initialOverrides.hp !== null ? String(initialOverrides.hp) : "",
    setNumber: initialOverrides.collector_no || "",
    setName: initialOverrides.set_name || "",
  });
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [localCondition, setLocalCondition] = useState(condition || "UNKNOWN");

  // Smoothly reset state when modal opens or overrides change
  useEffect(() => {
    if (!isOpen) return;
    setOverrides({
      name: initialOverrides.name || "",
      hp: initialOverrides.hp !== null ? String(initialOverrides.hp) : "",
      setNumber: initialOverrides.collector_no || "",
      setName: initialOverrides.set_name || "",
    });
    setLocalCondition(condition || "UNKNOWN");
    setSaved(false);
    setDropdownOpen(false);
  }, [isOpen, condition]); // Only reset when opening, NOT when initialOverrides changes (prevents overwrite on save)

  const derivedFields = useMemo(
    () => [
      { label: "Name", key: "name", placeholder: "Enter override..." },
      { label: "HP", key: "hp", placeholder: "Enter override..." },
      { label: "Set Number (e.g., 14/108)", key: "setNumber", placeholder: "Enter override..." },
    ],
    []
  );

  const handleDefaults = () => {
    setOverrides({ name: "", hp: "", setNumber: "", setName: "" });
    setSaved(false);
    setDropdownOpen(false);
    onReset();
    onClose();
  };

  const handleSave = async () => {
    // Helper to parse set number
    const parseSetNo = (input: string) => {
      const match = input.trim().match(/^(.+?)\/(\d+)$/);
      if (match) return { collector_no: match[1], set_size: parseInt(match[2], 10) };
      return { collector_no: input.trim(), set_size: null };
    };

    const mergedName = overrides.name || derived.name;
    const mergedHp = overrides.hp || derived.hp;
    const mergedSetNo = overrides.setNumber || derived.setNumber;
    const mergedSetName = overrides.setName || derived.setName;
    const parsed = parseSetNo(mergedSetNo);

    const result: TruthCore = {
      name: mergedName,
      hp: mergedHp ? parseInt(mergedHp, 10) : null,
      collector_no: parsed.collector_no,
      set_size: parsed.set_size,
      set_name: mergedSetName,
      variant_tags: initialOverrides.variant_tags,
    };

    setSaved(true);
    await onSave(result);
    onConditionChange(localCondition);
  };

  if (!isOpen) return null;

  const modal = (
    <div style={styles.overlay}>
      <div style={{ position: "absolute", inset: 0 }} onClick={onClose} />
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>Truth Core</h2>
          <button
            type="button"
            onClick={onClose}
            style={styles.closeButton}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.1)")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          >
            Close
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {/* Column badges */}
          <div style={styles.columnHeader}>
            <span style={{ ...styles.badge, ...styles.badgeDerived }}>
              <span style={{ ...styles.dot, backgroundColor: "#94a3b8" }} />
              Derived
            </span>
            <span style={{ ...styles.badge, ...styles.badgeOverride }}>
              <span style={{ ...styles.dot, backgroundColor: "#3b82f6" }} />
              Override
            </span>
          </div>

          {/* Fields */}
          <div>
            {derivedFields.map((field) => (
              <div key={field.key} style={styles.gridRow}>
                <div>
                  <label style={styles.label}>{field.label}</label>
                  <input
                    type="text"
                    value={(derived as any)[field.key]}
                    disabled
                    style={styles.inputDerived}
                  />
                </div>
                <div>
                  <label style={{ ...styles.label, opacity: 0 }}>{field.label}</label>
                  <input
                    type="text"
                    value={(overrides as any)[field.key]}
                    onChange={(e) => setOverrides((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={(derived as any)[field.key] || field.placeholder}
                    style={styles.inputOverride}
                    onFocus={(e) => (e.target.style.borderColor = "#3b82f6")}
                    onBlur={(e) => (e.target.style.borderColor = "#cbd5e1")}
                  />
                </div>
              </div>
            ))}

            {/* Set Name */}
            <div style={styles.gridRow}>
              <div>
                <label style={styles.label}>Set Name</label>
                <input
                  type="text"
                  value={derived.setName || "—"}
                  disabled
                  style={styles.inputDerived}
                />
              </div>
              <div>
                <label style={{ ...styles.label, opacity: 0 }}>Set Name</label>
                <div style={{ position: "relative" }}>
                  <input
                    type="text"
                    value={overrides.setName}
                    onChange={(e) => setOverrides((prev) => ({ ...prev, setName: e.target.value }))}
                    placeholder="Enter override..."
                    style={{ ...styles.inputOverride, paddingRight: "40px" }}
                    onFocus={(e) => (e.target.style.borderColor = "#3b82f6")}
                    onBlur={(e) => (e.target.style.borderColor = "#cbd5e1")}
                  />
                  <button
                    type="button"
                    onClick={() => setDropdownOpen((o) => !o)}
                    style={{
                      position: "absolute",
                      right: "8px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "#94a3b8",
                    }}
                  >
                    <svg
                      width="20"
                      height="20"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      style={{ transform: dropdownOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {dropdownOpen && (
                    <div
                      style={{
                        position: "absolute",
                        zIndex: 20,
                        marginTop: "8px",
                        width: "100%",
                        maxHeight: "240px",
                        overflowY: "auto",
                        borderRadius: "12px",
                        border: "1px solid #e2e8f0",
                        backgroundColor: "#ffffff",
                        boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1)",
                      }}
                    >
                      {setNameOptions.map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => {
                            setOverrides((prev) => ({ ...prev, setName: option }));
                            setDropdownOpen(false);
                          }}
                          style={{
                            display: "flex",
                            width: "100%",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "12px 16px",
                            textAlign: "left",
                            border: "none",
                            background: "transparent",
                            cursor: "pointer",
                            color: "#0f172a",
                            fontSize: "14px",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#eff6ff")}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                        >
                          <span>{option}</span>
                          {overrides.setName === option && (
                            <svg width="20" height="20" fill="#2563eb" viewBox="0 0 20 20">
                              <path
                                fillRule="evenodd"
                                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                clipRule="evenodd"
                              />
                            </svg>
                          )}
                        </button>
                      ))}
                      {overrides.setName && (
                        <>
                          <div style={{ borderTop: "1px solid #f1f5f9", margin: "4px 0" }} />
                          <button
                            type="button"
                            onClick={() => {
                              setOverrides((prev) => ({ ...prev, setName: "" }));
                              setDropdownOpen(false);
                            }}
                            style={{
                              width: "100%",
                              padding: "12px 16px",
                              textAlign: "left",
                              border: "none",
                              background: "transparent",
                              cursor: "pointer",
                              color: "#64748b",
                              fontStyle: "italic",
                              fontSize: "14px",
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f8fafc")}
                            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                          >
                            Clear selection
                          </button>
                        </>
                      )}
                  </div>
                )}
              </div>
            </div>

            {/* Condition */}
            <div style={styles.gridRow}>
              <div>
                <label style={styles.label}>Condition</label>
                <input
                  type="text"
                  value={localCondition || "UNKNOWN"}
                  disabled
                  style={styles.inputDerived}
                />
              </div>
              <div>
                <label style={{ ...styles.label, opacity: 0 }}>Condition</label>
                <select
                  value={localCondition}
                  onChange={(e) => setLocalCondition(e.target.value)}
                  style={{
                    ...styles.inputOverride,
                    paddingRight: "12px",
                    cursor: "pointer",
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
            </div>
            </div>
          </div>

          {/* Actions */}
          <div style={styles.footer}>
            <button
              type="button"
              onClick={handleDefaults}
              style={styles.btnCancel}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f1f5f9")}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
            >
              Defaults
            </button>
            <button
              type="button"
              onClick={handleSave}
              style={styles.btnSave}
            >
              {saved ? (
                <>
                  <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                  Saved
                </>
              ) : (
                "Save Changes"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // Robust Portal Fallback
  if (typeof document === "undefined") return null;

  const target = document.body;
  if (!target) {
    console.warn("TruthCoreModal: document.body is missing, rendering inline fallback");
    return modal; // Fallback to inline if body is missing (rare)
  }

  return createPortal(modal, target);
};

// Styles
const styles = {
  overlay: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    backdropFilter: "blur(4px)",
    zIndex: 9999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
  },
  modal: {
    position: "relative" as const,
    width: "100%",
    maxWidth: "900px",
    maxHeight: "90vh",
    backgroundColor: "#ffffff",
    borderRadius: "24px",
    boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
    overflow: "visible",
    zIndex: 10000,
    fontFamily: "Inter, system-ui, sans-serif",
    display: "flex",
    flexDirection: "column" as const,
  },
  header: {
    backgroundColor: "#141c2f",
    padding: "20px 32px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    color: "#ffffff",
    fontSize: "20px",
    fontWeight: 600,
    margin: 0,
  },
  closeButton: {
    background: "transparent",
    border: "1px solid rgba(255, 255, 255, 0.3)",
    color: "#ffffff",
    padding: "6px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: "13px",
    transition: "background 0.2s",
  },
  body: {
    padding: "40px",
    overflowY: "auto" as const,
    maxHeight: "70vh",
    backgroundColor: "#f8fafc", // slate-50
  },
  columnHeader: {
    display: "flex",
    justifyContent: "center",
    gap: "48px",
    marginBottom: "32px",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 16px",
    borderRadius: "9999px",
    fontSize: "12px",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  badgeDerived: {
    backgroundColor: "#f1f5f9", // slate-100
    color: "#475569", // slate-600
  },
  badgeOverride: {
    backgroundColor: "#eff6ff", // blue-50
    color: "#2563eb", // blue-600
  },
  dot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
  },
  gridRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "24px",
    marginBottom: "24px",
    alignItems: "flex-start",
  },
  label: {
    display: "block",
    fontSize: "14px",
    fontWeight: 600,
    color: "#1e293b", // slate-800
    marginBottom: "8px",
  },
  inputDerived: {
    width: "100%",
    padding: "12px 16px",
    borderRadius: "12px",
    border: "1px solid #e2e8f0", // slate-200
    backgroundColor: "#f8fafc", // slate-50
    color: "#64748b", // slate-500
    fontSize: "14px",
    boxSizing: "border-box" as const,
  },
  inputOverride: {
    width: "100%",
    padding: "12px 16px",
    borderRadius: "12px",
    border: "1px solid #cbd5e1", // slate-300
    backgroundColor: "#ffffff",
    color: "#0f172a", // slate-900
    fontSize: "14px",
    boxShadow: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
    boxSizing: "border-box" as const,
    outline: "none",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "16px",
    marginTop: "32px",
    paddingTop: "24px",
    borderTop: "1px solid #e2e8f0",
  },
  btnCancel: {
    padding: "10px 20px",
    borderRadius: "12px",
    border: "none",
    backgroundColor: "transparent",
    color: "#334155", // slate-700
    fontWeight: 500,
    fontSize: "14px",
    cursor: "pointer",
  },
  btnSave: {
    padding: "10px 24px",
    borderRadius: "12px",
    border: "none",
    background: "linear-gradient(to right, #2563eb, #1d4ed8)", // blue-600 to blue-700
    color: "#ffffff",
    fontWeight: 600,
    fontSize: "14px",
    cursor: "pointer",
    boxShadow: "0 4px 6px -1px rgba(37, 99, 235, 0.3)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
};

export default TruthCoreModal;
