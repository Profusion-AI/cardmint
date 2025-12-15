import type { Logger } from "pino";
import { runtimeConfig } from "../config";
import { JobRepository } from "../repositories/jobRepository";
import type { CaptureDriver, CaptureResult, HealthStatus } from "./capture/captureDriver";
import { Pi5KioskDriver } from "./capture/pi5KioskDriver";

/**
 * Factory for capture drivers.
 * Selects implementation based on CAPTURE_DRIVER env flag.
 * Supports instant rollback via flag flip + restart (≤30s SLA).
 */
export class CaptureAdapter {
  private readonly driver: CaptureDriver;

  constructor(repository: JobRepository, logger: Logger) {
    const driverType = runtimeConfig.captureDriver;

    switch (driverType) {
      case "pi-hq":
        this.driver = new Pi5KioskDriver(logger);
        break;
      case "sony":
        throw new Error("Sony capture driver has been deprecated. Use CAPTURE_DRIVER=pi-hq");
      default:
        throw new Error(`Unknown capture driver: ${driverType}`);
    }

    logger.info({ driver: this.driver.getDriverName() }, "Capture driver initialized");
  }

  async isAvailable(): Promise<boolean> {
    return this.driver.isAvailable();
  }

  getDriverName(): string {
    return this.driver.getDriverName();
  }

  async capture(): Promise<CaptureResult> {
    return this.driver.capture();
  }

  async health(): Promise<HealthStatus> {
    return this.driver.health();
  }
}
