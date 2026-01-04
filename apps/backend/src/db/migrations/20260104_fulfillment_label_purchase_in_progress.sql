-- Fulfillment label purchase concurrency lock (Stripe shipments)
-- Prevents double-spend on concurrent /label calls.
ALTER TABLE fulfillment ADD COLUMN label_purchase_in_progress INTEGER DEFAULT 0;

