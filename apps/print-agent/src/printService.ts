import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import { agentConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export async function printPdf(pdfPath: string): Promise<{ printerJobId: string | null }> {
  if (!agentConfig.printerEnabled) {
    throw new Error("Printer disabled (LABEL_PRINTER_ENABLED=false)");
  }

  await fs.promises.access(pdfPath, fs.constants.R_OK);

  // CUPS print: use execFile with args array (no shell interpolation)
  const args = ["-d", agentConfig.printerName, "-o", "fit-to-page", pdfPath];
  const { stdout } = await execFileAsync("lp", args, { timeout: agentConfig.requestTimeoutMs });

  // Example stdout: "request id is Polono_PL-60-123 (1 file(s))"
  const match = stdout?.match(/request id is\\s+([^\\s]+)\\s+/i);
  return { printerJobId: match ? match[1] : null };
}
