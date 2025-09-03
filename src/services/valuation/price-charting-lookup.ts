#Codex-CTO

export type PriceRecord = {
  id: string;
  productName: string;
  set?: string;
  number?: string;
  loose?: number;
  cib?: number;
  newer?: number;
  graded?: number;
  releaseDate?: string;
};

export interface PriceLookup {
  load(): Promise<void>;
  lookup(key: { set?: string; number?: string; name?: string }): PriceRecord | undefined;
}

export class PriceChartingLookupService implements PriceLookup {
  private ready = false;
  private readonly map = new Map<string, PriceRecord>();

  async load(): Promise<void> {
    // Placeholder: Claude will implement CSV parsing and normalization.
    this.ready = true;
  }

  lookup(key: { set?: string; number?: string; name?: string }): PriceRecord | undefined {
    const parts = [key.set ?? "", key.number ?? "", (key.name ?? "").toLowerCase()];
    const composite = parts.join("::");
    return this.map.get(composite);
  }
}

