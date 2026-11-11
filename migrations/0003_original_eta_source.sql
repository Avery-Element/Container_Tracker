-- Where the "ETA (first published)" value came from: 'manual' (typed in) or 'carrier' (tracking).
-- A manual value is a placeholder: the carrier's first published ETA replaces it once, then it is fixed.
ALTER TABLE shipments ADD COLUMN original_eta_source TEXT;
ALTER TABLE containers ADD COLUMN original_eta_source TEXT;

-- Until now only tracking sync set original_eta, so every existing value came from the carrier.
UPDATE shipments SET original_eta_source = 'carrier' WHERE original_eta IS NOT NULL;
UPDATE containers SET original_eta_source = 'carrier' WHERE original_eta IS NOT NULL;
