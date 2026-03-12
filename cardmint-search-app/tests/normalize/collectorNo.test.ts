import { describe, expect, it } from "vitest";
import { normalizeCollectorNo } from "../../src/normalize/collectorNo.js";

describe("normalizeCollectorNo", () => {
  it("strips /total suffix", () => {
    expect(normalizeCollectorNo("177/264")).toBe("177");
    expect(normalizeCollectorNo("4/102")).toBe("4");
  });

  it("strips leading zeros", () => {
    expect(normalizeCollectorNo("099/102")).toBe("99");
    expect(normalizeCollectorNo("007")).toBe("7");
    expect(normalizeCollectorNo("001")).toBe("1");
  });

  it("preserves zero", () => {
    expect(normalizeCollectorNo("0")).toBe("0");
    expect(normalizeCollectorNo("00")).toBe("0");
  });

  it("lowercases and strips leading zeros with alpha suffix", () => {
    expect(normalizeCollectorNo("TG05")).toBe("tg05");
    expect(normalizeCollectorNo("002a/131")).toBe("2a");
    expect(normalizeCollectorNo("SWSH123")).toBe("swsh123");
  });

  it("handles null and empty", () => {
    expect(normalizeCollectorNo(null)).toBeNull();
    expect(normalizeCollectorNo(undefined)).toBeNull();
    expect(normalizeCollectorNo("")).toBeNull();
  });

  it("handles whitespace", () => {
    expect(normalizeCollectorNo("  4/102  ")).toBe("4");
  });

  it("handles already-normalized values", () => {
    expect(normalizeCollectorNo("4")).toBe("4");
    expect(normalizeCollectorNo("177")).toBe("177");
    expect(normalizeCollectorNo("tg05")).toBe("tg05");
  });
});
