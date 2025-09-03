#Codex-CTO

import { Matcher, MatchResult } from "@/services/local-matching/types";

export class TextPatternMatcher implements Matcher {
  readonly name = "text" as const;

  async match(imagePath: string): Promise<MatchResult> {
    if (!imagePath) {
      return { method: this.name, confidence: 0, candidates: [] };
    }
    return { method: this.name, confidence: 0, candidates: [] };
  }
}

