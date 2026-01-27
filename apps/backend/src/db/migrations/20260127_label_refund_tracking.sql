-- Track when label was first viewed (Print → Reprint state)
ALTER TABLE marketplace_shipments ADD COLUMN label_viewed_at INTEGER;

-- EasyPost refund tracking
ALTER TABLE marketplace_shipments ADD COLUMN refund_status TEXT CHECK(
  refund_status IS NULL OR refund_status IN ('submitted', 'refunded', 'rejected')
);
ALTER TABLE marketplace_shipments ADD COLUMN refund_requested_at INTEGER;

CREATE INDEX idx_marketplace_shipments_refund_status ON marketplace_shipments(refund_status);
