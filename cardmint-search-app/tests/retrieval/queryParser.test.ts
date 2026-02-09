import { describe, expect, it } from "vitest";
import { parseQuery } from "../../src/retrieval/queryParser.js";

describe("parseQuery", () => {
  it("parses full query: card name + set + collector number", () => {
    const result = parseQuery("charizard base set 4");
    expect(result.cardName).toBe("charizard");
    expect(result.setName?.toLowerCase()).toBe("base set");
    expect(result.collectorNo).toBe("4");
  });

  it("parses collector number with slash notation", () => {
    const result = parseQuery("charizard 4/102 base set");
    expect(result.collectorNo).toBe("4");
    expect(result.setName?.toLowerCase()).toBe("base set");
    expect(result.cardName).toBe("charizard");
  });

  it("parses card name only", () => {
    const result = parseQuery("pikachu");
    expect(result.cardName).toBe("pikachu");
    expect(result.setName).toBeNull();
    expect(result.collectorNo).toBeNull();
  });

  it("parses set name only", () => {
    const result = parseQuery("evolutions");
    expect(result.setName?.toLowerCase()).toBe("evolutions");
  });

  it("handles leading zeros in collector number", () => {
    const result = parseQuery("charizard 004/102");
    expect(result.collectorNo).toBe("4");
  });

  it("handles alpha suffix in collector number", () => {
    const result = parseQuery("pikachu 002a/131");
    expect(result.collectorNo).toBe("2a");
  });

  it("preserves raw query", () => {
    const result = parseQuery("  charizard base set 4  ");
    expect(result.raw).toBe("  charizard base set 4  ");
  });

  it("handles multi-word set names", () => {
    const result = parseQuery("pikachu scarlet & violet");
    expect(result.setName?.toLowerCase()).toBe("scarlet & violet");
    expect(result.cardName).toBe("pikachu");
  });

  it("handles letter-prefixed collector number TG05", () => {
    const result = parseQuery("pikachu TG05 brilliant stars");
    expect(result.collectorNo).toBe("tg05");
    expect(result.setName?.toLowerCase()).toBe("brilliant stars");
    expect(result.cardName).toBe("pikachu");
  });

  it("handles letter-prefixed collector number SWSH123", () => {
    const result = parseQuery("pikachu SWSH123");
    expect(result.collectorNo).toBe("swsh123");
    expect(result.cardName).toBe("pikachu");
  });

  it("handles letter-prefixed collector number GG01", () => {
    const result = parseQuery("charizard GG01 crown zenith");
    expect(result.collectorNo).toBe("gg01");
    expect(result.setName?.toLowerCase()).toBe("crown zenith");
    expect(result.cardName).toBe("charizard");
  });

  it("extracts shadowless variant qualifier", () => {
    const result = parseQuery("charizard shadowless base set 4");
    expect(result.variantHint).toBe("shadowless");
    expect(result.setName?.toLowerCase()).toBe("base set");
    expect(result.collectorNo).toBe("4");
    expect(result.cardName).toBe("charizard");
  });

  it("extracts 1st edition variant qualifier", () => {
    const result = parseQuery("pikachu 1st edition jungle 60");
    expect(result.variantHint).toBe("1st edition");
    expect(result.setName?.toLowerCase()).toBe("jungle");
    expect(result.collectorNo).toBe("60");
  });

  it("extracts reverse holo variant qualifier", () => {
    const result = parseQuery("charizard reverse holo evolutions 11");
    expect(result.variantHint).toBe("reverse holo");
    expect(result.setName?.toLowerCase()).toBe("evolutions");
  });

  it("returns null variantHint when no qualifier present", () => {
    const result = parseQuery("charizard base set 4");
    expect(result.variantHint).toBeNull();
  });

  it("does not match 'holo' inside 'holon phantoms'", () => {
    const result = parseQuery("latias holon phantoms 10");
    expect(result.variantHint).toBeNull();
    expect(result.setName?.toLowerCase()).toBe("holon phantoms");
    expect(result.collectorNo).toBe("10");
    expect(result.cardName).toBe("latias");
  });

  it("does not match 'holo' inside 'holon'", () => {
    const result = parseQuery("deoxys holon phantoms 4");
    expect(result.variantHint).toBeNull();
    expect(result.setName?.toLowerCase()).toBe("holon phantoms");
  });

  it("still matches standalone 'holo' adjacent to other words", () => {
    const result = parseQuery("charizard holo base set 4");
    expect(result.variantHint).toBe("holo");
    expect(result.setName?.toLowerCase()).toBe("base set");
    expect(result.cardName).toBe("charizard");
  });
});
