#!/usr/bin/env npx ts-node
/**
 * Gate D: Price Policy Validation
 * Validates the launch pricing policy (+25% inflation)
 */

const LAUNCH_INFLATION = 1.25;

/**
 * Apply launch pricing policy
 */
function applyLaunchPricing(
  marketPrice: number,
  inflationFactor: number = LAUNCH_INFLATION,
): number {
  const launchPrice = marketPrice * inflationFactor;
  return Math.round(launchPrice * 100) / 100;
}

/**
 * Resolve price with override
 */
function resolvePriceWithOverride(
  marketPrice: number | null,
  priceOverride: number | null,
  defaultPrice: number = 0,
): number {
  if (priceOverride !== null && priceOverride > 0) {
    return priceOverride;
  }

  if (marketPrice !== null && marketPrice > 0) {
    return applyLaunchPricing(marketPrice);
  }

  return defaultPrice;
}

// Simple test harness
interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
      }
    },
    toBeGreaterThanOrEqual: (expected: any) => {
      if (actual < expected) {
        throw new Error(`Expected >= ${expected}, got ${actual}`);
      }
    },
    toBeLessThanOrEqual: (expected: any) => {
      if (actual > expected) {
        throw new Error(`Expected <= ${expected}, got ${actual}`);
      }
    },
  };
}

// Run tests
console.log("Gate D: Price Policy Unit Tests\n");

test("Basic inflation: $10.00 market → $12.50 launch", () => {
  expect(applyLaunchPricing(10.0)).toBe(12.5);
});

test("Handles decimal prices: $12.99 market → $16.24 launch", () => {
  expect(applyLaunchPricing(12.99)).toBe(16.24);
});

test("Small price handling: $0.50 market → $0.63 launch", () => {
  expect(applyLaunchPricing(0.5)).toBe(0.63);
});

test("Override takes precedence over market price", () => {
  expect(resolvePriceWithOverride(10.0, 20.0, 5.0)).toBe(20.0);
});

test("Market price applies when no override", () => {
  expect(resolvePriceWithOverride(10.0, null, 5.0)).toBe(12.5);
});

test("Default used when no market price or override", () => {
  expect(resolvePriceWithOverride(null, null, 15.0)).toBe(15.0);
});

test("Bulk pricing: 3-product mix", () => {
  const products = [
    { market: 10.0, override: null, expected: 12.5 },
    { market: 20.0, override: null, expected: 25.0 },
    { market: null, override: 15.0, expected: 15.0 },
  ];

  products.forEach(({ market, override, expected }) => {
    const result = resolvePriceWithOverride(market, override);
    expect(result).toBe(expected);
  });
});

test("Common card prices", () => {
  const samples = [
    { market: 5.0, expected: 6.25 },
    { market: 10.0, expected: 12.5 },
    { market: 25.0, expected: 31.25 },
    { market: 100.0, expected: 125.0 },
  ];

  samples.forEach(({ market, expected }) => {
    const result = applyLaunchPricing(market, LAUNCH_INFLATION);
    expect(result).toBe(expected);
  });
});

test("Inflation coefficient verification", () => {
  expect(LAUNCH_INFLATION).toBe(1.25);
});

// Print results
console.log("Test Results:");
console.log("=".repeat(60));

let passed = 0;
let failed = 0;

results.forEach((result) => {
  const status = result.passed ? "✓ PASS" : "✗ FAIL";
  console.log(`${status}: ${result.name}`);
  if (result.error) {
    console.log(`       ${result.error}`);
  }
  if (result.passed) passed++;
  else failed++;
});

console.log("=".repeat(60));
console.log(`\nTotal: ${passed} passed, ${failed} failed\n`);

// Summary
if (failed === 0) {
  console.log("✓ GATE D PASS: All price policy tests passed");
  process.exit(0);
} else {
  console.log("✗ GATE D FAIL: Some tests failed");
  process.exit(1);
}
