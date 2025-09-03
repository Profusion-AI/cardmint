#Codex-CTO

import { Matcher, MatchResult } from "@/services/local-matching/types";

export interface LocalMatchingServiceOptions {
  minConfidence: number;
}

export class LocalMatchingService {
  private readonly matchers: Matcher[];
  private readonly minConfidence: number;

  constructor(matchers: Matcher[], opts?: Partial<LocalMatchingServiceOptions>) {
    this.matchers = matchers;
    const envMin = Number(process.env.LOCAL_MATCH_MIN_CONF ?? "0.85");
    this.minConfidence = opts?.minConfidence ?? (isFinite(envMin) ? envMin : 0.85);
  }

  async match(imagePath: string): Promise<MatchResult> {
    const timings: Record<string, number> = {};
    let best: MatchResult | null = null;
    for (const m of this.matchers) {
      const t0 = Date.now();
      const res = await m.match(imagePath);
      timings[m.name] = Date.now() - t0;
      if (!best || res.confidence > best.confidence) best = res;
      if (res.confidence >= this.minConfidence) {
        return { ...res, timings: { ...(res.timings ?? {}), ...timings } };
      }
    }
    return best
      ? { ...best, method: best.method, timings: { ...(best.timings ?? {}), ...timings } }
      : { method: "fusion", confidence: 0, candidates: [], timings };
  }
}

