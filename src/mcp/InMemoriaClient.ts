import { createLogger } from '../utils/logger';

export interface InMemoriaOptions {
  enabled?: boolean;
  endpoint?: string; // e.g., MCP server transport if applicable
  projectRoot?: string;
  requestTimeoutMs?: number;
}

export interface PatternContext {
  task?: string;
  filePath?: string;
  language?: string;
  hints?: Record<string, any>;
}

const log = createLogger('in-memoria-client');

/**
 * Thin adapter for the In Memoria MCP server.
 *
 * Notes:
 * - This scaffolding intentionally avoids binding to a specific MCP transport.
 * - Methods are safe no-ops when disabled to keep the runtime hot path unaffected.
 */
export class InMemoriaClient {
  private enabled: boolean;
  private endpoint?: string;
  private projectRoot: string;
  private timeoutMs: number;

  constructor(opts: InMemoriaOptions = {}) {
    this.enabled = Boolean(opts.enabled ?? (process.env.MEMORIA_ENABLED === 'true'));
    this.endpoint = opts.endpoint || process.env.MEMORIA_ENDPOINT;
    this.projectRoot = opts.projectRoot || process.cwd();
    this.timeoutMs = opts.requestTimeoutMs ?? 2000;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Lightweight readiness check. In scaffolding mode, returns enabled flag.
   */
  async ping(): Promise<boolean> {
    if (!this.enabled) return false;
    // A real implementation would probe the MCP transport here.
    log.debug('In Memoria ping (scaffold): assuming available');
    return true;
  }

  /**
   * Ensure memory is ready for the project. Safe to call on startup.
   */
  async ensureReady(): Promise<void> {
    if (!this.enabled) return;
    const ok = await this.ping();
    if (!ok) {
      log.warn('In Memoria not reachable; proceeding without memory');
    } else {
      log.info('In Memoria ready');
    }
  }

  /**
   * Get learning status for the current project (scaffolded shape).
   */
  async getLearningStatus(): Promise<{ ready: boolean; projectRoot: string } | null> {
    if (!this.enabled) return null;
    return { ready: true, projectRoot: this.projectRoot };
  }

  /**
   * Optionally trigger learning if nothing is present.
   * In scaffolding, this is a no-op with logging.
   */
  async autoLearnIfNeeded(): Promise<void> {
    if (!this.enabled) return;
    log.debug('autoLearnIfNeeded (scaffold): skipping heavy work');
  }

  /**
   * Fetch pattern recommendations given a context.
   */
  async getPatternRecommendations(_ctx: PatternContext): Promise<any[] | null> {
    if (!this.enabled) return null;
    // Return an empty set to keep call sites simple.
    return [];
  }

  /**
   * Persist compact insights back to memory.
   */
  async contributeInsights(_insights: Record<string, any>): Promise<void> {
    if (!this.enabled) return;
    log.debug('contributeInsights (scaffold): accepted');
  }
}

