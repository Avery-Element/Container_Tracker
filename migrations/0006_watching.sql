-- Watching: a shared tag that pins a container or PO line to the top of the Shipments table
-- and lists it on the Dashboard. Set = watched; both NULL = not watched.
-- A container line also counts as watched when any PO on its shipment is watched, so the
-- watch follows a PO onto its containers once it's booked.
-- Not logged in PO History: it is a view setting, not something that happened to the PO.

ALTER TABLE containers ADD COLUMN watched_by TEXT;       -- who ticked it (user email)
ALTER TABLE containers ADD COLUMN watched_at TEXT;       -- when (ISO, UTC)
ALTER TABLE purchase_orders ADD COLUMN watched_by TEXT;
ALTER TABLE purchase_orders ADD COLUMN watched_at TEXT;
