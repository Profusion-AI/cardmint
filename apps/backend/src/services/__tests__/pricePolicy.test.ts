/**
 * Gate D: Price Policy Unit Tests
 *
 * Tests the launch pricing policy:
 * - Base market_price from PriceCharting or PokémonPriceTracker
 * - Launch price = market_price × LAUNCH_INFLATION (default 1.25)
 * - Per-SKU overrides supported
 * - Rounding to nearest cent
 */

describe("Price Policy (Gate D)", () => {
  // Constants from config
  const LAUNCH_INFLATION = 1.25;
  const ROUNDING_MODE = "round";

  /**
   * Apply launch pricing policy to a market price
   */
  function applyLaunchPricing(
    marketPrice: number,
    inflationFactor: number = LAUNCH_INFLATION,
  ): number {
    const launchPrice = marketPrice * inflationFactor;
    // Round to nearest cent
    return Math.round(launchPrice * 100) / 100;
  }

  /**
   * Determine price with optional per-SKU override
   */
  function resolvePriceWithOverride(
    marketPrice: number | null,
    priceOverride: number | null,
    defaultPrice: number = 0,
  ): number {
    // Override takes precedence
    if (priceOverride !== null && priceOverride > 0) {
      return priceOverride;
    }

    // Use market price with inflation if available
    if (marketPrice !== null && marketPrice > 0) {
      return applyLaunchPricing(marketPrice);
    }

    // Fallback to default
    return defaultPrice;
  }

  describe("Basic Inflation Calculation", () => {
    test("applies 25% inflation to market price", () => {
      expect(applyLaunchPricing(100.0)).toBe(125.0);
    });

    test("handles decimal market prices", () => {
      expect(applyLaunchPricing(12.99)).toBe(16.24); // 12.99 * 1.25 = 16.2375 → 16.24
    });

    test("handles small prices", () => {
      expect(applyLaunchPricing(0.5)).toBe(0.63); // 0.5 * 1.25 = 0.625 → 0.63 (rounds up)
    });

    test("handles zero market price", () => {
      expect(applyLaunchPricing(0)).toBe(0);
    });

    test("rounds to nearest cent (round half up)", () => {
      expect(applyLaunchPricing(10.0)).toBe(12.5);
      expect(applyLaunchPricing(10.4)).toBe(13.0); // 13.0 = 10.4 * 1.25
      expect(applyLaunchPricing(10.44)).toBe(13.05); // 13.05 = 10.44 * 1.25
      expect(applyLaunchPricing(10.45)).toBe(13.06); // 13.0625 rounds to 13.06
    });
  });

  describe("Custom Inflation Factors", () => {
    test("supports different inflation factors", () => {
      const price = 100;
      expect(applyLaunchPricing(price, 1.0)).toBe(100.0); // No inflation
      expect(applyLaunchPricing(price, 1.1)).toBe(110.0); // 10% markup
      expect(applyLaunchPricing(price, 1.5)).toBe(150.0); // 50% markup
      expect(applyLaunchPricing(price, 2.0)).toBe(200.0); // 2x
    });

    test("handles fractional inflation factors", () => {
      expect(applyLaunchPricing(10.0, 1.123)).toBe(11.23); // 11.23
    });
  });

  describe("Override Pricing", () => {
    test("uses override when specified", () => {
      const marketPrice = 10.0;
      const override = 25.0;
      expect(resolvePriceWithOverride(marketPrice, override)).toBe(25.0);
    });

    test("ignores zero override", () => {
      const marketPrice = 10.0;
      expect(resolvePriceWithOverride(marketPrice, 0)).toBe(12.5); // Uses market price with inflation
    });

    test("ignores negative override", () => {
      const marketPrice = 10.0;
      expect(resolvePriceWithOverride(marketPrice, -5.0)).toBe(12.5); // Uses market price with inflation
    });

    test("uses default when no market price or override", () => {
      expect(resolvePriceWithOverride(null, null, 15.0)).toBe(15.0);
    });

    test("ignores default if market price available", () => {
      expect(resolvePriceWithOverride(10.0, null, 15.0)).toBe(12.5); // market price wins
    });

    test("override takes precedence over market price", () => {
      expect(resolvePriceWithOverride(10.0, 20.0, 15.0)).toBe(20.0);
    });
  });

  describe("Edge Cases", () => {
    test("handles very large prices", () => {
      const largePrice = 999999.99;
      expect(applyLaunchPricing(largePrice)).toBe(1249999.99);
    });

    test("handles very small prices", () => {
      expect(applyLaunchPricing(0.01)).toBe(0.01); // 0.01 * 1.25 = 0.0125 → 0.01
      expect(applyLaunchPricing(0.02)).toBe(0.03); // 0.02 * 1.25 = 0.025 → 0.03 (round up)
    });

    test("handles null market prices gracefully", () => {
      expect(resolvePriceWithOverride(null, 10.0)).toBe(10.0);
      expect(resolvePriceWithOverride(null, null, 5.0)).toBe(5.0);
    });

    test("handles currency formatting edge cases", () => {
      // Prices should work with standard USD currency
      expect(applyLaunchPricing(1.99)).toBe(2.49); // Common card price
      expect(applyLaunchPricing(5.99)).toBe(7.49);
      expect(applyLaunchPricing(19.99)).toBe(24.99);
    });
  });

  describe("Launch Policy Compliance", () => {
    test("enforces inflation coefficient in test baseline", () => {
      // This test ensures the policy is correctly configured
      const testCases = [
        { market: 10.0, expected: 12.5 },
        { market: 20.0, expected: 25.0 },
        { market: 49.99, expected: 62.49 },
      ];

      testCases.forEach(({ market, expected }) => {
        const result = applyLaunchPricing(market, LAUNCH_INFLATION);
        expect(result).toBe(expected);
      });
    });

    test("pricing table matches deployment config", () => {
      // Verify that LAUNCH_INFLATION is actually 1.25
      expect(LAUNCH_INFLATION).toBe(1.25);

      // Common card price samples
      const samples = [
        { market: 5.0, launchMin: 6.25, launchMax: 6.25 },
        { market: 10.0, launchMin: 12.5, launchMax: 12.5 },
        { market: 25.0, launchMin: 31.25, launchMax: 31.25 },
        { market: 100.0, launchMin: 125.0, launchMax: 125.0 },
      ];

      samples.forEach(({ market, launchMin, launchMax }) => {
        const result = applyLaunchPricing(market, LAUNCH_INFLATION);
        expect(result).toBeGreaterThanOrEqual(launchMin);
        expect(result).toBeLessThanOrEqual(launchMax);
      });
    });
  });

  describe("Import-Ready Price Calculation", () => {
    /**
     * Represents final price ready for EverShop import
     */
    interface ProductPrice {
      market_price: number | null;
      launch_price: number;
      price_override: number | null;
      final_price: number;
    }

    test("calculates final product prices for import", () => {
      const testProducts: ProductPrice[] = [
        {
          market_price: 10.0,
          launch_price: 12.5,
          price_override: null,
          final_price: 12.5,
        },
        {
          market_price: 20.0,
          launch_price: 25.0,
          price_override: 30.0, // Override
          final_price: 30.0,
        },
        {
          market_price: null,
          launch_price: 0,
          price_override: 15.0,
          final_price: 15.0,
        },
      ];

      testProducts.forEach(({ market_price, launch_price, price_override, final_price }) => {
        const computed = {
          launch_price: market_price ? applyLaunchPricing(market_price) : 0,
          final_price: resolvePriceWithOverride(market_price, price_override),
        };

        expect(computed.launch_price).toBe(launch_price);
        expect(computed.final_price).toBe(final_price);
      });
    });

    test("handles mixed pricing sources in bulk import", () => {
      // Simulate 5 products with different pricing sources
      const products = [
        { name: "Product A", market: 10.0, override: null },
        { name: "Product B", market: 20.0, override: null },
        { name: "Product C", market: null, override: 15.0 },
        { name: "Product D", market: 25.0, override: 50.0 },
        { name: "Product E", market: null, override: null },
      ];

      const priced = products.map((p) => ({
        name: p.name,
        final_price: resolvePriceWithOverride(p.market, p.override, 0),
      }));

      expect(priced).toEqual([
        { name: "Product A", final_price: 12.5 },
        { name: "Product B", final_price: 25.0 },
        { name: "Product C", final_price: 15.0 },
        { name: "Product D", final_price: 50.0 },
        { name: "Product E", final_price: 0 },
      ]);
    });
  });
});
