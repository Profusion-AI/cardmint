import { describe, expect, it } from "vitest";
import {
  resolveTier,
  getTierPolicy,
  getFallbackChain,
  isModelAllowed,
  withinBudget,
} from "../../src/policy/deviceTier.js";

describe("deviceTier", () => {
  describe("resolveTier", () => {
    it("returns explicit tier when provided", () => {
      expect(resolveTier("tier0")).toBe("tier0");
      expect(resolveTier("tier1")).toBe("tier1");
      expect(resolveTier("tier2")).toBe("tier2");
    });

    it("auto-detects when override is null", () => {
      const tier = resolveTier(null);
      expect(["tier0", "tier1", "tier2"]).toContain(tier);
    });

    it("auto-detects when override is undefined", () => {
      const tier = resolveTier();
      expect(["tier0", "tier1", "tier2"]).toContain(tier);
    });

    it("auto-detects for invalid override", () => {
      const tier = resolveTier("invalid");
      expect(["tier0", "tier1", "tier2"]).toContain(tier);
    });
  });

  describe("getTierPolicy", () => {
    it("tier0 has no VLM models and no image search", () => {
      const policy = getTierPolicy("tier0");
      expect(policy.allowedModelClasses).toEqual([]);
      expect(policy.imageSearchEnabled).toBe(false);
      expect(policy.vectorSearchEnabled).toBe(false);
    });

    it("tier1 allows compact models", () => {
      const policy = getTierPolicy("tier1");
      expect(policy.allowedModelClasses).toContain("lfm-1.2b");
      expect(policy.allowedModelClasses).toContain("moondream-2");
      expect(policy.vectorSearchEnabled).toBe(true);
    });

    it("tier2 allows full model set including 3B class", () => {
      const policy = getTierPolicy("tier2");
      expect(policy.allowedModelClasses).toContain("qwen-2.5-vl-3b");
      expect(policy.imageSearchEnabled).toBe(true);
    });

    it("tier2 has stricter latency budget than tier1", () => {
      expect(getTierPolicy("tier2").latencyBudgetMs).toBeLessThan(
        getTierPolicy("tier1").latencyBudgetMs
      );
    });
  });

  describe("getFallbackChain", () => {
    it("tier2 falls back through tier1 to tier0", () => {
      expect(getFallbackChain("tier2")).toEqual(["tier2", "tier1", "tier0"]);
    });

    it("tier1 falls back to tier0", () => {
      expect(getFallbackChain("tier1")).toEqual(["tier1", "tier0"]);
    });

    it("tier0 has no fallback", () => {
      expect(getFallbackChain("tier0")).toEqual(["tier0"]);
    });
  });

  describe("isModelAllowed", () => {
    it("tier0 rejects all models", () => {
      expect(isModelAllowed("tier0", "lfm-1.2b")).toBe(false);
      expect(isModelAllowed("tier0", "qwen-2.5-vl-3b")).toBe(false);
    });

    it("tier1 allows compact but not large models", () => {
      expect(isModelAllowed("tier1", "lfm-1.2b")).toBe(true);
      expect(isModelAllowed("tier1", "qwen-2.5-vl-3b")).toBe(false);
    });

    it("tier2 allows all model classes", () => {
      expect(isModelAllowed("tier2", "lfm-1.2b")).toBe(true);
      expect(isModelAllowed("tier2", "qwen-2.5-vl-3b")).toBe(true);
    });
  });

  describe("withinBudget", () => {
    it("passes when under budget", () => {
      expect(withinBudget("tier0", 100)).toBe(true);
      expect(withinBudget("tier1", 2500)).toBe(true);
      expect(withinBudget("tier2", 1500)).toBe(true);
    });

    it("fails when over budget", () => {
      expect(withinBudget("tier0", 600)).toBe(false);
      expect(withinBudget("tier1", 3500)).toBe(false);
      expect(withinBudget("tier2", 2500)).toBe(false);
    });

    it("passes at exact budget boundary", () => {
      expect(withinBudget("tier0", 500)).toBe(true);
      expect(withinBudget("tier1", 3000)).toBe(true);
      expect(withinBudget("tier2", 2000)).toBe(true);
    });
  });
});
