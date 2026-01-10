/**
 * Label Processing Service
 *
 * Optimizes shipping labels for Polono PL-60 thermal printer.
 *
 * Target specs:
 * - 4" x 6" labels
 * - 203 DPI resolution
 * - 812 x 1218 pixels
 * - 1-bit black/white (thermal printers are monochrome, avoids CUPS dithering artifacts)
 *
 * Output formats:
 * - PNG: For GIMP workflow (respects DPI metadata)
 * - PDF: For direct printing from native viewers (Fedora's image viewer ignores DPI)
 */

import sharp from "sharp";
import PDFDocument from "pdfkit";
import * as fs from "node:fs";
import * as path from "node:path";
import { runtimeConfig } from "../config.js";
import { createLogger } from "../app/context.js";

const logger = createLogger().child({ service: "LabelProcessingService" });

// PL-60 optimal settings (203 DPI thermal printer, 4x6 labels)
const PL60_DPI = 203;
const PL60_WIDTH = 812;   // 4 inches * 203 DPI
const PL60_HEIGHT = 1218; // 6 inches * 203 DPI

// PDF dimensions in points (72 pts/inch)
const PDF_WIDTH_PTS = 4 * 72;   // 288 pts = 4 inches
const PDF_HEIGHT_PTS = 6 * 72;  // 432 pts = 6 inches

// Cache directory for processed labels
const LABEL_CACHE_DIR = runtimeConfig.labelCacheDir || "/var/lib/cardmint/label-cache";
const LABEL_CACHE_VERSION = "v4"; // Bump to invalidate cached labels when processing changes

export type LabelOutputFormat = "png" | "pdf";

export interface ProcessedLabel {
  originalUrl: string;
  optimizedPath: string;
  optimizedBuffer: Buffer;
  width: number;
  height: number;
  dpi: number;
  format: LabelOutputFormat;
}

/**
 * Ensure the label cache directory exists
 */
async function ensureCacheDir(): Promise<void> {
  await fs.promises.mkdir(LABEL_CACHE_DIR, { recursive: true });
}

/**
 * Build cache path for a processed label
 */
function buildCachePath(
  shipmentId: number,
  shipmentType: "marketplace" | "stripe",
  format: LabelOutputFormat = "png"
): string {
  const ext = format === "pdf" ? "pdf" : "png";
  return path.join(LABEL_CACHE_DIR, `label_${shipmentType}_${shipmentId}_pl60_${LABEL_CACHE_VERSION}.${ext}`);
}

/**
 * Check if a cached optimized label exists
 */
export async function getCachedLabel(
  shipmentId: number,
  shipmentType: "marketplace" | "stripe" = "marketplace"
): Promise<Buffer | null> {
  const cachePath = buildCachePath(shipmentId, shipmentType);
  try {
    return await fs.promises.readFile(cachePath);
  } catch {
    return null;
  }
}

/**
 * Download and optimize a label for the PL-60 printer
 *
 * @param labelUrl - EasyPost label URL (PNG or PDF)
 * @param shipmentId - Shipment ID for caching
 * @param shipmentType - Type of shipment
 * @param outputFormat - Output format: "png" for GIMP, "pdf" for direct printing
 * @returns Processed label with optimized buffer
 */
export async function processLabelForPL60(
  labelUrl: string,
  shipmentId: number,
  shipmentType: "marketplace" | "stripe" = "marketplace",
  outputFormat: LabelOutputFormat = "png"
): Promise<ProcessedLabel> {
  await ensureCacheDir();
  const cachePath = buildCachePath(shipmentId, shipmentType, outputFormat);

  // Check cache first
  try {
    const cached = await fs.promises.readFile(cachePath);
    logger.info({ shipmentId, shipmentType, outputFormat, cached: true }, "Label cache hit");
    return {
      originalUrl: labelUrl,
      optimizedPath: cachePath,
      optimizedBuffer: cached,
      width: PL60_WIDTH,
      height: PL60_HEIGHT,
      dpi: PL60_DPI,
      format: outputFormat,
    };
  } catch {
    // Cache miss, proceed with processing
  }

  logger.info({ shipmentId, shipmentType, outputFormat, labelUrl: labelUrl.substring(0, 50) + "..." }, "Processing label for PL-60");

  // Download the original label
  const response = await fetch(labelUrl, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Failed to download label: HTTP ${response.status}`);
  }

  const originalBuffer = Buffer.from(await response.arrayBuffer());

  // Process with sharp:
  // 1. Resize to 812x1218 (fit within, maintaining aspect ratio)
  // 2. Convert to 1-bit black/white (bypasses CUPS dithering that causes jagged lines)
  // 3. Ensure PNG format with correct DPI metadata
  const pngBuffer = await sharp(originalBuffer)
    .resize(PL60_WIDTH, PL60_HEIGHT, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255 }, // White background
      position: "centre",
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .grayscale() // Convert to grayscale first
    .threshold(128) // Then threshold to pure 1-bit black/white (50% cutoff)
    // Critical: set correct output density so OS print dialogs don't rescale
    .withMetadata({ density: PL60_DPI })
    .png({
      compressionLevel: 6,
      adaptiveFiltering: false, // Faster processing
    })
    .toBuffer();

  let optimizedBuffer: Buffer;
  if (outputFormat === "pdf") {
    // Generate print-ready PDF with exact 4x6 page size
    optimizedBuffer = await createPrintReadyPDF(pngBuffer);
  } else {
    optimizedBuffer = pngBuffer;
  }

  // Cache the result
  await fs.promises.writeFile(cachePath, optimizedBuffer);

  logger.info(
    { shipmentId, shipmentType, outputFormat, originalSize: originalBuffer.length, optimizedSize: optimizedBuffer.length },
    "Label optimized for PL-60"
  );

  return {
    originalUrl: labelUrl,
    optimizedPath: cachePath,
    optimizedBuffer,
    width: PL60_WIDTH,
    height: PL60_HEIGHT,
    dpi: PL60_DPI,
    format: outputFormat,
  };
}

/**
 * Create a print-ready PDF with exact 4x6 page size
 *
 * This solves the issue where Fedora's native image viewer ignores PNG DPI metadata,
 * causing incorrect scaling when printing. PDFs have explicit page dimensions.
 *
 * @param pngBuffer - Optimized PNG buffer to embed
 * @returns PDF buffer with 4x6 inch page containing the label
 */
async function createPrintReadyPDF(pngBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [PDF_WIDTH_PTS, PDF_HEIGHT_PTS], // 4x6 inches in points
      margin: 0,
      autoFirstPage: true,
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Embed PNG at exact page size (fills entire 4x6 area)
    doc.image(pngBuffer, 0, 0, {
      width: PDF_WIDTH_PTS,
      height: PDF_HEIGHT_PTS,
    });

    doc.end();
  });
}

/**
 * Clear cached label for a shipment (e.g., if label is repurchased)
 */
export async function clearCachedLabel(
  shipmentId: number,
  shipmentType: "marketplace" | "stripe" = "marketplace"
): Promise<void> {
  const cachePath = buildCachePath(shipmentId, shipmentType);
  try {
    await fs.promises.unlink(cachePath);
    logger.info({ shipmentId, shipmentType }, "Cleared cached label");
  } catch {
    // File didn't exist, that's fine
  }
}

/**
 * Get label dimensions info for debugging
 */
export async function getLabelInfo(labelUrl: string): Promise<{
  width: number;
  height: number;
  format: string;
  size: number;
}> {
  const response = await fetch(labelUrl, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Failed to download label: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(buffer).metadata();

  return {
    width: metadata.width || 0,
    height: metadata.height || 0,
    format: metadata.format || "unknown",
    size: buffer.length,
  };
}
