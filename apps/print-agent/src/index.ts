import { agentConfig } from "./config.js";
import { ensureArchiveDir, buildArchivePath, downloadLabelPdf } from "./downloadService.js";
import { postJson } from "./httpClient.js";
import { printPdf } from "./printService.js";

type ClaimDownloadResponse =
  | { ok: true; job: null }
  | { ok: true; job: { id: number; shipmentType: string; shipmentId: number; labelUrl: string } };

type ClaimPrintResponse =
  | { ok: true; job: null }
  | { ok: true; job: { id: number; shipmentType: string; shipmentId: number; localPath: string | null } };

async function sendHeartbeat(): Promise<void> {
  await postJson("/api/print-agent/heartbeat", {
    agentId: agentConfig.agentId,
    hostname: agentConfig.hostname,
    version: agentConfig.version,
    printerName: agentConfig.printerName,
    autoPrint: agentConfig.autoPrint,
  });
}

async function processOneDownload(): Promise<boolean> {
  const claim = await postJson<ClaimDownloadResponse>("/api/print-agent/print-queue/claim-download", {});
  if (!claim.job) return false;

  const destPath = buildArchivePath({
    queueId: claim.job.id,
    shipmentType: claim.job.shipmentType,
    shipmentId: claim.job.shipmentId,
  });

  try {
    await downloadLabelPdf(claim.job.labelUrl, destPath);
    await postJson(`/api/print-agent/print-queue/${claim.job.id}/download-complete`, {
      localPath: destPath,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await postJson(`/api/print-agent/print-queue/${claim.job.id}/fail`, {
      errorMessage: `DOWNLOAD_FAILED: ${msg}`,
    });
    return true; // job was consumed (failed state is visible)
  }
}

async function processOnePrint(): Promise<boolean> {
  if (!agentConfig.autoPrint) return false;

  const claim = await postJson<ClaimPrintResponse>("/api/print-agent/print-queue/claim-print", {});
  if (!claim.job) return false;

  if (!claim.job.localPath) {
    await postJson(`/api/print-agent/print-queue/${claim.job.id}/fail`, {
      errorMessage: "PRINT_FAILED: Missing localPath (not archived yet)",
    });
    return true;
  }

  try {
    const { printerJobId } = await printPdf(claim.job.localPath);
    await postJson(`/api/print-agent/print-queue/${claim.job.id}/print-complete`, { printerJobId });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await postJson(`/api/print-agent/print-queue/${claim.job.id}/fail`, {
      errorMessage: `PRINT_FAILED: ${msg}`,
    });
    return true;
  }
}

async function runLoop(): Promise<void> {
  await ensureArchiveDir();

  // Heartbeat immediately on boot
  await sendHeartbeat();

  // Main loop: download first (archival), then print if enabled.
  // Process multiple items per tick to drain backlog after downtime.
  for (;;) {
    try {
      await sendHeartbeat();

      // Download backlog (archive even when autoPrint=false)
      for (let i = 0; i < 10; i++) {
        const didWork = await processOneDownload();
        if (!didWork) break;
      }

      // Print backlog (autoPrint=true)
      for (let i = 0; i < 10; i++) {
        const didWork = await processOnePrint();
        if (!didWork) break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[print-agent] loop error:", msg);
    }

    await new Promise((r) => setTimeout(r, agentConfig.pollIntervalMs));
  }
}

runLoop().catch((err) => {
  console.error("[print-agent] fatal:", err);
  process.exit(1);
});

