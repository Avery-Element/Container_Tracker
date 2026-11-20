// One-time backfill of PO History for data that existed before PO History began.
// Safe to run more than once: every entry has a dedupe key, so a second run adds nothing.
//
// For each PO it writes:
// - an "Imported" entry (actor "system") with the PO's values at go-live;
// - a "linked" entry for each shipment it is on now;
// - the notes the app already had, under their original author and time;
// - the carrier tracking the app already had, using the same rules as live sync:
//   raw events before Origin departure, then one entry per voyage Milestone;
// - manual milestone changes (e.g. Delivered), whose user was not recorded.
// Everything except the Imported entry is marked pre_history.
//
// Anything already logged live (it happened after deploy, before the backfill ran) is
// skipped, so nothing appears twice.

import type { Env } from "../env";
import { MILESTONE_ORDER, TTC_EVENTS } from "../../shared/milestones";
import { isOriginEvent, isVoyageMilestone } from "../../shared/history";
import { addEntry, CARRIER, PO_HISTORY_FIELDS, SYSTEM, type HistoryEntry } from "./history";
import { milestonesPassed } from "./sync";
import type { TtcEvent } from "./timetocargo";

export const UNKNOWN_USER = "unknown user";

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) -> ISO "YYYY-MM-DDTHH:MM:SS.000Z". */
export const isoUtc = (s: string | null | undefined): string | null => {
  if (!s) return null;
  if (/[zZ]$/.test(s)) return s;
  const t = s.replace(" ", "T");
  return `${t}${t.length === 19 ? ".000" : ""}Z`;
};

interface EventRow {
  id: number;
  shipment_id: number;
  container_id: number | null;
  number: string | null;
  event: string;
  occurred_at: string | null;
  location: string | null;
  source: string;
  external_id: string | null;
  created_at: string;
}

/** A live (not pre-history) entry, used to avoid bringing in something already logged. */
interface LiveEntry {
  po_id: number;
  kind: string;
  shipment_id: number | null;
  container_number: string | null;
  new_value: string | null;
  body: string | null;
  recorded_at: string;
}

export async function backfillHistory(env: Env): Promise<Record<string, number>> {
  const db = env.DB;
  const stmts: D1PreparedStatement[] = [];
  const counts = {
    pos: 0,
    links: 0,
    notes: 0,
    tracking_events: 0,
    milestones: 0,
    manual_milestones: 0,
    skipped_already_logged: 0,
  };

  const { results: live } = await db
    .prepare(
      `SELECT po_id, kind, shipment_id, container_number, new_value, body, recorded_at FROM po_history WHERE pre_history = 0`,
    )
    .all<LiveEntry>();
  const alreadyLogged = (poId: number, e: HistoryEntry) =>
    live.some((l) => {
      if (l.po_id !== poId || l.kind !== e.kind) return false;
      if (e.kind === "linked") return l.shipment_id === e.shipment_id;
      if (e.kind === "milestone") return l.container_number === e.container_number && l.new_value === e.new_value;
      if (e.kind === "note")
        return l.body === e.body && Math.abs(Date.parse(l.recorded_at) - Date.parse(e.recorded_at ?? "")) < 60_000;
      return false; // tracking events share their dedupe key with live sync
    });

  const { results: links } = await db
    .prepare(`SELECT sp.po_id, sp.shipment_id, s.created_at FROM shipment_pos sp JOIN shipments s ON s.id = sp.shipment_id`)
    .all<{ po_id: number; shipment_id: number; created_at: string }>();
  const posOf = new Map<number, number[]>();
  for (const l of links) posOf.set(l.shipment_id, [...(posOf.get(l.shipment_id) ?? []), l.po_id]);

  /** Queue one entry on one PO, unless it is already logged. */
  const put = (poId: number, e: HistoryEntry, key: string, count: keyof typeof counts) => {
    if (alreadyLogged(poId, e)) {
      counts.skipped_already_logged++;
      return;
    }
    stmts.push(addEntry(db, poId, { ...e, dedupe_key: `${key}:po${poId}` }));
    counts[count]++;
  };
  /** Queue the entry on every PO currently on the shipment. */
  const onShipment = (shipmentId: number, e: HistoryEntry, key: string, count: keyof typeof counts) => {
    for (const poId of posOf.get(shipmentId) ?? []) put(poId, { shipment_id: shipmentId, ...e }, key, count);
  };

  // ---- Imported entry + current links
  const { results: pos } = await db
    .prepare(`SELECT po.*, v.name AS vendor FROM purchase_orders po LEFT JOIN vendors v ON v.id = po.vendor_id`)
    .all<Record<string, string | number | null>>();
  for (const po of pos) {
    const values: Record<string, unknown> = { vendor: po.vendor };
    for (const f of PO_HISTORY_FIELDS) values[f] = po[f];
    const snapshot = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== ""));
    stmts.push(
      addEntry(db, po.id as number, { kind: "imported", actor: SYSTEM, body: JSON.stringify(snapshot), dedupe_key: `imported:po${po.id}` }),
    );
    counts.pos++;
  }
  for (const l of links)
    put(
      l.po_id,
      { kind: "linked", actor: SYSTEM, shipment_id: l.shipment_id, recorded_at: isoUtc(l.created_at), pre_history: true },
      `bf-link:s${l.shipment_id}`,
      "links",
    );

  // ---- Notes. Before PO History, shipment notes were also stamped with the first PO's id,
  // so any note with a shipment is treated as a Shipment note (goes on every PO on it).
  const { results: notes } = await db
    .prepare(
      `SELECT n.*, COALESCE(n.shipment_id, c.shipment_id) AS ship_id, c.number
       FROM notes n LEFT JOIN containers c ON c.id = n.container_id`,
    )
    .all<{ id: number; po_id: number | null; ship_id: number | null; number: string | null; author: string | null; body: string; created_at: string }>();
  for (const n of notes) {
    const entry: HistoryEntry = {
      kind: "note",
      actor: n.author === "carrier" ? CARRIER : n.author || UNKNOWN_USER,
      body: n.body,
      container_number: n.number,
      recorded_at: isoUtc(n.created_at),
      pre_history: true,
    };
    if (n.ship_id) onShipment(n.ship_id, entry, `bf-note:${n.id}`, "notes");
    else if (n.po_id) put(n.po_id, entry, `bf-note:${n.id}`, "notes");
  }

  // ---- Tracking
  const { results: ships } = await db.prepare(`SELECT id, atd FROM shipments`).all<{ id: number; atd: string | null }>();
  const atdOf = new Map(ships.map((s) => [s.id, s.atd]));
  const { results: events } = await db
    .prepare(
      `SELECT e.*, c.number FROM tracking_events e LEFT JOIN containers c ON c.id = e.container_id
       WHERE e.shipment_id IS NOT NULL ORDER BY e.created_at, e.id`,
    )
    .all<EventRow>();

  const byContainer = new Map<number, EventRow[]>();
  for (const e of events) {
    if (e.source === "manual") {
      // Manual milestone changes were stored as "manual.<milestone>"; who made them wasn't kept.
      const m = e.event.replace(/^manual\./, "");
      if (!(m in MILESTONE_ORDER)) continue;
      onShipment(
        e.shipment_id,
        {
          kind: "milestone",
          actor: UNKNOWN_USER,
          field: "milestone",
          new_value: m,
          container_number: e.number,
          recorded_at: isoUtc(e.created_at),
          pre_history: true,
        },
        `bf-manual:${e.id}`,
        "manual_milestones",
      );
      continue;
    }
    // external_id is "ttc:<container>:<code>:<date>" (the date itself contains colons)
    const [, , code, ...rest] = (e.external_id ?? "").split(":");
    const date = rest.join(":") || e.occurred_at;
    if (e.external_id && isOriginEvent(code, date, atdOf.get(e.shipment_id) ?? null))
      onShipment(
        e.shipment_id,
        {
          kind: "tracking_event",
          actor: CARRIER,
          container_number: e.number,
          occurred_at: e.occurred_at,
          body: [e.event, e.location].filter(Boolean).join(" · "),
          recorded_at: isoUtc(e.created_at),
          pre_history: true,
        },
        e.external_id, // the same key live sync uses, so nothing is logged twice
        "tracking_events",
      );
    if (e.container_id && code)
      byContainer.set(e.container_id, [...(byContainer.get(e.container_id) ?? []), { ...e, event: code, occurred_at: date }]);
  }

  // Voyage milestones per container, from its carrier events.
  for (const [containerId, rows] of byContainer) {
    const shipmentId = rows[0].shipment_id;
    const departedAt = atdOf.get(shipmentId) ?? null;
    const actual: TtcEvent[] = rows.map((r) => ({ status_code: r.event, date: r.occurred_at, actual: true }) as TtcEvent);
    let top = departedAt ? "departed" : "booked";
    for (const r of rows) {
      const m = TTC_EVENTS[r.event]?.milestone;
      if (!m || (r.event === "CGO" && departedAt && (r.occurred_at ?? "") < departedAt)) continue;
      if ((MILESTONE_ORDER[m] ?? -1) > (MILESTONE_ORDER[top] ?? -1)) top = m;
    }
    if (!isVoyageMilestone(top)) continue;
    // When the app learned of each milestone: when its first event was stored. A Departed
    // with no VDL event (some carriers) was learned with the first event after sailing.
    const afterSailing = (r: EventRow) => !departedAt || (r.occurred_at ?? "") >= departedAt;
    const learned = (m: string) =>
      rows.find((r) => TTC_EVENTS[r.event]?.milestone === m && (m === "departed" || afterSailing(r)))?.created_at ??
      rows.find(afterSailing)?.created_at ??
      rows[0].created_at;
    let from: string | null = null;
    for (const step of milestonesPassed("loaded", top, actual, departedAt)) {
      onShipment(
        shipmentId,
        {
          kind: "milestone",
          actor: CARRIER,
          field: "milestone",
          old_value: from,
          new_value: step.milestone,
          container_number: rows[0].number,
          occurred_at: step.at,
          recorded_at: isoUtc(learned(step.milestone)),
          pre_history: true,
        },
        `bf-ms:c${containerId}:${step.milestone}`,
        "milestones",
      );
      from = step.milestone;
    }
  }

  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  const total = await db.prepare(`SELECT count(*) AS n FROM po_history`).first<{ n: number }>();
  return { ...counts, history_entries_total: total?.n ?? 0 };
}
