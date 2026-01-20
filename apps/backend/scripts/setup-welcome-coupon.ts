#!/usr/bin/env npx tsx
/**
 * Setup Welcome Coupon Script (Jan 2026)
 *
 * Idempotent script to create or retrieve the master welcome coupon in Stripe.
 * The master coupon is a 10% off coupon that promotion codes are linked to.
 *
 * Usage:
 *   npx tsx apps/backend/scripts/setup-welcome-coupon.ts
 *
 * Output:
 *   - Creates "CardMint Welcome 10% Off" coupon if not exists
 *   - Prints STRIPE_WELCOME_COUPON_ID for .env configuration
 */

import Stripe from "stripe";
import { runtimeConfig } from "../src/config.js";

const COUPON_NAME = "CardMint Welcome 10% Off";
const DISCOUNT_PERCENT = 10;

async function main() {
  // Check Stripe configuration
  if (!runtimeConfig.stripeSecretKey) {
    console.error("Error: STRIPE_SECRET_KEY not configured");
    console.error("Set STRIPE_SECRET_KEY in your .env file");
    process.exit(1);
  }

  const stripe = new Stripe(runtimeConfig.stripeSecretKey);

  console.log("\n=== CardMint Welcome Coupon Setup ===\n");

  // Check for existing configured coupon
  if (runtimeConfig.stripeWelcomeCouponId) {
    console.log(`Checking existing configured coupon: ${runtimeConfig.stripeWelcomeCouponId}`);
    try {
      const existingCoupon = await stripe.coupons.retrieve(runtimeConfig.stripeWelcomeCouponId);
      console.log(`\nCoupon found and active:`);
      console.log(`  Name: ${existingCoupon.name}`);
      console.log(`  Discount: ${existingCoupon.percent_off}% off`);
      console.log(`  Valid: ${existingCoupon.valid}`);
      console.log(`\nSTRIPE_WELCOME_COUPON_ID=${existingCoupon.id}`);
      console.log("\nNo action needed - coupon already configured.\n");
      return;
    } catch (err) {
      const stripeErr = err as Stripe.errors.StripeError;
      if (stripeErr.code === "resource_missing") {
        console.log(`Configured coupon not found in Stripe. Will search or create.\n`);
      } else {
        throw err;
      }
    }
  }

  // Search for existing coupon by name
  console.log(`Searching for existing "${COUPON_NAME}" coupon...`);
  const coupons = await stripe.coupons.list({ limit: 100 });
  const existingCoupon = coupons.data.find(
    (c) => c.name === COUPON_NAME && c.valid && c.percent_off === DISCOUNT_PERCENT
  );

  if (existingCoupon) {
    console.log(`\nFound existing coupon: ${existingCoupon.id}`);
    console.log(`  Name: ${existingCoupon.name}`);
    console.log(`  Discount: ${existingCoupon.percent_off}% off`);
    console.log(`  Valid: ${existingCoupon.valid}`);
    console.log(`\n--- Add this to your .env file ---\n`);
    console.log(`STRIPE_WELCOME_COUPON_ID=${existingCoupon.id}`);
    console.log(`\n----------------------------------\n`);
    return;
  }

  // Create new coupon
  console.log(`No existing coupon found. Creating new coupon...`);

  const newCoupon = await stripe.coupons.create({
    name: COUPON_NAME,
    percent_off: DISCOUNT_PERCENT,
    duration: "once",
    metadata: {
      purpose: "welcome_discount",
      source: "cardmint_subscribe_flow",
      created_by: "setup-welcome-coupon.ts",
      created_at: new Date().toISOString(),
    },
  });

  console.log(`\nCoupon created successfully!`);
  console.log(`  ID: ${newCoupon.id}`);
  console.log(`  Name: ${newCoupon.name}`);
  console.log(`  Discount: ${newCoupon.percent_off}% off`);
  console.log(`  Duration: ${newCoupon.duration}`);
  console.log(`\n--- Add this to your .env file ---\n`);
  console.log(`STRIPE_WELCOME_COUPON_ID=${newCoupon.id}`);
  console.log(`\n----------------------------------\n`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
