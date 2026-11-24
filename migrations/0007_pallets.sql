-- Pallets: a checkbox per container on the Shipments table (1 = ticked).
-- Changes are logged in the PO History of every PO on the container's shipment.

ALTER TABLE containers ADD COLUMN pallets INTEGER NOT NULL DEFAULT 0;
