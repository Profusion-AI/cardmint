/**
 * Image Hosting Service (ImageKit Integration)
 *
 * Uploads processed images to ImageKit CDN.
 * Replaces Cloudinary as the primary image hosting provider.
 *
 * Requirements:
 * - IMAGEKIT_PUBLIC_KEY
 * - IMAGEKIT_PRIVATE_KEY
 * - IMAGEKIT_URL_ENDPOINT
 */

import ImageKit from "imagekit";
import { promises as fs } from "node:fs";
import type { Logger } from "pino";

export interface ImageHostingConfig {
  publicKey: string;
  privateKey: string;
  urlEndpoint: string;
  folder?: string; // e.g., "/products"
  fallbackBaseUrl?: string;
}

export interface UploadResult {
  success: boolean;
  publicUrl?: string;
  secureUrl?: string;
  fileId?: string;
  sku: string;
  error?: string;
  fallback?: boolean;
}

export class ImageHostingService {
  private imagekit: ImageKit | null = null;
  private initialized = false;

  constructor(
    private readonly config: ImageHostingConfig,
    private readonly logger: Logger
  ) { }

  /**
   * Initialize ImageKit SDK
   */
  async initialize(): Promise<void> {
    try {
      if (!this.config.publicKey || !this.config.privateKey || !this.config.urlEndpoint) {
        throw new Error("Missing ImageKit credentials");
      }

      this.imagekit = new ImageKit({
        publicKey: this.config.publicKey,
        privateKey: this.config.privateKey,
        urlEndpoint: this.config.urlEndpoint,
      });

      this.initialized = true;
      this.logger.info("ImageKit service initialized");
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to initialize ImageKit service; falling back to local URLs");
      this.initialized = false;
    }
  }

  /**
   * Upload image to ImageKit
   *
   * @param localImagePath - Path to local file
   * @param sku - SKU identifier (used as file name)
   */
  async uploadImage(localImagePath: string, sku: string): Promise<UploadResult> {
    if (!this.initialized || !this.imagekit) {
      const fallbackUrl = this.generateFallbackUrl(sku);
      return {
        success: true,
        publicUrl: fallbackUrl,
        secureUrl: fallbackUrl,
        sku,
        fallback: true,
      };
    }

    try {
      const fileBuffer = await fs.readFile(localImagePath);

      const response = await this.imagekit.upload({
        file: fileBuffer,
        fileName: `${sku}.jpg`,
        folder: this.config.folder || "/products",
        useUniqueFileName: false,
        tags: ["cardmint", "product"],
      });

      this.logger.info(
        { fileId: response.fileId, url: response.url, sku },
        "Image uploaded to ImageKit"
      );

      return {
        success: true,
        publicUrl: response.url,
        secureUrl: response.url,
        fileId: response.fileId,
        sku,
        fallback: false,
      };
    } catch (error) {
      this.logger.error({ err: error, localImagePath, sku }, "Failed to upload to ImageKit");
      const fallbackUrl = this.generateFallbackUrl(sku);
      return {
        success: false,
        publicUrl: fallbackUrl,
        secureUrl: fallbackUrl,
        sku,
        error: error instanceof Error ? error.message : String(error),
        fallback: true,
      };
    }
  }

  /**
   * Get URL with transformations
   */
  getPublicUrl(sku: string, transformation?: any[]): string {
    if (!this.initialized || !this.imagekit) {
      return this.generateFallbackUrl(sku);
    }

    const path = `${this.config.folder || "/products"}/${sku}.jpg`;
    return this.imagekit.url({
      path,
      transformation: transformation || [],
    });
  }

  /**
   * Delete image from ImageKit
   */
  async deleteImage(sku: string): Promise<boolean> {
    // ImageKit delete requires fileId, which we don't store by default.
    // We'd need to look it up or store it.
    // For now, returning false as not implemented fully without fileId storage.
    this.logger.warn({ sku }, "deleteImage not fully implemented for ImageKit (requires fileId)");
    return false;
  }

  private generateFallbackUrl(sku: string): string {
    const baseUrl = this.config.fallbackBaseUrl || "http://127.0.0.1:4000";
    return `${baseUrl}/api/images/${sku}-front.jpg`;
  }

  isReady(): boolean {
    return this.initialized;
  }
}
