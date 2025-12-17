/// <reference types="vitest" />
/**
 * Shipping resolver test suite
 *
 * Validates the tracked-only shipping policy (Dec 2025):
 * - TRACKED (USPS Ground Advantage): $4.95 default
 * - PRIORITY (USPS Priority Mail): $9.95 for qty ≥20 or subtotal ≥$45
 *
 * All shipments include tracking. No untracked option.
 */

import { describe, it, expect } from "vitest";
import { quoteShipping, validateCart } from "../shippingResolver";
import type { Cart } from "../../domain/shipping";
import {
  PRIORITY_THRESHOLD_COPY,
  SHIPPING_STEP_COPY,
} from "../../domain/shipping";

const baseCart = (overrides: Partial<Cart> = {}): Cart => ({
  isUS: true,
  quantity: 1,
  subtotal: 5,
  ...overrides,
});

describe("shippingResolver", () => {
  describe("quoteShipping - basic tracked shipping", () => {
    it("single card, low value → $4.95 TRACKED", () => {
      const quote = quoteShipping(baseCart({ quantity: 1, subtotal: 5 }));

      expect(quote.allowed).toBe(true);
      expect(quote.method).toBe("TRACKED");
      expect(quote.price).toBe(4.95);
      expect(quote.priceCents).toBe(495);
    });

    it("3 cards, $12 → $4.95 TRACKED", () => {
      const quote = quoteShipping(baseCart({ quantity: 3, subtotal: 12 }));

      expect(quote.allowed).toBe(true);
      expect(quote.method).toBe("TRACKED");
      expect(quote.price).toBe(4.95);
    });

    it("10 cards, $30 → $4.95 TRACKED (under thresholds)", () => {
      const quote = quoteShipping(baseCart({ quantity: 10, subtotal: 30 }));

      expect(quote.allowed).toBe(true);
      expect(quote.method).toBe("TRACKED");
      expect(quote.price).toBe(4.95);
    });

    it("includes SHIPPING_STEP_COPY as default explanation", () => {
      const quote = quoteShipping(baseCart());
      expect(quote.explanation).toBe(SHIPPING_STEP_COPY);
    });
  });

  describe("quoteShipping - priority triggers", () => {
    it("10 cards, $60 → $9.95 PRIORITY (subtotal trigger)", () => {
      const quote = quoteShipping(baseCart({ quantity: 10, subtotal: 60 }));

      expect(quote.allowed).toBe(true);
      expect(quote.method).toBe("PRIORITY");
      expect(quote.price).toBe(9.95);
      expect(quote.priceCents).toBe(995);
    });

    it("25 cards, $40 → $9.95 PRIORITY (quantity trigger)", () => {
      const quote = quoteShipping(baseCart({ quantity: 25, subtotal: 40 }));

      expect(quote.allowed).toBe(true);
      expect(quote.method).toBe("PRIORITY");
      expect(quote.price).toBe(9.95);
    });

    it("Priority applies at minimum quantity threshold (20 cards)", () => {
      const quote = quoteShipping(baseCart({ quantity: 20, subtotal: 30 }));

      expect(quote.method).toBe("PRIORITY");
      expect(quote.price).toBe(9.95);
      expect(quote.explanation).toBe(PRIORITY_THRESHOLD_COPY);
    });

    it("Priority applies at minimum subtotal threshold ($45)", () => {
      const quote = quoteShipping(baseCart({ quantity: 10, subtotal: 45 }));

      expect(quote.method).toBe("PRIORITY");
    });

    it("TRACKED when just under subtotal threshold ($44.99)", () => {
      const quote = quoteShipping(baseCart({ quantity: 10, subtotal: 44.99 }));

      expect(quote.method).toBe("TRACKED");
    });

    it("TRACKED when just under quantity threshold (19 cards)", () => {
      const quote = quoteShipping(baseCart({ quantity: 19, subtotal: 30 }));

      expect(quote.method).toBe("TRACKED");
    });
  });

  describe("quoteShipping - geography", () => {
    it("blocks non-U.S. checkouts", () => {
      const quote = quoteShipping(baseCart({ isUS: false }));

      expect(quote.allowed).toBe(false);
      expect(quote.reason).toBe("US-only");
      expect(quote.explanation).toContain("CardMint only ships to U.S. addresses");
    });

    it("allows U.S. checkouts", () => {
      const quote = quoteShipping(baseCart({ isUS: true }));

      expect(quote.allowed).toBe(true);
    });
  });

  describe("quoteShipping - manual review flag", () => {
    it("flags orders over $100 for manual review", () => {
      const quote = quoteShipping(baseCart({ quantity: 2, subtotal: 125 }));

      expect(quote.requiresManualReview).toBe(true);
    });

    it("does not flag orders at exactly $100", () => {
      const quote = quoteShipping(baseCart({ quantity: 2, subtotal: 100 }));

      expect(quote.requiresManualReview).toBe(false);
    });

    it("does not flag orders under $100", () => {
      const quote = quoteShipping(baseCart({ quantity: 2, subtotal: 99.99 }));

      expect(quote.requiresManualReview).toBe(false);
    });

    it("manual review flag is non-blocking (checkout still allowed)", () => {
      const quote = quoteShipping(baseCart({ quantity: 2, subtotal: 500 }));

      expect(quote.allowed).toBe(true);
      expect(quote.requiresManualReview).toBe(true);
      expect(quote.method).toBe("PRIORITY");
    });
  });

  describe("quoteShipping - priceCents output", () => {
    it("returns correct priceCents for TRACKED", () => {
      const quote = quoteShipping(baseCart());
      expect(quote.priceCents).toBe(495);
    });

    it("returns correct priceCents for PRIORITY", () => {
      const quote = quoteShipping(baseCart({ subtotal: 50 }));
      expect(quote.priceCents).toBe(995);
    });
  });

  describe("validateCart", () => {
    it("throws when quantity negative", () => {
      expect(() => validateCart(baseCart({ quantity: -1 }))).toThrow(
        "Cart quantity must be non-negative"
      );
    });

    it("throws when subtotal negative", () => {
      expect(() => validateCart(baseCart({ subtotal: -5 }))).toThrow(
        "Cart subtotal must be non-negative"
      );
    });

    it("passes validation for valid cart", () => {
      expect(() => validateCart(baseCart())).not.toThrow();
    });

    it("passes validation with zero quantity", () => {
      expect(() => validateCart(baseCart({ quantity: 0 }))).not.toThrow();
    });

    it("passes validation with zero subtotal", () => {
      expect(() => validateCart(baseCart({ subtotal: 0 }))).not.toThrow();
    });
  });
});
