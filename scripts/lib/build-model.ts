// Groups parsed rows into DB entities (dedupes POs, shipments, containers).

import type { ParsedRow } from "./parse-tracker";

export interface Model {
  vendors: { id: number; name: string }[];
  pos: {
    id: number;
    po_number: string;
    vendor_id: number | null;
    vendor_pi: string | null;
    order_date: string | null;
    payment_status: string | null;
    forwarder: string | null;
    crd: string | null;
    status: string;
    description: string | null;
  }[];
  shipments: {
    id: number;
    mode: string;
    carrier_name: string | null;
    carrier_scac: string | null;
    mbl: string | null;
    reference: string | null;
    forwarder: string | null;
    status: string;
    etd: string | null;
    eta: string | null;
  }[];
  shipmentPos: { shipment_id: number; po_id: number }[];
  containers: {
    id: number;
    shipment_id: number;
    number: string;
    number_valid: number;
    size: string | null;
    milestone: string;
    eta: string | null;
    elm_delivery_appt: string | null;
    received_at: string | null;
  }[];
  notes: { po_id: number | null; shipment_id: number | null; body: string; created_at: string | null }[];
  issues: { line: number; po: string; issue: string }[];
}

export function buildModel(rows: ParsedRow[], today = new Date().toISOString().slice(0, 10)): Model {
  const m: Model = {
    vendors: [],
    pos: [],
    shipments: [],
    shipmentPos: [],
    containers: [],
    notes: [],
    issues: [],
  };
  const vendorIds = new Map<string, number>();
  const poByNumber = new Map<string, Model["pos"][number]>();
  const poRows = new Map<string, ParsedRow[]>();
  const shipByKey = new Map<string, Model["shipments"][number]>();
  const contByKey = new Map<string, Model["containers"][number]>();
  const linkKeys = new Set<string>();

  for (const r of rows) {
    for (const issue of r.issues) m.issues.push({ line: r.line, po: r.poNumbers.join(", "), issue });

    let vendorId: number | null = null;
    if (r.vendor) {
      if (!vendorIds.has(r.vendor)) {
        const id = vendorIds.size + 1;
        vendorIds.set(r.vendor, id);
        m.vendors.push({ id, name: r.vendor });
      }
      vendorId = vendorIds.get(r.vendor)!;
    }

    // --- POs (a PO may appear on many rows; later rows win for status fields)
    const poIds: number[] = [];
    for (const num of r.poNumbers) {
      let po = poByNumber.get(num);
      if (!po) {
        po = {
          id: m.pos.length + 1,
          po_number: num,
          vendor_id: vendorId,
          vendor_pi: r.vendorPi,
          order_date: r.orderDate,
          payment_status: r.payment,
          forwarder: r.forwarder,
          crd: r.crd,
          status: "open",
          description: null,
        };
        poByNumber.set(num, po);
        m.pos.push(po);
        poRows.set(num, []);
      } else {
        if (r.vendorPi && !(po.vendor_pi ?? "").includes(r.vendorPi))
          po.vendor_pi = po.vendor_pi ? `${po.vendor_pi}, ${r.vendorPi}` : r.vendorPi;
        po.payment_status = r.payment ?? po.payment_status;
        po.forwarder = r.forwarder ?? po.forwarder;
        po.crd = r.crd ?? po.crd;
        po.vendor_id = po.vendor_id ?? vendorId;
        po.order_date = po.order_date ?? r.orderDate;
      }
      poRows.get(num)!.push(r);
      poIds.push(po.id);
    }

    // --- Shipments
    const shipmentIds: number[] = [];
    if (r.mode && !r.cancelled) {
      // One shipment per MBL; pair containers with MBLs when counts line up.
      const mbls = r.mbls.length ? r.mbls : [null];
      const groups: { mbl: string | null; containers: typeof r.containers }[] =
        mbls.length > 1 && mbls.length === r.containers.length
          ? mbls.map((mbl, i) => ({ mbl, containers: [r.containers[i]] }))
          : [{ mbl: mbls[0], containers: r.containers }];
      if (mbls.length > 1 && mbls.length !== r.containers.length)
        m.issues.push({
          line: r.line,
          po: r.poNumbers.join(", "),
          issue: `Row has ${mbls.length} MBLs but ${r.containers.length} containers; all linked to ${mbls[0]}`,
        });

      for (const g of groups) {
        const key =
          r.mode === "ocean" && g.mbl
            ? `bl:${r.scac ?? ""}:${g.mbl}`
            : g.containers[0]
              ? `ctr:${g.containers[0].number}:${r.orderDate?.slice(0, 4) ?? ""}`
              : `row:${r.line}`;
        let s = shipByKey.get(key);
        const allReceived =
          r.received || (g.containers.length > 0 && g.containers.every((c) => c.received));
        if (!s) {
          s = {
            id: m.shipments.length + 1,
            mode: r.mode,
            carrier_name: r.carrierName,
            carrier_scac: r.scac,
            mbl: g.mbl,
            reference: r.reference,
            forwarder: r.forwarder,
            status: allReceived ? "received" : "active",
            etd: r.etd,
            eta: r.portEta,
          };
          shipByKey.set(key, s);
          m.shipments.push(s);
        } else {
          if (!allReceived) s.status = "active";
          s.eta = r.portEta ?? s.eta;
          s.etd = r.etd ?? s.etd;
        }
        shipmentIds.push(s.id);
        for (const poId of poIds) {
          const lk = `${s.id}:${poId}`;
          if (!linkKeys.has(lk)) {
            linkKeys.add(lk);
            m.shipmentPos.push({ shipment_id: s.id, po_id: poId });
          }
        }

        for (const c of g.containers) {
          const ck = `${s.id}:${c.number}`;
          const received = r.received || c.received;
          const appt = c.apptDate ? `${c.apptDate}${c.apptTime ? "T" + c.apptTime : ""}` : null;
          const existing = contByKey.get(ck);
          if (existing) {
            existing.elm_delivery_appt = existing.elm_delivery_appt ?? appt;
            continue;
          }
          const row = {
            id: m.containers.length + 1,
            shipment_id: s.id,
            number: c.number,
            number_valid: c.valid ? 1 : 0,
            size: c.size,
            milestone: received
              ? "received"
              : appt && c.apptDate! < today
                ? "delivered"
                : r.portEta
                  ? "departed"
                  : "booked",
            eta: r.portEta,
            elm_delivery_appt: appt,
            received_at: received ? (c.apptDate ?? null) : null,
          };
          contByKey.set(ck, row);
          m.containers.push(row);
        }
      }
    }

    if (r.notes) {
      const body = r.notes.replace(/\r/g, "").trim();
      m.notes.push({
        po_id: poIds[0] ?? null,
        shipment_id: shipmentIds[0] ?? null,
        body,
        created_at: r.orderDate,
      });
    }
  }

  // PO status: received if every row for it is received; cancelled if flagged.
  for (const po of m.pos) {
    const rs = poRows.get(po.po_number)!;
    if (rs.every((r) => r.cancelled)) po.status = "cancelled";
    else if (rs.every((r) => r.received || r.cancelled)) po.status = "received";
    po.description = rs
      .map((r) => r.notes)
      .filter(Boolean)
      .join(" | ")
      .slice(0, 500) || null;
  }
  return m;
}
