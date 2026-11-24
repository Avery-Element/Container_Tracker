export interface Container {
  id: number;
  number: string;
  number_valid: number;
  milestone: string;
  eta: string | null;
  original_eta?: string | null;
  ata?: string | null;
  discharged_at?: string | null;
  holds: string | null;
  available?: number | null;
  outgated_at?: string | null;
  terminal?: string | null;
  elm_delivery_appt: string | null;
  received_at?: string | null;
  size: string | null;
  /** 1 = Pallets ticked */
  pallets?: number;
  watched_by?: string | null;
  watched_at?: string | null;
}

export interface PoRef {
  id: number;
  po_number: string;
  payment_status: string | null;
  deposit_paid_on?: string | null;
  paid_on?: string | null;
  order_date: string | null;
  vendor_pi?: string | null;
  forwarder?: string | null;
  watched_by?: string | null;
  watched_at?: string | null;
}

export interface Shipment {
  id: number;
  mode: string;
  carrier_name: string | null;
  carrier_scac: string | null;
  mbl: string | null;
  reference: string | null;
  forwarder: string | null;
  status: string;
  pol: string | null;
  pod: string | null;
  vessel: string | null;
  voyage: string | null;
  etd: string | null;
  atd: string | null;
  eta: string | null;
  original_eta: string | null;
  ata: string | null;
  tracking_status: string | null;
  tracking_error: string | null;
  last_synced_at: string | null;
  vendor: string | null;
  latest_note: { body: string; author: string | null; created_at: string } | null;
  notes_count: number;
  pos: PoRef[];
  containers: Container[];
}

export interface ShipmentDetail extends Shipment {
  events: { id: number; event: string; occurred_at: string | null; location: string | null; source: string; created_at: string; number: string | null }[];
  notes: { id: number; author: string | null; body: string; created_at: string }[];
  alerts: Alert[];
}

export interface Alert {
  id: number;
  kind: string;
  message: string;
  created_at: string;
  shipment_id: number;
  number?: string | null;
}

export interface PurchaseOrder {
  id: number;
  po_number: string;
  vendor: string | null;
  vendor_pi: string | null;
  order_date: string | null;
  payment_status: string | null;
  deposit_paid_on?: string | null;
  paid_on?: string | null;
  forwarder: string | null;
  crd: string | null;
  etd?: string | null;
  status: string;
  description: string | null;
  shipment_ids?: number[];
  watched_by?: string | null;
  watched_at?: string | null;
}

/** One History Entry in a PO's history (see GLOSSARY.md). */
export interface HistoryEntry {
  id: number;
  po_id: number;
  recorded_at: string;
  actor: string;
  kind: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  occurred_at: string | null;
  shipment_id: number | null;
  shipment_label: string | null;
  container_number: string | null;
  body: string | null;
  pre_history: number;
  shipment_exists?: number;
  /** Activity Feed only */
  po_number?: string;
  vendor?: string | null;
}

export interface PoDetail extends PurchaseOrder {
  shipments: {
    id: number;
    mode: string;
    status: string;
    mbl: string | null;
    reference: string | null;
    carrier_name: string | null;
    eta: string | null;
    original_eta: string | null;
    ata: string | null;
    tracking_status: string | null;
    containers: { number: string; milestone: string }[];
  }[];
  history: HistoryEntry[];
}

export interface Dashboard {
  today: string;
  byMilestone: { milestone: string; n: number }[];
  active: Shipment[];
  pendingPos: PurchaseOrder[];
  alerts: Alert[];
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string; message?: string }).error ?? (json as { message?: string }).message ?? res.statusText);
  return json as T;
}

export const api = {
  get: <T>(p: string) => req<T>("GET", p),
  post: <T>(p: string, b?: unknown) => req<T>("POST", p, b ?? {}),
  patch: <T>(p: string, b: unknown) => req<T>("PATCH", p, b),
  del: <T>(p: string) => req<T>("DELETE", p),
};
