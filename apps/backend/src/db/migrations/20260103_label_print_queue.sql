-- Phase 5: Label print queue (local Fedora print agent)
-- Purpose: Archive label PDFs immediately and optionally auto-print via local CUPS/USB printer.
--
-- Design notes (per docs/specs/fulfillment-phase4-5-label-workflow.md):
-- - Exactly one queue row per shipment (reprints do not create new rows).
-- - Repurchase/new-label updates the existing row (printing queue ≠ purchase history).
-- - Agent never calls EasyPost /buy; it only downloads/prints existing label URLs.

CREATE TABLE IF NOT EXISTS label_print_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL,
  shipment_type TEXT NOT NULL CHECK(shipment_type IN ('stripe', 'marketplace')),
  label_url TEXT NOT NULL,
  label_local_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending', 'downloading', 'ready', 'printing', 'printed', 'failed'
  )),
  review_status TEXT NOT NULL DEFAULT 'needs_review' CHECK(review_status IN (
    'needs_review', 'reviewed'
  )),
  print_count INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  error_message TEXT,
  printer_job_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  archived_at INTEGER,
  printed_at INTEGER
);

-- One queue row per shipment (reprints do not create new rows).
CREATE UNIQUE INDEX IF NOT EXISTS idx_label_print_queue_unique_shipment
  ON label_print_queue(shipment_type, shipment_id);

CREATE INDEX IF NOT EXISTS idx_label_print_queue_status
  ON label_print_queue(status);

CREATE INDEX IF NOT EXISTS idx_label_print_queue_review_status
  ON label_print_queue(review_status);

CREATE INDEX IF NOT EXISTS idx_label_print_queue_created_at
  ON label_print_queue(created_at);

