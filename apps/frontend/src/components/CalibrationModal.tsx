import React, { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  fetchCaptureSettings,
  updateCaptureSettings,
  triggerTestCapture,
  fetchCalibrationStatus,
  processCalibration,
  calibrationRawImageUrl,
  calibrationProcessedImageUrl,
  type CaptureSettings,
  type CalibrationStatus,
} from "../api/client";

interface CalibrationModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type WorkflowStep = "idle" | "capturing" | "processing" | "done";

const CalibrationModal: React.FC<CalibrationModalProps> = ({ isOpen, onClose }) => {
  // Settings state
  const [settings, setSettings] = useState<CaptureSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Local edits (before saving)
  const [cameraEdits, setCameraEdits] = useState({
    exposure_us: 0,
    analogue_gain: 0,
    colour_gains_red: 0,
    colour_gains_blue: 0,
    ae_enable: false,
    awb_enable: false,
  });
  const [stage3Edits, setStage3Edits] = useState({
    clahe_clip_limit: 0,
    clahe_tile_size: 0,
    awb_enable: false,
  });

  // Calibration workflow state
  const [calibrationId, setCalibrationId] = useState<string | null>(null);
  const [calibrationStatus, setCalibrationStatus] = useState<CalibrationStatus | null>(null);
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>("idle");
  const [rateLimitMs, setRateLimitMs] = useState(0);

  // Polling ref
  const pollIntervalRef = useRef<number | null>(null);

  // Load settings on open
  useEffect(() => {
    if (!isOpen) return;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchCaptureSettings();
        setSettings(data);
        // Initialize edits from loaded settings
        setCameraEdits({
          exposure_us: data.camera.exposure_us,
          analogue_gain: data.camera.analogue_gain,
          colour_gains_red: data.camera.colour_gains.red,
          colour_gains_blue: data.camera.colour_gains.blue,
          ae_enable: data.camera.ae_enable,
          awb_enable: data.camera.awb_enable,
        });
        setStage3Edits({
          clahe_clip_limit: data.stage3.clahe_clip_limit,
          clahe_tile_size: data.stage3.clahe_tile_size,
          awb_enable: data.stage3.awb_enable,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load settings");
      } finally {
        setLoading(false);
      }
    };

    load();

    // Reset state when modal opens
    setCalibrationId(null);
    setCalibrationStatus(null);
    setWorkflowStep("idle");
    setSaveSuccess(false);
    setRateLimitMs(0);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [isOpen]);

  // Rate limit countdown
  useEffect(() => {
    if (rateLimitMs <= 0) return;
    const timer = setInterval(() => {
      setRateLimitMs((prev) => Math.max(0, prev - 100));
    }, 100);
    return () => clearInterval(timer);
  }, [rateLimitMs]);

  // Poll calibration status
  const startPolling = useCallback((id: string) => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    const poll = async () => {
      try {
        const status = await fetchCalibrationStatus(id);
        setCalibrationStatus(status.status);

        if (status.status === "CAPTURED" || status.status === "PROCESSED") {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          if (status.status === "CAPTURED") {
            setWorkflowStep("idle");
          } else if (status.status === "PROCESSED") {
            setWorkflowStep("done");
          }
        } else if (status.status === "FAILED") {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setError(status.error || "Calibration failed");
          setWorkflowStep("idle");
        }
      } catch (err) {
        console.warn("Poll error:", err);
      }
    };

    poll();
    pollIntervalRef.current = window.setInterval(poll, 1000);
  }, []);

  // Handle test capture
  const handleTestCapture = async () => {
    setError(null);
    setWorkflowStep("capturing");
    setCalibrationStatus("PENDING");

    try {
      const result = await triggerTestCapture({
        camera: {
          exposure_us: cameraEdits.exposure_us,
          analogue_gain: cameraEdits.analogue_gain,
          colour_gains: {
            red: cameraEdits.colour_gains_red,
            blue: cameraEdits.colour_gains_blue,
          },
          ae_enable: cameraEdits.ae_enable,
          awb_enable: cameraEdits.awb_enable,
        },
      });

      setCalibrationId(result.calibration_id);
      startPolling(result.calibration_id);
    } catch (err: any) {
      if (err.retryAfterMs) {
        setRateLimitMs(err.retryAfterMs);
      }
      setError(err instanceof Error ? err.message : "Test capture failed");
      setWorkflowStep("idle");
      setCalibrationStatus(null);
    }
  };

  // Handle process
  const handleProcess = async () => {
    if (!calibrationId) return;

    setError(null);
    setWorkflowStep("processing");

    try {
      await processCalibration(calibrationId, {
        stage3: {
          clahe_clip_limit: stage3Edits.clahe_clip_limit,
          clahe_tile_size: stage3Edits.clahe_tile_size,
          awb_enable: stage3Edits.awb_enable,
        },
      });

      setCalibrationStatus("PROCESSED");
      setWorkflowStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Processing failed");
      setWorkflowStep("idle");
    }
  };

  // Handle save settings
  const handleSaveSettings = async () => {
    setError(null);
    setSaveSuccess(false);

    try {
      const updated = await updateCaptureSettings({
        camera: {
          exposure_us: cameraEdits.exposure_us,
          analogue_gain: cameraEdits.analogue_gain,
          colour_gains: {
            red: cameraEdits.colour_gains_red,
            blue: cameraEdits.colour_gains_blue,
          },
          ae_enable: cameraEdits.ae_enable,
          awb_enable: cameraEdits.awb_enable,
        },
        stage3: {
          clahe_clip_limit: stage3Edits.clahe_clip_limit,
          clahe_tile_size: stage3Edits.clahe_tile_size,
          awb_enable: stage3Edits.awb_enable,
        },
      });

      setSettings(updated);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    }
  };

  // Handle reset to defaults
  const handleReset = () => {
    if (!settings) return;
    setCameraEdits({
      exposure_us: settings.camera.exposure_us,
      analogue_gain: settings.camera.analogue_gain,
      colour_gains_red: settings.camera.colour_gains.red,
      colour_gains_blue: settings.camera.colour_gains.blue,
      ae_enable: settings.camera.ae_enable,
      awb_enable: settings.camera.awb_enable,
    });
    setStage3Edits({
      clahe_clip_limit: settings.stage3.clahe_clip_limit,
      clahe_tile_size: settings.stage3.clahe_tile_size,
      awb_enable: settings.stage3.awb_enable,
    });
  };

  if (!isOpen) return null;

  const isCapturing = workflowStep === "capturing";
  const isProcessing = workflowStep === "processing";
  const canProcess = calibrationStatus === "CAPTURED" && !isCapturing && !isProcessing;
  const canTestCapture = !isCapturing && !isProcessing && rateLimitMs === 0;

  const modal = (
    <div style={styles.overlay}>
      <div style={{ position: "absolute", inset: 0 }} onClick={onClose} />
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>Capture QA Settings</h2>
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
          {loading ? (
            <div style={styles.loadingState}>Loading settings...</div>
          ) : error ? (
            <div style={styles.errorState}>{error}</div>
          ) : (
            <>
              {/* Settings Grid */}
              <div style={styles.settingsGrid}>
                {/* Camera Controls */}
                <div style={styles.settingsSection}>
                  <h3 style={styles.sectionTitle}>Camera Controls</h3>

                  <div style={styles.inputGroup}>
                    <label style={styles.label}>Exposure (μs)</label>
                    <input
                      type="number"
                      value={cameraEdits.exposure_us}
                      onChange={(e) =>
                        setCameraEdits((prev) => ({ ...prev, exposure_us: Number(e.target.value) }))
                      }
                      style={styles.input}
                    />
                  </div>

                  <div style={styles.inputGroup}>
                    <label style={styles.label}>Analogue Gain</label>
                    <input
                      type="number"
                      step="0.1"
                      value={cameraEdits.analogue_gain}
                      onChange={(e) =>
                        setCameraEdits((prev) => ({ ...prev, analogue_gain: Number(e.target.value) }))
                      }
                      style={styles.input}
                    />
                  </div>

                  <div style={styles.inputGroup}>
                    <label style={styles.label}>Red WB Gain</label>
                    <input
                      type="number"
                      step="0.01"
                      value={cameraEdits.colour_gains_red}
                      onChange={(e) =>
                        setCameraEdits((prev) => ({ ...prev, colour_gains_red: Number(e.target.value) }))
                      }
                      style={styles.input}
                    />
                  </div>

                  <div style={styles.inputGroup}>
                    <label style={styles.label}>Blue WB Gain</label>
                    <input
                      type="number"
                      step="0.01"
                      value={cameraEdits.colour_gains_blue}
                      onChange={(e) =>
                        setCameraEdits((prev) => ({ ...prev, colour_gains_blue: Number(e.target.value) }))
                      }
                      style={styles.input}
                    />
                  </div>

                  <div style={styles.toggleGroup}>
                    <label style={styles.toggleLabel}>
                      <input
                        type="checkbox"
                        checked={cameraEdits.ae_enable}
                        onChange={(e) =>
                          setCameraEdits((prev) => ({ ...prev, ae_enable: e.target.checked }))
                        }
                        style={styles.checkbox}
                      />
                      Auto Exposure
                    </label>
                  </div>

                  <div style={styles.toggleGroup}>
                    <label style={styles.toggleLabel}>
                      <input
                        type="checkbox"
                        checked={cameraEdits.awb_enable}
                        onChange={(e) =>
                          setCameraEdits((prev) => ({ ...prev, awb_enable: e.target.checked }))
                        }
                        style={styles.checkbox}
                      />
                      Auto White Balance
                    </label>
                  </div>
                </div>

                {/* Stage 3 Controls */}
                <div style={styles.settingsSection}>
                  <h3 style={styles.sectionTitle}>Stage 3 Controls</h3>

                  <div style={styles.inputGroup}>
                    <label style={styles.label}>CLAHE Clip Limit</label>
                    <input
                      type="number"
                      step="0.1"
                      value={stage3Edits.clahe_clip_limit}
                      onChange={(e) =>
                        setStage3Edits((prev) => ({ ...prev, clahe_clip_limit: Number(e.target.value) }))
                      }
                      style={styles.input}
                    />
                  </div>

                  <div style={styles.inputGroup}>
                    <label style={styles.label}>CLAHE Tile Size</label>
                    <input
                      type="number"
                      value={stage3Edits.clahe_tile_size}
                      onChange={(e) =>
                        setStage3Edits((prev) => ({ ...prev, clahe_tile_size: Number(e.target.value) }))
                      }
                      style={styles.input}
                    />
                  </div>

                  <div style={styles.toggleGroup}>
                    <label style={styles.toggleLabel}>
                      <input
                        type="checkbox"
                        checked={stage3Edits.awb_enable}
                        onChange={(e) =>
                          setStage3Edits((prev) => ({ ...prev, awb_enable: e.target.checked }))
                        }
                        style={styles.checkbox}
                      />
                      Gray World AWB
                    </label>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div style={styles.actionBar}>
                <button
                  type="button"
                  onClick={handleTestCapture}
                  disabled={!canTestCapture}
                  style={{
                    ...styles.btnPrimary,
                    opacity: canTestCapture ? 1 : 0.5,
                    cursor: canTestCapture ? "pointer" : "not-allowed",
                  }}
                >
                  {isCapturing ? "Capturing..." : rateLimitMs > 0 ? `Wait ${Math.ceil(rateLimitMs / 1000)}s` : "Test Capture"}
                </button>

                <button
                  type="button"
                  onClick={handleProcess}
                  disabled={!canProcess}
                  style={{
                    ...styles.btnSecondary,
                    opacity: canProcess ? 1 : 0.5,
                    cursor: canProcess ? "pointer" : "not-allowed",
                  }}
                >
                  {isProcessing ? "Processing..." : "Process"}
                </button>

                <div style={{ flex: 1 }} />

                <button
                  type="button"
                  onClick={handleReset}
                  style={styles.btnText}
                >
                  Reset
                </button>

                <button
                  type="button"
                  onClick={handleSaveSettings}
                  style={styles.btnSave}
                >
                  {saveSuccess ? "Saved!" : "Save Settings"}
                </button>
              </div>

              {/* Status Indicator */}
              {calibrationStatus && (
                <div style={styles.statusBar}>
                  <span style={styles.statusLabel}>Status:</span>
                  <span
                    style={{
                      ...styles.statusBadge,
                      backgroundColor:
                        calibrationStatus === "PROCESSED"
                          ? "#22c55e"
                          : calibrationStatus === "CAPTURED"
                          ? "#3b82f6"
                          : calibrationStatus === "FAILED"
                          ? "#ef4444"
                          : "#f59e0b",
                    }}
                  >
                    {calibrationStatus}
                  </span>
                </div>
              )}

              {/* Preview Section */}
              {calibrationId && (calibrationStatus === "CAPTURED" || calibrationStatus === "PROCESSED") && (
                <div style={styles.previewSection}>
                  <h3 style={styles.sectionTitle}>Preview</h3>
                  <div style={styles.previewGrid}>
                    <div style={styles.previewCard}>
                      <div style={styles.previewLabel}>Raw Capture</div>
                      <img
                        src={calibrationRawImageUrl(calibrationId)}
                        alt="Raw capture"
                        style={styles.previewImage}
                      />
                    </div>

                    {calibrationStatus === "PROCESSED" && (
                      <div style={styles.previewCard}>
                        <div style={styles.previewLabel}>Processed (Stage 3)</div>
                        <img
                          src={calibrationProcessedImageUrl(calibrationId)}
                          alt="Processed"
                          style={styles.previewImage}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  const target = document.body;
  if (!target) return modal;

  return createPortal(modal, target);
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
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
    position: "relative",
    width: "100%",
    maxWidth: "900px",
    maxHeight: "90vh",
    backgroundColor: "#ffffff",
    borderRadius: "24px",
    boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
    overflow: "hidden",
    zIndex: 10000,
    fontFamily: "Inter, system-ui, sans-serif",
    display: "flex",
    flexDirection: "column",
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
    padding: "32px",
    overflowY: "auto",
    maxHeight: "calc(90vh - 80px)",
    backgroundColor: "#f8fafc",
  },
  loadingState: {
    textAlign: "center",
    color: "#64748b",
    padding: "48px",
  },
  errorState: {
    textAlign: "center",
    color: "#ef4444",
    padding: "48px",
    backgroundColor: "#fef2f2",
    borderRadius: "12px",
  },
  settingsGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "32px",
    marginBottom: "24px",
  },
  settingsSection: {
    backgroundColor: "#ffffff",
    borderRadius: "16px",
    padding: "24px",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.1)",
  },
  sectionTitle: {
    fontSize: "16px",
    fontWeight: 600,
    color: "#1e293b",
    marginTop: 0,
    marginBottom: "20px",
    paddingBottom: "12px",
    borderBottom: "1px solid #e2e8f0",
  },
  inputGroup: {
    marginBottom: "16px",
  },
  label: {
    display: "block",
    fontSize: "13px",
    fontWeight: 500,
    color: "#475569",
    marginBottom: "6px",
  },
  input: {
    width: "100%",
    padding: "10px 14px",
    borderRadius: "8px",
    border: "1px solid #cbd5e1",
    backgroundColor: "#ffffff",
    fontSize: "14px",
    color: "#0f172a",
    boxSizing: "border-box",
    outline: "none",
  },
  toggleGroup: {
    marginBottom: "12px",
  },
  toggleLabel: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    fontSize: "14px",
    color: "#334155",
    cursor: "pointer",
  },
  checkbox: {
    width: "18px",
    height: "18px",
    cursor: "pointer",
  },
  actionBar: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "16px 0",
    borderTop: "1px solid #e2e8f0",
    borderBottom: "1px solid #e2e8f0",
    marginBottom: "16px",
  },
  btnPrimary: {
    padding: "10px 20px",
    borderRadius: "10px",
    border: "none",
    background: "linear-gradient(to right, #2563eb, #1d4ed8)",
    color: "#ffffff",
    fontWeight: 600,
    fontSize: "14px",
    boxShadow: "0 2px 4px rgba(37, 99, 235, 0.3)",
  },
  btnSecondary: {
    padding: "10px 20px",
    borderRadius: "10px",
    border: "1px solid #cbd5e1",
    backgroundColor: "#ffffff",
    color: "#334155",
    fontWeight: 500,
    fontSize: "14px",
  },
  btnText: {
    padding: "10px 16px",
    borderRadius: "10px",
    border: "none",
    backgroundColor: "transparent",
    color: "#64748b",
    fontWeight: 500,
    fontSize: "14px",
    cursor: "pointer",
  },
  btnSave: {
    padding: "10px 24px",
    borderRadius: "10px",
    border: "none",
    background: "linear-gradient(to right, #22c55e, #16a34a)",
    color: "#ffffff",
    fontWeight: 600,
    fontSize: "14px",
    cursor: "pointer",
    boxShadow: "0 2px 4px rgba(34, 197, 94, 0.3)",
  },
  statusBar: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    marginBottom: "20px",
  },
  statusLabel: {
    fontSize: "14px",
    fontWeight: 500,
    color: "#64748b",
  },
  statusBadge: {
    padding: "4px 12px",
    borderRadius: "9999px",
    color: "#ffffff",
    fontSize: "12px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  previewSection: {
    backgroundColor: "#ffffff",
    borderRadius: "16px",
    padding: "24px",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.1)",
  },
  previewGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "24px",
  },
  previewCard: {
    textAlign: "center",
  },
  previewLabel: {
    fontSize: "13px",
    fontWeight: 500,
    color: "#64748b",
    marginBottom: "12px",
  },
  previewImage: {
    width: "100%",
    maxHeight: "300px",
    objectFit: "contain",
    borderRadius: "12px",
    border: "1px solid #e2e8f0",
    backgroundColor: "#f1f5f9",
  },
};

export default CalibrationModal;
