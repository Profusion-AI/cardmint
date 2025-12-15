/// <reference types="vitest" />
/**
 * Shipping resolver test suite
 *
 * Validates the revised USPS-aligned policy (Oct 31, 2025):
 * - PWE (rigid non-machinable letter) @ $1.50 when weight ≤1 oz, ≤2 Card Savers, ≤3 cards.
 * - Tracked package (Ground Advantage) @ $4.95 default / store-credit minimum.
 * - Priority Mail @ $9.95 for quantity ≥20, subtotal ≥$45, or ≥$200 safeguard.
 */

import { describe, it, expect } from "vitest";
import { quoteShipping, validateCart } from "../shippingResolver";
import type { Cart } from "../../domain/shipping";
import {
  HIGH_VALUE_COPY,
  PWE_RIGID_COPY,
  STORE_CREDIT_COPY,
} from "../../domain/shipping";

const baseCart = (overrides: Partial<Cart> = {}): Cart => ({
  isUS: true,
  usesStoreCredit: false,
  quantity: 1,
  subtotal: 5,
  estimatedWeightOz: 0.5,
  cardSaverCount: 1,
  cardCount: 1,
  containsPWEIneligible: false,
  customerRequestsTracking: false,
  ...overrides,
});

describe("shippingResolver", () => {
  describe("quoteShipping - CEO test grid", () => {
    it("3 cards, $12 → $1.50 PWE (rigid letter)", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 3,
          cardCount: 3,
          cardSaverCount: 2,
          subtotal: 12,
          estimatedWeightOz: 0.9,
        }),
      );

      expect(quote.allowed).toBe(true);
      expect(quote.method).toBe("PWE");
      expect(quote.price).toBe(1.5);
      expect(quote.explanation).toBe(PWE_RIGID_COPY);
    });

    it("3 cards, $16 → $1.50 PWE (value no longer blocks rigid letter)", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 3,
          cardCount: 3,
          cardSaverCount: 2,
          subtotal: 16,
          estimatedWeightOz: 0.9,
        }),
      );

      expect(quote.allowed).toBe(true);
      expect(quote.method).toBe("PWE");
      expect(quote.price).toBe(1.5);
    });

    it("10 cards, $30 → $4.95 tracked (fails PWE limits)", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 10,
          cardCount: 10,
          cardSaverCount: 6,
          subtotal: 30,
          estimatedWeightOz: 2.8,
        }),
      );

      expect(quote.allowed).toBe(true);
      expect(quote.method).toBe("FIRST_CLASS");
      expect(quote.price).toBe(4.95);
    });

    it("10 cards, $60 → $9.95 Priority (subtotal trigger)", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 10,
          cardCount: 10,
          cardSaverCount: 6,
          subtotal: 60,
          estimatedWeightOz: 3.1,
        }),
      );

      expect(quote.allowed).toBe(true);
      expect(quote.method).toBe("PRIORITY");
      expect(quote.price).toBe(9.95);
    });

    it("25 cards, $40 → $9.95 Priority (quantity trigger)", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 25,
          cardCount: 25,
          cardSaverCount: 12,
          subtotal: 40,
          estimatedWeightOz: 5.5,
        }),
      );

      expect(quote.allowed).toBe(true);
      expect(quote.method).toBe("PRIORITY");
      expect(quote.price).toBe(9.95);
    });

    it("2 cards, $10 + store credit → $4.95 tracked", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 2,
          cardCount: 2,
          cardSaverCount: 1,
          subtotal: 10,
          estimatedWeightOz: 0.8,
          usesStoreCredit: true,
        }),
      );

      expect(quote.allowed).toBe(true);
      expect(quote.method).toBe("FIRST_CLASS");
      expect(quote.price).toBe(4.95);
      expect(quote.explanation).toBe(STORE_CREDIT_COPY);
    });

    it("1 graded card, $12 → $4.95 tracked (PWE ineligible)", () => {
      const quote = quoteShipping(
        baseCart({
          containsPWEIneligible: true,
          subtotal: 12,
          estimatedWeightOz: 0.7,
        }),
      );

      expect(quote.allowed).toBe(true);
      expect(quote.method).toBe("FIRST_CLASS");
      expect(quote.price).toBe(4.95);
    });

    it("4 cards, $220 → $9.95 Priority (high-value safeguard)", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 4,
          cardCount: 4,
          cardSaverCount: 2,
          subtotal: 220,
          estimatedWeightOz: 1,
        }),
      );

      expect(quote.allowed).toBe(true);
      expect(quote.method).toBe("PRIORITY");
      expect(quote.price).toBe(9.95);
      expect(quote.explanation).toBe(HIGH_VALUE_COPY);
    });
  });

  describe("quoteShipping - geography & eligibility", () => {
    it("blocks non-U.S. checkouts", () => {
      const quote = quoteShipping(
        baseCart({
          isUS: false,
        }),
      );

      expect(quote.allowed).toBe(false);
      expect(quote.reason).toBe("US-only");
      expect(quote.explanation).toContain("CardMint only ships to U.S. addresses");
    });

    it("allows PWE at 1 oz, 2 Card Savers, 3 cards", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 3,
          cardCount: 3,
          cardSaverCount: 2,
          estimatedWeightOz: 1,
        }),
      );

      expect(quote.method).toBe("PWE");
      expect(quote.price).toBe(1.5);
    });

    it("blocks PWE when weight exceeds 1 oz", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 3,
          cardCount: 3,
          cardSaverCount: 2,
          estimatedWeightOz: 1.05,
        }),
      );

      expect(quote.method).toBe("FIRST_CLASS");
      expect(quote.price).toBe(4.95);
    });

    it("blocks PWE when card saver count exceeds 2", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 3,
          cardCount: 3,
          cardSaverCount: 3,
        }),
      );

      expect(quote.method).toBe("FIRST_CLASS");
    });

    it("blocks PWE when card count exceeds 3", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 4,
          cardCount: 4,
          cardSaverCount: 2,
        }),
      );

      expect(quote.method).toBe("FIRST_CLASS");
    });
  });

  describe("quoteShipping - tracking requests", () => {
    it("upgrades PWE-eligible cart to tracked when customer requests tracking", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 3,
          cardCount: 3,
          cardSaverCount: 2,
          estimatedWeightOz: 0.9,
          customerRequestsTracking: true,
        }),
      );

      expect(quote.method).toBe("FIRST_CLASS");
      expect(quote.price).toBe(4.95);
      expect(quote.explanation).toContain("Tracking requested");
    });

    it("leaves Priority intact when customer requests tracking", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 20,
          cardCount: 20,
          cardSaverCount: 10,
          subtotal: 50,
          customerRequestsTracking: true,
        }),
      );

      expect(quote.method).toBe("PRIORITY");
      expect(quote.price).toBe(9.95);
    });
  });

  describe("quoteShipping - priority logic", () => {
    it("Priority applies at minimum quantity threshold (20 cards)", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 20,
          cardCount: 20,
          cardSaverCount: 10,
          subtotal: 30,
        }),
      );

      expect(quote.method).toBe("PRIORITY");
      expect(quote.price).toBe(9.95);
    });

    it("Priority applies at minimum subtotal threshold ($45)", () => {
      const quote = quoteShipping(
        baseCart({
          quantity: 10,
          cardCount: 10,
          cardSaverCount: 6,
          subtotal: 45,
        }),
      );

      expect(quote.method).toBe("PRIORITY");
    });

    it("Priority applies via high-value safeguard (≥$200)", () => {
      const quote = quoteShipping(
        baseCart({
          subtotal: 250,
        }),
      );

      expect(quote.method).toBe("PRIORITY");
      expect(quote.explanation).toBe(HIGH_VALUE_COPY);
    });
  });

  describe("quoteShipping - store credit + tracking interplay", () => {
    it("store credit overrides tracking request copy", () => {
      const quote = quoteShipping(
        baseCart({
          usesStoreCredit: true,
          customerRequestsTracking: true,
        }),
      );

      expect(quote.method).toBe("FIRST_CLASS");
      expect(quote.explanation).toBe(STORE_CREDIT_COPY);
    });
  });

  describe("validateCart", () => {
    it("throws when quantity negative", () => {
      expect(() =>
        validateCart(
          baseCart({
            quantity: -1,
          }),
        ),
      ).toThrow("Cart quantity must be non-negative");
    });

    it("throws when subtotal negative", () => {
      expect(() =>
        validateCart(
          baseCart({
            subtotal: -5,
          }),
        ),
      ).toThrow("Cart subtotal must be non-negative");
    });

    it("throws when weight negative", () => {
      expect(() =>
        validateCart(
          baseCart({
            estimatedWeightOz: -0.1,
          }),
        ),
      ).toThrow("Cart estimated weight must be non-negative");
    });

    it("throws when card saver count negative", () => {
      expect(() =>
        validateCart(
          baseCart({
            cardSaverCount: -1,
          }),
        ),
      ).toThrow("Card Saver count must be non-negative");
    });

    it("throws when card count negative", () => {
      expect(() =>
        validateCart(
          baseCart({
            cardCount: -1,
          }),
        ),
      ).toThrow("Card count must be non-negative");
    });
  });
});
