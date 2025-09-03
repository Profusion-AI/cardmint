#Codex-CTO

import { LocalMatchingService } from "@/services/local-matching/local-matching-service";
import { PerceptualHashMatcher } from "@/services/local-matching/matchers/perceptual-hash";
import { TextPatternMatcher } from "@/services/local-matching/matchers/text-pattern";
import { SetIconMatcher } from "@/services/local-matching/matchers/set-icon";
import { NumberValidator } from "@/services/local-matching/matchers/number-validator";

export interface LocalFirstDecision {
  approved: boolean;
  confidence: number;
  method: string;
}

export async function localFirstVerify(imagePath: string): Promise<LocalFirstDecision> {
  const mode = (process.env.LOCAL_MODE ?? "hybrid").toLowerCase();
  const min = Number(process.env.LOCAL_MATCH_MIN_CONF ?? "0.85");
  const service = new LocalMatchingService([
    new PerceptualHashMatcher(),
    new TextPatternMatcher(),
    new SetIconMatcher(),
    new NumberValidator(),
  ], { minConfidence: isFinite(min) ? min : 0.85 });

  const res = await service.match(imagePath);
  const approved = mode === "local-only" ? res.confidence >= (isFinite(min) ? min : 0.85) : res.confidence >= (isFinite(min) ? min : 0.85);
  return { approved, confidence: res.confidence, method: res.method };
}

