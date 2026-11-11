-- Switch tracking provider from Terminal49 to TimeToCargo.
ALTER TABLE shipments RENAME COLUMN t49_tracking_request_id TO tracking_ids;   -- JSON array of TimeToCargo tracking ids
ALTER TABLE shipments RENAME COLUMN t49_shipment_id TO tracking_task_id;       -- pending batch task id
ALTER TABLE containers RENAME COLUMN t49_container_id TO first_synced_at;      -- set on first successful sync
UPDATE shipments SET tracking_ids = NULL, tracking_task_id = NULL, tracking_status = NULL, tracking_error = NULL;
UPDATE containers SET first_synced_at = NULL;
-- TimeToCargo uses YMLU for Yang Ming
UPDATE shipments SET carrier_scac = 'YMLU' WHERE carrier_scac = 'YMJA';

-- Webhook deliveries we've already processed (idempotency)
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload TEXT
);
