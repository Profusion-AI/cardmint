export type ReleaseStage =
  | "internal_dev"
  | "internal_ga"
  | "trusted_alpha"
  | "public_beta";

export interface ReleasePolicyInput {
  stage: ReleaseStage;
  allowPublic: boolean;
  minConfidence: number;
}

export interface ReleasePolicyEvaluation {
  externalTrafficAllowed: boolean;
  publicGateSatisfied: boolean;
}

export function evaluateReleasePolicy(input: ReleasePolicyInput): ReleasePolicyEvaluation {
  const externalTrafficAllowed = input.stage === "trusted_alpha" || input.stage === "public_beta";
  const publicGateSatisfied = input.stage !== "public_beta" || input.allowPublic;
  return {
    externalTrafficAllowed,
    publicGateSatisfied
  };
}

export function assertReleasePolicy(input: ReleasePolicyInput): void {
  if (input.minConfidence <= 0 || input.minConfidence > 1) {
    throw new Error("SEARCH_APP_MIN_CONFIDENCE must be > 0 and <= 1");
  }

  const evaluation = evaluateReleasePolicy(input);
  if (!evaluation.publicGateSatisfied) {
    throw new Error(
      "Public beta is blocked: set SEARCH_APP_ALLOW_PUBLIC=true only after quality gates are green"
    );
  }
}
