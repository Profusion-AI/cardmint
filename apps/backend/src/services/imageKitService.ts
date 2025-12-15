/**
 * ImageKit Service
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

export interface ImageKitConfig {
    publicKey: string;
    privateKey: string;
    urlEndpoint: string;
    folder?: string; // e.g., "/products"
}

export interface UploadResult {
    success: boolean;
    url?: string;
    fileId?: string;
    name: string;
    error?: string;
}

export class ImageKitService {
    private imagekit: ImageKit | null = null;
    private initialized = false;

    constructor(
        private readonly config: ImageKitConfig,
        private readonly logger: Logger
    ) { }

    /**
     * Initialize ImageKit SDK
     */
    initialize(): void {
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
            this.logger.warn({ err: error }, "Failed to initialize ImageKit service");
            this.initialized = false;
        }
    }

    /**
     * Upload image to ImageKit
     *
     * @param localPath - Path to local file
     * @param fileName - Desired file name (e.g., SKU-front.jpg)
     * @param folder - Optional folder override
     */
    async uploadImage(localPath: string, fileName: string, folder?: string): Promise<UploadResult> {
        if (!this.initialized || !this.imagekit) {
            return {
                success: false,
                name: fileName,
                error: "ImageKit not initialized",
            };
        }

        try {
            const fileBuffer = await fs.readFile(localPath);

            const response = await this.imagekit.upload({
                file: fileBuffer, // required
                fileName: fileName, // required
                folder: folder || this.config.folder || "/products",
                useUniqueFileName: false, // We want deterministic names based on SKU
                tags: ["cardmint", "product"],
            });

            this.logger.info(
                { fileId: response.fileId, url: response.url, name: fileName },
                "Image uploaded to ImageKit"
            );

            return {
                success: true,
                url: response.url,
                fileId: response.fileId,
                name: fileName,
            };
        } catch (error) {
            this.logger.error({ err: error, localPath, fileName }, "Failed to upload to ImageKit");
            return {
                success: false,
                name: fileName,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Get URL with transformations
     *
     * @param path - Path to file in ImageKit (e.g. "/products/SKU-front.jpg")
     * @param transformation - Array of transformation objects
     */
    getUrl(path: string, transformation?: any[]): string {
        if (!this.initialized || !this.imagekit) {
            return "";
        }

        return this.imagekit.url({
            path,
            transformation: transformation || [],
        });
    }

    isReady(): boolean {
        return this.initialized;
    }
}
