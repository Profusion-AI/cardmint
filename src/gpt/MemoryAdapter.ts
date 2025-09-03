import { createLogger } from '../utils/logger';
import { InMemoriaClient, PatternContext } from '../mcp/InMemoriaClient';

export interface MemoryAdapterOptions {
  enabled?: boolean;
}

export interface MemoryAdapter {
  ensureReady(): Promise<void>;
  fetchPatterns(ctx: PatternContext): Promise<any[]>;
  contributeInsights(insights: Record<string, any>): Promise<void>;
}

const log = createLogger('memory-adapter');

/**
 * InMemoria-backed memory adapter for GPT-OSS agent.
 * Safe to disable via env when memory is not desired.
 */
export class InMemoriaMemoryAdapter implements MemoryAdapter {
  private client: InMemoriaClient;
  private enabled: boolean;

  constructor(opts: MemoryAdapterOptions = {}) {
    this.enabled = Boolean(opts.enabled ?? (process.env.MEMORIA_ENABLED === 'true'));
    this.client = new InMemoriaClient({ enabled: this.enabled });
  }

  async ensureReady(): Promise<void> {
    if (!this.enabled) {
      log.info('Memory disabled');
      return;
    }
    await this.client.ensureReady();
  }

  async fetchPatterns(ctx: PatternContext): Promise<any[]> {
    if (!this.enabled) return [];
    const status = await this.client.getLearningStatus();
    if (!status?.ready) {
      await this.client.autoLearnIfNeeded();
    }
    const recs = await this.client.getPatternRecommendations(ctx);
    return recs || [];
  }

  async contributeInsights(insights: Record<string, any>): Promise<void> {
    if (!this.enabled) return;
    // Keep insights compact and safe; drop large payloads upstream
    await this.client.contributeInsights(insights);
  }
}

