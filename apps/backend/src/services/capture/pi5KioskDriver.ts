import axios, { type AxiosInstance, AxiosError } from "axios";
import type { Logger } from "pino";
import type { CaptureDriver, CaptureResult, HealthStatus } from "./captureDriver";
import { runtimeConfig } from "../../config";

interface KioskCaptureResponse {
  ok: boolean;
  uid: string;
  local: {
    img: string;
    meta: string;
  };
  profile?: string;
  timestamp?: number;
}

interface KioskHealthResponse {
  status: string;
  service: string;
  version: string;
  camera_status: string;
  spool?: {
    enabled: boolean;
    queued_pairs: number;
    bytes: number;
  };
  sftp?: {
    host: string;
    status: string;
  };
  preview_client_count?: number;
}

export class Pi5KioskDriver implements CaptureDriver {
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;
  private readonly queueWarnThreshold = 11; // Per assumptions doc line 21

  constructor(private readonly logger: Logger) {
    this.baseUrl = runtimeConfig.capturePiBaseUrl;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: runtimeConfig.capturePiTimeoutMs,
      headers: {
        "Content-Type": "application/json",
        ...(runtimeConfig.capturePiToken && {
          Authorization: `Bearer ${runtimeConfig.capturePiToken}`,
        }),
      },
    });
  }

  getDriverName(): string {
    return "pi-hq";
  }

  async isAvailable(): Promise<boolean> {
    try {
      const health = await this.health();
      return health.status === "healthy";
    } catch {
      return false;
    }
  }

  async health(): Promise<HealthStatus> {
    try {
      const { data } = await this.client.get<KioskHealthResponse>("/health", {
        timeout: 2000, // Fast health check
      });

      // Guard against missing preview_client_count (not in RFC spec yet)
      if (data.preview_client_count !== undefined && data.preview_client_count >= 2) {
        this.logger.warn(
          { count: data.preview_client_count },
          "Kiosk preview client limit reached (>=2)"
        );
      }

      // Map upstream status to our health model
      let mappedStatus: "healthy" | "degraded" | "unavailable" = "healthy";

      // Respect upstream status
      if (data.status === "degraded") {
        mappedStatus = "degraded";
      } else if (data.status === "offline" || data.status === "unavailable") {
        mappedStatus = "unavailable";
      }

      // Degrade based on camera status
      if (data.camera_status !== "ready" && data.camera_status !== "active") {
        mappedStatus = "degraded";
        this.logger.warn({ camera_status: data.camera_status }, "Kiosk camera not ready");
      }

      // Degrade if spool is at capacity
      if (data.spool && data.spool.bytes >= 20 * 1024 * 1024 * 1024) {
        mappedStatus = "degraded";
        this.logger.warn({ spool_bytes: data.spool.bytes }, "Kiosk spool at capacity (≥20 GiB)");
      }

      return {
        status: mappedStatus,
        driver: "pi-hq",
        details: {
          upstreamStatus: data.status,
          cameraStatus: data.camera_status,
          spool: data.spool,
          sftp: data.sftp,
          previewClients: data.preview_client_count,
        },
      };
    } catch (error) {
      this.logger.error({ err: error }, "Kiosk health check failed");
      return {
        status: "unavailable",
        driver: "pi-hq",
        details: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async capture(): Promise<CaptureResult> {
    const maxRetries = 3;
    let attempt = 0;
    let backoffMs = 250; // Min backoff per assumptions doc line 21

    while (attempt < maxRetries) {
      try {
        // Check for queue backpressure before attempting capture
        const healthStatus = await this.health();
        const spoolPairs = (healthStatus.details?.spool as any)?.queued_pairs ?? 0;

        if (spoolPairs >= this.queueWarnThreshold) {
          this.logger.warn(
            { spoolPairs, threshold: this.queueWarnThreshold },
            "Kiosk spool at high-water mark - applying backpressure throttle"
          );
          // Apply exponential backoff throttle per assumptions doc item 10
          await this.sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 8000); // Cap at 8s
        }

        // Build camera controls payload from env vars
        const controls: Record<string, unknown> = {};

        if (runtimeConfig.capturePiAeEnable !== undefined) {
          controls.AeEnable = runtimeConfig.capturePiAeEnable;
        }
        if (runtimeConfig.capturePiAwbEnable !== undefined) {
          controls.AwbEnable = runtimeConfig.capturePiAwbEnable;
        }
        if (runtimeConfig.capturePiExposureUs !== undefined) {
          controls.ExposureTime = runtimeConfig.capturePiExposureUs;
        }
        if (runtimeConfig.capturePiAnalogueGain !== undefined) {
          controls.AnalogueGain = runtimeConfig.capturePiAnalogueGain;
        }
        if (runtimeConfig.capturePiColourGains !== undefined) {
          // Parse "red_gain,blue_gain" format into [red_gain, blue_gain]
          const parts = runtimeConfig.capturePiColourGains.split(",").map(s => parseFloat(s.trim()));
          if (parts.length === 2 && parts.every(n => !isNaN(n))) {
            controls.ColourGains = parts;
          } else {
            this.logger.warn(
              { raw: runtimeConfig.capturePiColourGains },
              "Invalid CAPTURE_PI_COLOUR_GAINS format, expected 'red_gain,blue_gain' (2 values)"
            );
          }
        }

        const payload = Object.keys(controls).length > 0 ? { controls } : {};

        if (Object.keys(controls).length > 0) {
          this.logger.info({ controls }, "Kiosk capture request with manual controls");
        }

        const { data } = await this.client.post<KioskCaptureResponse>("/capture", payload);

        this.logger.info({ uid: data.uid }, "Kiosk capture successful");

        // Kiosk agent handles SFTP push; Fedora will ingest via watch-folder
        return {
          job: undefined, // Job will be created by watch-folder ingestion
          output: JSON.stringify(data),
          exitCode: 0,
          timedOut: false,
        };
      } catch (err: unknown) {
        attempt++;
        const error = err as Error | AxiosError;

        if (axios.isAxiosError(error)) {
          // Retry on 5xx server errors or network issues
          if (error.response?.status && error.response.status >= 500) {
            this.logger.warn(
              { attempt, maxRetries, backoffMs, status: error.response.status },
              "Kiosk capture failed with 5xx, retrying with exponential backoff"
            );

            if (attempt < maxRetries) {
              await this.sleep(backoffMs);
              backoffMs = Math.min(backoffMs * 2, 8000); // Cap at 8s
              continue;
            }
          }

          // Non-retryable error (4xx, timeout, etc.)
          this.logger.error({ err: error, attempt }, "Kiosk capture failed (non-retryable)");
          return {
            output: error.message,
            exitCode: error.response?.status ?? -1,
            timedOut: error.code === "ECONNABORTED",
          };
        }

        // Unknown error
        this.logger.error({ err: error }, "Kiosk capture encountered unexpected error");
        return {
          output: error instanceof Error ? error.message : String(error),
          exitCode: -1,
          timedOut: false,
        };
      }
    }

    // Max retries exhausted
    return {
      output: `Kiosk capture failed after ${maxRetries} attempts`,
      exitCode: -1,
      timedOut: false,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
