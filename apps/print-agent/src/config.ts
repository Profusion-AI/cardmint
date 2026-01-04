export const agentConfig = {
  backendUrl: process.env.CARDMINT_BACKEND_URL?.trim() || "http://127.0.0.1:4000",
  token: requireEnv("PRINT_AGENT_TOKEN"),
  agentId: process.env.PRINT_AGENT_ID?.trim() || "fedora-agent-1",
  hostname: process.env.PRINT_AGENT_HOSTNAME?.trim() || undefined,
  version: process.env.PRINT_AGENT_VERSION?.trim() || "0.1.0",
  printerName: process.env.PRINTER_NAME?.trim() || "Polono_PL-60",
  archiveDir: process.env.LABEL_ARCHIVE_DIR?.trim() || "/var/lib/cardmint/labels",
  printerEnabled: boolFromEnv("LABEL_PRINTER_ENABLED", true),
  autoPrint: boolFromEnv("LABEL_AUTO_PRINT", false),
  pollIntervalMs: numFromEnv("POLL_INTERVAL_MS", 30000),
  requestTimeoutMs: numFromEnv("REQUEST_TIMEOUT_MS", 30000),
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`[print-agent] Missing required env var: ${name}`);
  }
  return value;
}

function boolFromEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "") return defaultValue;
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

function numFromEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}
