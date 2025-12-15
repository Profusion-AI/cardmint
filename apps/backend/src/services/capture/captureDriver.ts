import type { ScanJob } from "../../domain/job";

export interface CaptureResult {
  job?: ScanJob;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface HealthStatus {
  status: "healthy" | "degraded" | "unavailable";
  driver: string;
  details?: Record<string, unknown>;
}

/**
 * Abstraction for capture hardware drivers.
 * Implementations: SonyDriver (legacy CLI binary), Pi5KioskDriver (HTTP API)
 */
export interface CaptureDriver {
  /**
   * Execute a capture operation.
   * Returns job metadata if available (may be populated via backend callback).
   */
  capture(): Promise<CaptureResult>;

  /**
   * Check if the driver's hardware/service is reachable.
   * Used to gate `/api/capture` requests.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Query driver health status and any telemetry (e.g., spool depth for kiosk).
   * Surfaced via `/health` and `/metrics` endpoints.
   */
  health(): Promise<HealthStatus>;

  /**
   * Human-readable identifier for logging/diagnostics.
   */
  getDriverName(): string;
}
