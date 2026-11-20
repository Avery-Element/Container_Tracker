// PO History: the one place History Entries are written.
//
// Every helper returns prepared statements instead of running them, so callers can put
// them in the same db.batch() as the change they describe. D1 runs a batch as a single
// transaction, so a change and its History Entry are saved together or not at all.
// See docs/adr/0001-po-history-is-a-permanent-record.md.

export const SYSTEM = "system";
export const CARRIER = "Carrier tracking";

export type HistoryKind =
  | "created"
  | "field_changed"
  | "linked"
  | "unlinked"
  | "note"
  | "eta_changed"
  | "container_added"
  | "container_removed"
  | "container_changed"
  | "shipment_status"
  | "tracking_started"
  | "tracking_failed"
  | "tracking_event"
  | "milestone"
  | "imported";

export interface HistoryEntry {
  kind: HistoryKind;
  actor: string;
  field?: string | null;
  old_value?: string | null;
  new_value?: string | null;
  occurred_at?: string | null;
  shipment_id?: number | null;
  /** Defaults to the shipment's MBL / reference when shipment_id is given. */
  shipment_label?: string | null;
  container_number?: string | null;
  body?: string | null;
  pre_history?: boolean;
  /** Makes the write idempotent. For fan-out writes, ":po<id>" is appended per PO. */
  dedupe_key?: string | null;
}

/** PO fields that are logged when they change; the vendor is logged by name. */
export const PO_HISTORY_FIELDS = [
  "vendor_pi",
  "order_date",
  "payment_status",
  "deposit_paid_on",
  "paid_on",
  "forwarder",
  "crd",
  "status",
  "description",
] as const;

// Same normalisation the PO routes use when saving, so the comparison matches what is stored.
const blank = (v: string | null | undefined) => (v === undefined || v === "" ? null : v);
const vendorName = (v: string | null | undefined) => v?.trim() || null;

const LABEL_SQL = `(SELECT COALESCE(s.mbl, s.reference, '#' || s.id) FROM shipments s WHERE s.id = ?)`;

function values(e: HistoryEntry) {
  return [
    e.actor,
    e.kind,
    e.field ?? null,
    e.old_value ?? null,
    e.new_value ?? null,
    e.occurred_at ?? null,
    e.shipment_id ?? null,
    e.shipment_label ?? null,
    e.shipment_id ?? null,
    e.container_number ?? null,
    e.body ?? null,
    e.pre_history ? 1 : 0,
  ];
}

const COLS = `po_id, actor, kind, field, old_value, new_value, occurred_at, shipment_id, shipment_label,
  container_number, body, pre_history, dedupe_key`;
const VALS = `?, ?, ?, ?, ?, ?, ?, COALESCE(?, ${LABEL_SQL}), ?, ?, ?`;

/** One History Entry on one PO. Ignored if dedupe_key was already used. */
export function addEntry(db: D1Database, poId: number, e: HistoryEntry): D1PreparedStatement {
  return db
    .prepare(`INSERT OR IGNORE INTO po_history (${COLS}) VALUES (?, ${VALS}, ?)`)
    .bind(poId, ...values(e), e.dedupe_key ?? null);
}

/**
 * The same History Entry on every PO linked to a shipment (shipment notes, ETA changes,
 * container changes, tracking). Must run before any statement that unlinks the POs.
 */
export function forShipmentPos(db: D1Database, shipmentId: number, e: HistoryEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO po_history (${COLS})
       SELECT sp.po_id, ${VALS}, CASE WHEN ? IS NULL THEN NULL ELSE ? || ':po' || sp.po_id END
       FROM shipment_pos sp WHERE sp.shipment_id = ?`,
    )
    .bind(...values({ shipment_id: shipmentId, ...e }), e.dedupe_key ?? null, e.dedupe_key ?? null, shipmentId);
}

/**
 * One field_changed entry per PO field whose value actually changes. Each statement
 * compares against the stored value, so it must run before the UPDATE, in the same batch.
 * Unknown keys are ignored; "" counts as empty.
 */
export function poFieldChanges(
  db: D1Database,
  poId: number,
  patch: Record<string, string | null | undefined>,
  actor: string,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const f of PO_HISTORY_FIELDS) {
    if (!(f in patch)) continue;
    const next = blank(patch[f]);
    stmts.push(
      db
        .prepare(
          `INSERT INTO po_history (po_id, actor, kind, field, old_value, new_value)
           SELECT id, ?, 'field_changed', '${f}', ${f}, ? FROM purchase_orders WHERE id = ? AND ${f} IS NOT ?`,
        )
        .bind(actor, next, poId, next),
    );
  }
  if ("vendor" in patch) {
    const next = vendorName(patch.vendor);
    const current = `(SELECT v.name FROM vendors v WHERE v.id = po.vendor_id)`;
    stmts.push(
      db
        .prepare(
          `INSERT INTO po_history (po_id, actor, kind, field, old_value, new_value)
           SELECT po.id, ?, 'field_changed', 'vendor', ${current}, ? FROM purchase_orders po
           WHERE po.id = ? AND ${current} IS NOT ?`,
        )
        .bind(actor, next, poId, next),
    );
  }
  return stmts;
}
