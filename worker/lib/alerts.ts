import type { Env } from "../env";
import { esc, sendEmail } from "./email";
import { milestoneLabel } from "../../shared/milestones";

export interface NewAlert {
  shipmentId: number;
  containerId: number | null;
  kind: "eta_change" | "discharged" | "hold" | "hold_released" | "tracking_failed";
  message: string;
  dedupeKey: string;
}

/** Store alerts (deduped) and email the ones that are new. */
export async function raiseAlerts(env: Env, alerts: NewAlert[]): Promise<number> {
  const fresh: NewAlert[] = [];
  for (const a of alerts) {
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO alerts (shipment_id, container_id, kind, message, dedupe_key) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(a.shipmentId, a.containerId, a.kind, a.message, a.dedupeKey)
      .run();
    if (r.meta.changes > 0) fresh.push(a);
  }
  if (fresh.length === 0) return 0;

  const subject =
    fresh.length === 1 ? `Container alert: ${fresh[0].message}` : `Container alerts: ${fresh.length} updates`;
  const html = `<p>${fresh
    .map(
      (a) =>
        `<a href="${esc(env.APP_URL)}/shipments/${a.shipmentId}">${esc(a.message)}</a>`,
    )
    .join("<br>")}</p>`;
  if (await sendEmail(env, subject, html)) {
    for (const a of fresh)
      await env.DB.prepare(`UPDATE alerts SET emailed_at = datetime('now') WHERE dedupe_key = ?`)
        .bind(a.dedupeKey)
        .run();
  }
  return fresh.length;
}

/** Daily digest of all active shipments, sorted by ETA. */
export async function sendDigest(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.carrier_name, s.mbl, s.vessel, s.pod, s.mode, s.reference,
            COALESCE(c.eta, s.eta) AS due, c.number, c.milestone, c.holds, c.elm_delivery_appt,
            (SELECT group_concat(po.po_number, ', ') FROM shipment_pos sp JOIN purchase_orders po ON po.id = sp.po_id WHERE sp.shipment_id = s.id) AS pos,
            (SELECT v.name FROM shipment_pos sp JOIN purchase_orders po ON po.id = sp.po_id JOIN vendors v ON v.id = po.vendor_id WHERE sp.shipment_id = s.id LIMIT 1) AS vendor
     FROM shipments s LEFT JOIN containers c ON c.shipment_id = s.id
     WHERE s.status = 'active' AND (c.id IS NULL OR c.milestone NOT IN ('received'))
     ORDER BY due IS NULL, due`,
  ).all<Record<string, string | null>>();

  const { results: pending } = await env.DB.prepare(
    `SELECT po.po_number, po.crd, v.name AS vendor FROM purchase_orders po
     LEFT JOIN vendors v ON v.id = po.vendor_id
     WHERE po.status = 'open' AND NOT EXISTS (SELECT 1 FROM shipment_pos sp WHERE sp.po_id = po.id)
     ORDER BY po.crd IS NULL, po.crd`,
  ).all<Record<string, string | null>>();

  const rows = results
    .map((r) => {
      const holds = r.holds ? (JSON.parse(r.holds) as { name: string }[]).map((h) => h.name).join(", ") : "";
      return `<tr>
        <td>${esc(r.due?.slice(0, 10) ?? "")}</td>
        <td><a href="${esc(env.APP_URL)}/shipments/${r.id}">${esc(r.number ?? r.reference ?? r.mbl ?? "—")}</a></td>
        <td>${esc(r.pos)}</td><td>${esc(r.vendor)}</td><td>${esc(r.carrier_name ?? r.mode)}</td>
        <td>${esc(milestoneLabel(r.milestone ?? ""))}</td>
        <td style="color:#b91c1c">${esc(holds)}</td>
        <td>${esc(r.elm_delivery_appt?.replace("T", " ") ?? "")}</td></tr>`;
    })
    .join("");
  const pendingRows = pending
    .map((p) => `<tr><td>${esc(p.po_number)}</td><td>${esc(p.vendor)}</td><td>${esc(p.crd ?? "")}</td></tr>`)
    .join("");
  const style = `style="border-collapse:collapse;font:13px sans-serif" border="1" cellpadding="4"`;
  const html = `<h2 style="font-family:sans-serif">In transit (${results.length})</h2>
    <table ${style}><tr><th>ETA</th><th>Container</th><th>PO</th><th>Vendor</th><th>Carrier</th><th>Status</th><th>Holds</th><th>ELM appt</th></tr>${rows}</table>
    <h2 style="font-family:sans-serif">Awaiting booking (${pending.length})</h2>
    <table ${style}><tr><th>PO</th><th>Vendor</th><th>CRD</th></tr>${pendingRows}</table>`;
  const date = new Date().toISOString().slice(0, 10);
  return sendEmail(env, `Container digest ${date}: ${results.length} in transit`, html);
}
