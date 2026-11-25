-- PO ETA: a rough arrival estimate for a PO that isn't booked yet, entered by hand so every
-- line on the Shipments table has an ETA. Separate from shipments.eta, which is the shipment's
-- own ETA once it is booked. Changes are logged in PO History like the ETD estimate.
ALTER TABLE purchase_orders ADD COLUMN eta TEXT;   -- 'YYYY-MM-DD'

-- One key per "New shipment" form, so a second click (or a retry) on "Create shipment"
-- returns the shipment already made instead of creating a duplicate.
ALTER TABLE shipments ADD COLUMN client_key TEXT;
CREATE UNIQUE INDEX idx_shipments_client_key ON shipments(client_key) WHERE client_key IS NOT NULL;
