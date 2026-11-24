-- PO ETD: the logistics coordinator's rough departure estimate for a PO that isn't booked yet.
-- Entered by hand and used to chase vendors as the date gets close. Separate from shipments.etd,
-- which is the carrier's departure date once the PO is booked.
-- Changes are logged in PO History like the cargo ready date.

ALTER TABLE purchase_orders ADD COLUMN etd TEXT;   -- 'YYYY-MM-DD'
