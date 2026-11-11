-- Container tracker schema (Cloudflare D1 / SQLite)
-- Dates are ISO strings: 'YYYY-MM-DD' or full ISO timestamps.

CREATE TABLE vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY,
  po_number TEXT NOT NULL UNIQUE,           -- e.g. 5871ELM
  vendor_id INTEGER REFERENCES vendors(id),
  vendor_pi TEXT,
  order_date TEXT,
  payment_status TEXT,                      -- not_paid | deposit_paid | paid | other text
  forwarder TEXT,
  crd TEXT,                                 -- cargo ready date
  status TEXT NOT NULL DEFAULT 'open',      -- open | received | cancelled
  description TEXT,                         -- product summary (from CSV notes)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE shipments (
  id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'ocean',       -- ocean | air | parcel
  carrier_name TEXT,
  carrier_scac TEXT,
  mbl TEXT,                                 -- master/house BL or booking number
  reference TEXT,                           -- tracking # / AWB for air & parcel
  forwarder TEXT,
  status TEXT NOT NULL DEFAULT 'active',    -- active | received | cancelled
  pol TEXT,
  pod TEXT,
  vessel TEXT,
  voyage TEXT,
  etd TEXT,
  atd TEXT,
  eta TEXT,
  original_eta TEXT,
  ata TEXT,
  t49_tracking_request_id TEXT,
  t49_shipment_id TEXT,
  tracking_status TEXT,                     -- pending | tracking | failed | stopped
  tracking_error TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_shipments_mbl ON shipments(mbl);
CREATE INDEX idx_shipments_t49 ON shipments(t49_shipment_id);

CREATE TABLE shipment_pos (
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  PRIMARY KEY (shipment_id, po_id)
);

CREATE TABLE containers (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  number_valid INTEGER NOT NULL DEFAULT 1,  -- ISO 6346 check digit passed
  size TEXT,                                -- 20GP / 40HQ ...
  milestone TEXT NOT NULL DEFAULT 'booked',
  eta TEXT,
  original_eta TEXT,
  ata TEXT,
  discharged_at TEXT,
  available INTEGER,                        -- 1/0/null (unknown)
  lfd TEXT,                                 -- last free day at terminal
  holds TEXT,                               -- JSON array [{name,status,description}]
  outgated_at TEXT,
  empty_returned_at TEXT,
  terminal TEXT,
  elm_delivery_appt TEXT,                   -- delivery appointment at ELM warehouse
  received_at TEXT,
  t49_container_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (shipment_id, number)
);
CREATE INDEX idx_containers_number ON containers(number);
CREATE INDEX idx_containers_t49 ON containers(t49_container_id);

CREATE TABLE tracking_events (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  container_id INTEGER REFERENCES containers(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  occurred_at TEXT,
  location TEXT,
  source TEXT NOT NULL DEFAULT 'terminal49', -- terminal49 | manual | import
  external_id TEXT UNIQUE,                   -- webhook notification id (idempotency)
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_container ON tracking_events(container_id);
CREATE INDEX idx_events_shipment ON tracking_events(shipment_id);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  po_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  container_id INTEGER REFERENCES containers(id) ON DELETE CASCADE,
  author TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  container_id INTEGER REFERENCES containers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                       -- eta_change | discharged | hold | hold_released | lfd_soon
  message TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  emailed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
