-- PO History: a permanent, append-only record of everything that happens to a PO.
-- See docs/adr/0001-po-history-is-a-permanent-record.md and GLOSSARY.md.
--
-- Entries copy what they describe (values, note text, shipment label, container number)
-- instead of pointing at rows that can be deleted, so shipment_id has no foreign key.

CREATE TABLE po_history (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),  -- no cascade: POs are never deleted
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),  -- when the app learned of it (UTC)
  actor TEXT NOT NULL,              -- user email | 'system' | 'Carrier tracking'
  kind TEXT NOT NULL,               -- created | field_changed | linked | unlinked | note | eta_changed
                                    -- | container_added | container_removed | container_changed
                                    -- | shipment_status | tracking_started | tracking_failed
                                    -- | tracking_event | milestone | imported
  field TEXT,                       -- which field changed (field_changed, container_changed, eta_changed)
  old_value TEXT,
  new_value TEXT,
  occurred_at TEXT,                 -- real-world time (tracking entries)
  shipment_id INTEGER,              -- no FK: shipments can be deleted, history stays
  shipment_label TEXT,              -- MBL / reference snapshot, readable after the shipment is gone
  container_number TEXT,
  body TEXT,                        -- note text, event label, failure reason, imported snapshot (JSON)
  pre_history INTEGER NOT NULL DEFAULT 0,  -- 1 = backfilled from data that predates PO History
  dedupe_key TEXT UNIQUE            -- idempotency for tracking sync and the backfill
);
CREATE INDEX idx_po_history_po ON po_history(po_id, recorded_at);
CREATE INDEX idx_po_history_recorded ON po_history(recorded_at);

-- Append-only, enforced by the database (ADR 0001).
CREATE TRIGGER po_history_no_update BEFORE UPDATE ON po_history
BEGIN
  SELECT RAISE(ABORT, 'PO History is append-only');
END;
CREATE TRIGGER po_history_no_delete BEFORE DELETE ON po_history
BEGIN
  SELECT RAISE(ABORT, 'PO History is append-only');
END;

-- When the money actually moved (set together with payment_status).
ALTER TABLE purchase_orders ADD COLUMN deposit_paid_on TEXT;
ALTER TABLE purchase_orders ADD COLUMN paid_on TEXT;
