/**
 * EasyPost Shipping Label Service
 *
 * Provides shipping label generation via EasyPost API.
 * Used by operators to purchase labels after checkout is complete.
 *
 * Design principles:
 * - EasyPost is for label purchase only (not customer-facing rates)
 * - Method matching enforced (TRACKED/PRIORITY from checkout must match label)
 * - No PII persistence (addresses fetched from Stripe at label time)
 * - Idempotent label purchase (check shipment status before buying)
 *
 * @see https://docs.easypost.com/docs
 */

import { runtimeConfig } from "../config.js";
import type { ShippingMethod } from "../domain/shipping.js";
import type { Logger } from "pino";

// EasyPost API base URL
const EASYPOST_API_URL = "https://api.easypost.com/v2";

// USPS service mappings for CardMint shipping methods
const USPS_SERVICE_MAP: Record<ShippingMethod, string[]> = {
  TRACKED: [
    "GroundAdvantage", // USPS Ground Advantage (primary)
    "First", // First Class (fallback for light packages)
    "ParcelSelect", // Parcel Select Ground (fallback)
  ],
  PRIORITY: [
    "Priority", // USPS Priority Mail (primary)
    "PriorityMailExpress", // Express (fallback if Priority unavailable)
  ],
};

// --- Types ---

export interface EasyPostAddress {
  name?: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
}

export interface EasyPostParcel {
  length: number; // inches
  width: number; // inches
  height: number; // inches
  weight: number; // ounces
}

export interface EasyPostRate {
  id: string;
  carrier: string;
  service: string;
  rate: string; // USD as string
  currency: string;
  delivery_days: number | null;
  delivery_date: string | null;
  delivery_date_guaranteed: boolean;
  est_delivery_days: number | null;
  retail_rate: string | null;
  list_rate: string | null;
}

export interface EasyPostShipment {
  id: string;
  object: "Shipment";
  mode: "test" | "production";
  status: string;
  tracking_code: string | null;
  rates: EasyPostRate[];
  selected_rate: EasyPostRate | null;
  postage_label: {
    id: string;
    label_url: string;
    label_pdf_url: string;
    label_zpl_url: string | null;
    label_epl2_url: string | null;
    label_file_type: string;
    label_size: string;
    label_resolution: number;
    label_date: string;
  } | null;
  to_address: { id: string } & EasyPostAddress;
  from_address: { id: string } & EasyPostAddress;
  parcel: { id: string } & EasyPostParcel;
  created_at: string;
  updated_at: string;
}

export interface EasyPostError {
  error: {
    code: string;
    message: string;
    errors: Array<{ field: string; message: string }>;
  };
}

export interface CreateShipmentResult {
  success: boolean;
  shipment?: EasyPostShipment;
  compatibleRates?: EasyPostRate[]; // Rates matching the requested shipping method
  error?: string;
  errorCode?: string;
}

export interface PurchaseLabelResult {
  success: boolean;
  shipment?: EasyPostShipment;
  trackingNumber?: string;
  labelUrl?: string;
  carrier?: string;
  service?: string;
  error?: string;
  errorCode?: string;
  alreadyPurchased?: boolean; // True if label was already bought (idempotent)
}

// --- Service Class ---

export class EasyPostService {
  private apiKey: string;
  private testMode: boolean;
  private fromAddress: EasyPostAddress;
  private parcelDefaults: {
    weightBaseOz: number;
    weightPerCardOz: number;
    lengthIn: number;
    widthIn: number;
    heightIn: number;
  };
  private logger: Logger;

  constructor(logger: Logger) {
    this.apiKey = runtimeConfig.easypostApiKey;
    this.testMode = runtimeConfig.easypostTestMode;
    this.fromAddress = runtimeConfig.easypostFromAddress;
    this.parcelDefaults = runtimeConfig.easypostParcel;
    this.logger = logger.child({ service: "easypost" });
  }

  /**
   * Check if EasyPost is configured and ready
   */
  isConfigured(): boolean {
    return (
      this.apiKey.length > 0 &&
      this.fromAddress.street1.length > 0 &&
      this.fromAddress.city.length > 0 &&
      this.fromAddress.state.length > 0 &&
      this.fromAddress.zip.length > 0
    );
  }

  /**
   * Get from address validation status
   */
  getConfigStatus(): { configured: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!this.apiKey) missing.push("EASYPOST_API_KEY");
    if (!this.fromAddress.street1) missing.push("EASYPOST_FROM_STREET1");
    if (!this.fromAddress.city) missing.push("EASYPOST_FROM_CITY");
    if (!this.fromAddress.state) missing.push("EASYPOST_FROM_STATE");
    if (!this.fromAddress.zip) missing.push("EASYPOST_FROM_ZIP");
    return { configured: missing.length === 0, missing };
  }

  /**
   * Calculate parcel weight based on item count
   */
  calculateParcelWeight(itemCount: number): number {
    return this.parcelDefaults.weightBaseOz + itemCount * this.parcelDefaults.weightPerCardOz;
  }

  /**
   * Create a shipment and get rates
   *
   * @param toAddress - Customer shipping address (from Stripe)
   * @param itemCount - Number of items in order (for weight calculation)
   * @param requiredMethod - The shipping method from checkout (TRACKED or PRIORITY)
   */
  async createShipment(
    toAddress: EasyPostAddress,
    itemCount: number,
    requiredMethod: ShippingMethod
  ): Promise<CreateShipmentResult> {
    if (!this.isConfigured()) {
      const status = this.getConfigStatus();
      return {
        success: false,
        error: `EasyPost not configured. Missing: ${status.missing.join(", ")}`,
        errorCode: "EASYPOST_NOT_CONFIGURED",
      };
    }

    const parcel: EasyPostParcel = {
      length: this.parcelDefaults.lengthIn,
      width: this.parcelDefaults.widthIn,
      height: this.parcelDefaults.heightIn,
      weight: this.calculateParcelWeight(itemCount),
    };

    try {
      const response = await this.apiRequest<EasyPostShipment>("POST", "/shipments", {
        shipment: {
          to_address: toAddress,
          from_address: this.fromAddress,
          parcel,
        },
      });

      if ("error" in response) {
        const err = response as EasyPostError;
        this.logger.error({ err: err.error }, "EasyPost createShipment failed");
        return {
          success: false,
          error: err.error.message,
          errorCode: err.error.code,
        };
      }

      const shipment = response as EasyPostShipment;

      // Filter rates to only those compatible with the required shipping method
      const compatibleServices = USPS_SERVICE_MAP[requiredMethod];
      const compatibleRates = shipment.rates.filter(
        (rate) => rate.carrier === "USPS" && compatibleServices.includes(rate.service)
      );

      this.logger.info(
        {
          shipmentId: shipment.id,
          mode: shipment.mode,
          totalRates: shipment.rates.length,
          compatibleRates: compatibleRates.length,
          requiredMethod,
        },
        "EasyPost shipment created"
      );

      return {
        success: true,
        shipment,
        compatibleRates,
      };
    } catch (err) {
      this.logger.error({ err }, "EasyPost createShipment exception");
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
        errorCode: "EASYPOST_REQUEST_FAILED",
      };
    }
  }

  /**
   * Get an existing shipment by ID
   * Used for idempotency checks before purchasing
   */
  async getShipment(shipmentId: string): Promise<EasyPostShipment | null> {
    try {
      const response = await this.apiRequest<EasyPostShipment>("GET", `/shipments/${shipmentId}`);

      if ("error" in response) {
        return null;
      }

      return response as EasyPostShipment;
    } catch {
      return null;
    }
  }

  /**
   * Purchase a shipping label for a shipment
   *
   * Implements idempotency: if label already purchased, returns existing data.
   *
   * @param shipmentId - EasyPost shipment ID
   * @param rateId - EasyPost rate ID to purchase
   * @param requiredMethod - The shipping method from checkout (for validation)
   */
  async purchaseLabel(
    shipmentId: string,
    rateId: string,
    requiredMethod: ShippingMethod
  ): Promise<PurchaseLabelResult> {
    // Idempotency check: get current shipment status
    const existingShipment = await this.getShipment(shipmentId);

    if (existingShipment?.postage_label && existingShipment.tracking_code) {
      this.logger.info(
        {
          shipmentId,
          trackingNumber: existingShipment.tracking_code,
        },
        "Label already purchased (idempotent return)"
      );

      return {
        success: true,
        shipment: existingShipment,
        trackingNumber: existingShipment.tracking_code,
        labelUrl: existingShipment.postage_label.label_url,
        carrier: existingShipment.selected_rate?.carrier,
        service: existingShipment.selected_rate?.service,
        alreadyPurchased: true,
      };
    }

    // Validate rate matches required method
    if (existingShipment) {
      const rate = existingShipment.rates.find((r) => r.id === rateId);
      if (rate) {
        const compatibleServices = USPS_SERVICE_MAP[requiredMethod];
        if (rate.carrier !== "USPS" || !compatibleServices.includes(rate.service)) {
          this.logger.warn(
            {
              shipmentId,
              rateId,
              rateService: rate.service,
              requiredMethod,
              compatibleServices,
            },
            "Rate does not match required shipping method"
          );
          return {
            success: false,
            error: `Rate service "${rate.service}" does not match required method "${requiredMethod}"`,
            errorCode: "METHOD_MISMATCH",
          };
        }
      }
    }

    try {
      const response = await this.apiRequest<EasyPostShipment>(
        "POST",
        `/shipments/${shipmentId}/buy`,
        { rate: { id: rateId } }
      );

      if ("error" in response) {
        const err = response as EasyPostError;
        this.logger.error({ err: err.error, shipmentId, rateId }, "EasyPost purchaseLabel failed");
        return {
          success: false,
          error: err.error.message,
          errorCode: err.error.code,
        };
      }

      const shipment = response as EasyPostShipment;

      this.logger.info(
        {
          shipmentId: shipment.id,
          trackingNumber: shipment.tracking_code,
          carrier: shipment.selected_rate?.carrier,
          service: shipment.selected_rate?.service,
          rate: shipment.selected_rate?.rate,
        },
        "EasyPost label purchased"
      );

      return {
        success: true,
        shipment,
        trackingNumber: shipment.tracking_code ?? undefined,
        labelUrl: shipment.postage_label?.label_url,
        carrier: shipment.selected_rate?.carrier,
        service: shipment.selected_rate?.service,
        alreadyPurchased: false,
      };
    } catch (err) {
      this.logger.error({ err, shipmentId, rateId }, "EasyPost purchaseLabel exception");
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
        errorCode: "EASYPOST_REQUEST_FAILED",
      };
    }
  }

  /**
   * Make an authenticated request to the EasyPost API
   */
  private async apiRequest<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>
  ): Promise<T | EasyPostError> {
    const url = `${EASYPOST_API_URL}${path}`;

    // EasyPost uses Basic Auth with API key as username, no password
    const authHeader = "Basic " + Buffer.from(`${this.apiKey}:`).toString("base64");

    const options: RequestInit = {
      method,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        "User-Agent": "CardMint/1.0",
      },
    };

    if (body && method === "POST") {
      options.body = JSON.stringify(body);
    }

    this.logger.debug({ method, path, hasBody: !!body }, "EasyPost API request");

    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
      return data as EasyPostError;
    }

    return data as T;
  }
}

/**
 * Factory function to create EasyPost service instance
 */
export function createEasyPostService(logger: Logger): EasyPostService {
  return new EasyPostService(logger);
}
