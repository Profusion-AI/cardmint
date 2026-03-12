import { describe, expect, it } from "vitest";
import { assertReleasePolicy, evaluateReleasePolicy } from "../src/policy/releaseStage.js";

describe("release policy", () => {
  it("keeps internal stages non-external", () => {
    const evalResult = evaluateReleasePolicy({
      stage: "internal_dev",
      allowPublic: false,
      minConfidence: 0.85
    });

    expect(evalResult.externalTrafficAllowed).toBe(false);
    expect(evalResult.publicGateSatisfied).toBe(true);
  });

  it("blocks public beta unless allowPublic is true", () => {
    expect(() =>
      assertReleasePolicy({
        stage: "public_beta",
        allowPublic: false,
        minConfidence: 0.9
      })
    ).toThrow(/Public beta is blocked/);
  });

  it("accepts public beta when allowPublic is true", () => {
    expect(() =>
      assertReleasePolicy({
        stage: "public_beta",
        allowPublic: true,
        minConfidence: 0.9
      })
    ).not.toThrow();
  });
});
