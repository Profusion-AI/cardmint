import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { agentConfig } from "./config.js";

export async function ensureArchiveDir(): Promise<void> {
  await fs.promises.mkdir(agentConfig.archiveDir, { recursive: true });
}

export function buildArchivePath(params: { queueId: number; shipmentType: string; shipmentId: number }): string {
  const fileName = `label_${params.queueId}_${params.shipmentType}_${params.shipmentId}.pdf`;
  return path.join(agentConfig.archiveDir, fileName);
}

export async function downloadLabelPdf(labelUrl: string, destPath: string): Promise<void> {
  const response = await fetch(labelUrl, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Download failed: missing response body");
  }

  // Write to temp then move into place (avoid partial files on crash)
  const tmpPath = `${destPath}.tmp`;
  const fileStream = fs.createWriteStream(tmpPath);
  const nodeStream = Readable.fromWeb(response.body as any);
  await pipeline(nodeStream, fileStream);
  await fs.promises.rename(tmpPath, destPath);
}
