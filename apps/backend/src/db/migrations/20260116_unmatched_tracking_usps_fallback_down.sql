-- Rollback: remove USPS tracking fallback fields
-- Note: SQLite doesn't support DROP COLUMN; recreate table

PRAGMA foreign_keys=OFF;

CREATE TABLE unmatched_tracking_backup AS SELECT
  id,
  import_batch_id,
  easypost_tracker_id,
  easypost_shipment_id,
  tracking_number,
  carrier,
  signed_by,
  signed_by_normalized,
  destination_zip,
  easypost_status,
  created_at_easypost,
  resolution_status,
  matched_to_shipment_id,
  resolved_by,
  resolved_at,
  created_at
FROM unmatched_tracking;

DROP TABLE unmatched_tracking;

CREATE TABLE unmatched_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER REFERENCES import_batches(id),
  easypost_tracker_id TEXT NOT NULL UNIQUE,
  easypost_shipment_id TEXT,
  tracking_number TEXT NOT NULL,
  carrier TEXT,
  signed_by TEXT,
  signed_by_normalized TEXT,
  destination_zip TEXT,
  easypost_status TEXT,
  created_at_easypost INTEGER,
  resolution_status TEXT NOT NULL DEFAULT 'pending' CHECK(resolution_status IN (
    'pending',
    'matched',
    'ignored',
    'manual_entry'
  )),
  matched_to_shipment_id INTEGER REFERENCES marketplace_shipments(id),
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

INSERT INTO unmatched_tracking SELECT * FROM unmatched_tracking_backup;
DROP TABLE unmatched_tracking_backup;

CREATE INDEX IF NOT EXISTS idx_unmatched_tracking_status ON unmatched_tracking(resolution_status);
CREATE INDEX IF NOT EXISTS idx_unmatched_tracking_signed_by ON unmatched_tracking(signed_by_normalized);
CREATE INDEX IF NOT EXISTS idx_unmatched_tracking_tracking_number ON unmatched_tracking(tracking_number);

PRAGMA foreign_keys=ON;
