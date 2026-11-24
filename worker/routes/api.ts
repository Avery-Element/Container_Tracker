import { Hono } from "hono";
import type { Env } from "../env";
import { checkPendingTasks, refreshAll, startTracking, stopTracking, syncAll } from "../lib/sync";
import { getBatch } from "../lib/timetocargo";
import { sendDigest } from "../lib/alerts";
import { normalizeContainerNumber, isValidContainerNumber } from "../../shared/container-number";
import { carrierByScac, carrierFromMbl } from "../../shared/carriers";
import { MILESTONE_ORDER } from "../../shared/milestones";
import { addEntry, forShipmentPos, poFieldChanges } from "../lib/history";
import { resolvePayment } from "../../shared/payment";
import { backfillHistory } from "../lib/backfill";

type Vars = { Variables: { user: string } };
export const api = new Hono<{ Bindings: Env } & Vars>();

const today = () => new Date().toISOString().slice(0, 10);
const dayOf = (s: string | null | undefined) => (s ? s.slice(0, 10) : null);

/**
 * `{ watched: true | false }` in a PATCH body ticks or unticks Watching on a container or PO:
 * records who and when, or clears both. Not logged in PO History (it's a view setting).
 */
function watchSets(body: Record<string, unknown>, actor: string, sets: string[], binds: unknown[]) {
  if (!("watched" in body)) return;
  sets.push("watched_by = ?", "watched_at = ?");
  binds.push(...(body.watched ? [actor, new Date().toISOString()] : [null, null]));
}

// Shipment list query reused by the dashboard and shipments page.
const SHIPMENT_SELECT = `
  SELECT s.*,
    (SELECT json_group_array(json_object('id', po.id, 'po_number', po.po_number, 'payment_status', po.payment_status,
        'deposit_paid_on', po.deposit_paid_on, 'paid_on', po.paid_on, 'order_date', po.order_date,
        'watched_by', po.watched_by, 'watched_at', po.watched_at))
       FROM shipment_pos sp JOIN purchase_orders po ON po.id = sp.po_id WHERE sp.shipment_id = s.id) AS pos_json,
    (SELECT v.name FROM shipment_pos sp JOIN purchase_orders po ON po.id = sp.po_id
       JOIN vendors v ON v.id = po.vendor_id WHERE sp.shipment_id = s.id LIMIT 1) AS vendor,
    (SELECT json_group_array(json_object('id', c.id, 'number', c.number, 'number_valid', c.number_valid,
        'milestone', c.milestone, 'eta', c.eta, 'original_eta', c.original_eta, 'holds', c.holds,
        'elm_delivery_appt', c.elm_delivery_appt, 'size', c.size, 'available', c.available,
        'watched_by', c.watched_by, 'watched_at', c.watched_at))
       FROM containers c WHERE c.shipment_id = s.id) AS containers_json,
    (SELECT json_object('body', n.body, 'author', n.author, 'created_at', n.created_at)
       FROM notes n WHERE n.shipment_id = s.id
         OR n.po_id IN (SELECT po_id FROM shipment_pos WHERE shipment_id = s.id)
       ORDER BY n.created_at DESC, n.id DESC LIMIT 1) AS latest_note_json,
    (SELECT count(*) FROM notes n WHERE n.shipment_id = s.id
         OR n.po_id IN (SELECT po_id FROM shipment_pos WHERE shipment_id = s.id)) AS notes_count
  FROM shipments s`;

function hydrate(r: Record<string, unknown>) {
  const { pos_json, containers_json, latest_note_json, ...rest } = r;
  return {
    ...rest,
    latest_note: latest_note_json ? JSON.parse(latest_note_json as string) : null,
    pos: JSON.parse((pos_json as string) ?? "[]"),
    containers: JSON.parse((containers_json as string) ?? "[]"),
  };
}

api.get("/me", (c) => c.json({ email: c.get("user") }));

api.get("/dashboard", async (c) => {
  const db = c.env.DB;
  const { results: byMilestone } = await db
    .prepare(
      `SELECT c.milestone, count(*) AS n FROM containers c JOIN shipments s ON s.id = c.shipment_id
       WHERE s.status = 'active' GROUP BY c.milestone`,
    )
    .all<{ milestone: string; n: number }>();
  byMilestone.sort((a, b) => (MILESTONE_ORDER[a.milestone] ?? 99) - (MILESTONE_ORDER[b.milestone] ?? 99));

  const { results: active } = await db
    .prepare(`${SHIPMENT_SELECT} WHERE s.status = 'active' ORDER BY s.eta IS NULL, s.eta`)
    .all<Record<string, unknown>>();

  const { results: pendingPos } = await db
    .prepare(
      `SELECT po.*, v.name AS vendor FROM purchase_orders po LEFT JOIN vendors v ON v.id = po.vendor_id
       WHERE po.status = 'open' AND NOT EXISTS (SELECT 1 FROM shipment_pos sp WHERE sp.po_id = po.id)
       ORDER BY po.crd IS NULL, po.crd, po.order_date`,
    )
    .all();

  const { results: alerts } = await db
    .prepare(
      `SELECT a.*, c.number FROM alerts a LEFT JOIN containers c ON c.id = a.container_id
       ORDER BY a.created_at DESC LIMIT 15`,
    )
    .all();

  return c.json({
    today: today(),
    byMilestone,
    active: active.map(hydrate),
    pendingPos,
    alerts,
  });
});

api.get("/shipments", async (c) => {
  const status = c.req.query("status") ?? "active";
  const q = (c.req.query("q") ?? "").trim();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status !== "all") {
    binds.push(status);
    where.push(`s.status = ?${binds.length}`);
  }
  if (q) {
    binds.push(`%${q}%`);
    const p = `?${binds.length}`;
    where.push(`(s.mbl LIKE ${p} OR s.reference LIKE ${p} OR s.carrier_name LIKE ${p}
      OR EXISTS (SELECT 1 FROM containers c WHERE c.shipment_id = s.id AND c.number LIKE ${p})
      OR EXISTS (SELECT 1 FROM shipment_pos sp JOIN purchase_orders po ON po.id = sp.po_id
                 LEFT JOIN vendors v ON v.id = po.vendor_id
                 WHERE sp.shipment_id = s.id AND (po.po_number LIKE ${p} OR v.name LIKE ${p} OR po.vendor_pi LIKE ${p}))
      OR EXISTS (SELECT 1 FROM notes n WHERE (n.shipment_id = s.id
                 OR n.po_id IN (SELECT po_id FROM shipment_pos WHERE shipment_id = s.id)) AND n.body LIKE ${p}))`);
  }
  const sql = `${SHIPMENT_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY s.status = 'active' DESC,
      CASE WHEN s.status = 'active' THEN s.eta END ASC NULLS LAST,
      COALESCE(s.eta, s.created_at) DESC LIMIT 500`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  return c.json(results.map(hydrate));
});

api.get("/shipments/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const s = await db.prepare(`${SHIPMENT_SELECT} WHERE s.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!s) return c.json({ error: "Not found" }, 404);
  const [containers, events, notes, alerts] = await Promise.all([
    db.prepare(`SELECT * FROM containers WHERE shipment_id = ? ORDER BY number`).bind(id).all(),
    db
      .prepare(
        `SELECT e.id, e.event, e.occurred_at, e.location, e.source, e.created_at, c.number
         FROM tracking_events e LEFT JOIN containers c ON c.id = e.container_id
         WHERE e.shipment_id = ? ORDER BY COALESCE(e.occurred_at, e.created_at) DESC`,
      )
      .bind(id)
      .all(),
    db
      .prepare(
        `SELECT * FROM notes WHERE shipment_id = ?
           OR po_id IN (SELECT po_id FROM shipment_pos WHERE shipment_id = ?) ORDER BY created_at DESC`,
      )
      .bind(id, id)
      .all(),
    db.prepare(`SELECT * FROM alerts WHERE shipment_id = ? ORDER BY created_at DESC`).bind(id).all(),
  ]);
  return c.json({
    ...hydrate(s),
    containers: containers.results,
    events: events.results,
    notes: notes.results,
    alerts: alerts.results,
  });
});

const SHIPMENT_FIELDS = ["mode", "carrier_scac", "mbl", "reference", "forwarder", "status", "eta", "etd"] as const;

api.post("/shipments", async (c) => {
  const body = await c.req.json<{
    po_ids?: number[];
    mode?: string;
    carrier_scac?: string;
    mbl?: string;
    reference?: string;
    forwarder?: string;
    eta?: string;
    containers?: string[];
  }>();
  const carrier = carrierByScac(body.carrier_scac) ?? carrierFromMbl(body.mbl);
  const db = c.env.DB;
  const s = await db.prepare(
    `INSERT INTO shipments (mode, carrier_name, carrier_scac, mbl, reference, forwarder, eta, original_eta, original_eta_source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, CASE WHEN ?7 IS NULL THEN NULL ELSE 'manual' END) RETURNING id`,
  )
    .bind(
      body.mode ?? "ocean",
      carrier?.name ?? null,
      carrier?.scac ?? null,
      body.mbl?.trim().toUpperCase() || null,
      body.reference?.trim() || null,
      body.forwarder?.trim() || null,
      body.eta || null,
    )
    .first<{ id: number }>();
  const id = s!.id;
  const numbers = [...new Set((body.containers ?? []).map(normalizeContainerNumber).filter(Boolean))];
  const stmts: D1PreparedStatement[] = numbers.map((n) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO containers (shipment_id, number, number_valid, milestone, eta, original_eta, original_eta_source)
         VALUES (?1, ?2, ?3, 'booked', ?4, ?4, CASE WHEN ?4 IS NULL THEN NULL ELSE 'manual' END)`,
      )
      .bind(id, n, isValidContainerNumber(n) ? 1 : 0, body.eta || null),
  );
  // Containers added at creation are listed in the "linked" entry, not logged one by one.
  for (const po of new Set(body.po_ids ?? []))
    stmts.push(
      db.prepare(`INSERT OR IGNORE INTO shipment_pos (shipment_id, po_id) VALUES (?, ?)`).bind(id, po),
      addEntry(db, po, {
        kind: "linked",
        actor: c.get("user"),
        shipment_id: id,
        body: numbers.length ? `Containers: ${numbers.join(", ")}` : null,
      }),
    );
  if (stmts.length) await db.batch(stmts);
  return c.json({ id }, 201);
});

api.patch("/shipments/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Record<string, string | null>>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const f of SHIPMENT_FIELDS)
    if (f in body) {
      sets.push(`${f} = ?`);
      binds.push(body[f] === "" ? null : body[f]);
    }
  // A typed-in ETA fills "first published" only if it's empty, marked manual so the
  // carrier's first ETA can replace it; later edits only change the current ETA.
  if (body.eta) {
    sets.push(
      "original_eta_source = CASE WHEN original_eta IS NULL THEN 'manual' ELSE original_eta_source END",
      "original_eta = COALESCE(original_eta, ?)",
    );
    binds.push(body.eta);
  }
  if ("carrier_scac" in body) {
    sets.push("carrier_name = ?");
    binds.push(carrierByScac(body.carrier_scac)?.name ?? null);
    // carrier/BL changed: tracking must be re-requested
  }
  if ("carrier_scac" in body || "mbl" in body) {
    await stopTracking(c.env, id); // archive the old tracking before re-requesting
    sets.push("tracking_ids = NULL, tracking_task_id = NULL, tracking_status = NULL, tracking_error = NULL");
  }
  if (!sets.length) return c.json({ ok: true });
  const db = c.env.DB;
  const prev = await db.prepare(`SELECT eta, status FROM shipments WHERE id = ?`).bind(id).first<{ eta: string | null; status: string }>();
  if (!prev) return c.json({ error: "Not found" }, 404);
  const stmts: D1PreparedStatement[] = [];
  const actor = c.get("user");
  // History first: it reads the shipment's links and label before anything changes.
  const newEta = "eta" in body ? body.eta || null : prev.eta;
  if (dayOf(newEta) !== dayOf(prev.eta))
    stmts.push(forShipmentPos(db, id, { kind: "eta_changed", actor, field: "eta", old_value: dayOf(prev.eta), new_value: dayOf(newEta) }));
  if (body.status && body.status !== prev.status)
    stmts.push(forShipmentPos(db, id, { kind: "shipment_status", actor, field: "status", old_value: prev.status, new_value: body.status }));
  if (body.status === "received")
    stmts.push(
      db
        .prepare(`UPDATE containers SET milestone='received', received_at=COALESCE(received_at, date('now')) WHERE shipment_id=?`)
        .bind(id),
    );
  stmts.push(db.prepare(`UPDATE shipments SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).bind(...binds, id));
  await db.batch(stmts);
  if (body.status === "received" || body.status === "cancelled") await stopTracking(c.env, id);
  return c.json({ ok: true });
});

// Deletes the shipment and its containers, events, notes, alerts and PO links.
// The purchase orders themselves are kept.
api.delete("/shipments/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await stopTracking(c.env, id); // archive live tracking so we stop being billed for it
  const db = c.env.DB;
  await db.batch([
    // Logged first, while the PO links and the shipment's label still exist. PO History is kept.
    forShipmentPos(db, id, { kind: "unlinked", actor: c.get("user"), body: "Shipment deleted" }),
    db.prepare(`DELETE FROM tracking_events WHERE shipment_id = ? OR container_id IN (SELECT id FROM containers WHERE shipment_id = ?)`).bind(id, id),
    db.prepare(`DELETE FROM alerts WHERE shipment_id = ? OR container_id IN (SELECT id FROM containers WHERE shipment_id = ?)`).bind(id, id),
    db.prepare(`DELETE FROM notes WHERE shipment_id = ? OR container_id IN (SELECT id FROM containers WHERE shipment_id = ?)`).bind(id, id),
    db.prepare(`DELETE FROM containers WHERE shipment_id = ?`).bind(id),
    db.prepare(`DELETE FROM shipment_pos WHERE shipment_id = ?`).bind(id),
    db.prepare(`DELETE FROM shipments WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true });
});

api.post("/shipments/:id/pos", async (c) => {
  const id = Number(c.req.param("id"));
  const { po_id } = await c.req.json<{ po_id: number }>();
  const db = c.env.DB;
  const linked = await db.prepare(`SELECT 1 FROM shipment_pos WHERE shipment_id = ? AND po_id = ?`).bind(id, po_id).first();
  if (linked) return c.json({ ok: true });
  await db.batch([
    db.prepare(`INSERT INTO shipment_pos (shipment_id, po_id) VALUES (?, ?)`).bind(id, po_id),
    addEntry(db, po_id, { kind: "linked", actor: c.get("user"), shipment_id: id }),
  ]);
  return c.json({ ok: true });
});

api.post("/shipments/:id/containers", async (c) => {
  const id = Number(c.req.param("id"));
  const { number } = await c.req.json<{ number: string }>();
  const n = normalizeContainerNumber(number ?? "");
  if (!/^[A-Z]{4}\d{6,8}$/.test(n)) return c.json({ error: "Container number should look like ABCU1234567" }, 400);
  const db = c.env.DB;
  const exists = await db.prepare(`SELECT 1 FROM containers WHERE shipment_id = ? AND number = ?`).bind(id, n).first();
  if (!exists)
    await db.batch([
      db
        .prepare(
          `INSERT INTO containers (shipment_id, number, number_valid, milestone, eta, original_eta, original_eta_source)
           SELECT ?, ?, ?, 'booked', eta, COALESCE(original_eta, eta),
             CASE WHEN original_eta IS NOT NULL THEN original_eta_source WHEN eta IS NOT NULL THEN 'manual' END
           FROM shipments WHERE id = ?`,
        )
        .bind(id, n, isValidContainerNumber(n) ? 1 : 0, id),
      forShipmentPos(db, id, { kind: "container_added", actor: c.get("user"), container_number: n }),
    ]);
  return c.json({ ok: true, valid: isValidContainerNumber(n) });
});

// Start tracking one shipment and wait briefly for the carrier lookup.
api.post("/shipments/:id/track", async (c) => {
  const id = Number(c.req.param("id"));
  try {
    const r = await startTracking(c.env, [id]);
    if (!r.ok || !r.taskId) return c.json(r);
    for (let i = 0; i < 6; i++) {
      await new Promise((res) => setTimeout(res, 4000));
      const task = await getBatch(c.env.TIMETOCARGO_API_KEY!, r.taskId);
      if (task?.status === "PROCESSED") {
        await checkPendingTasks(c.env);
        const s = await c.env.DB.prepare(`SELECT tracking_status, tracking_error FROM shipments WHERE id = ?`)
          .bind(id)
          .first<{ tracking_status: string; tracking_error: string | null }>();
        return c.json({
          ok: s?.tracking_status === "tracking",
          message: s?.tracking_status === "tracking" ? "Tracking is live" : (s?.tracking_error ?? "Tracking failed"),
        });
      }
    }
    return c.json({ ok: true, message: "Requested. The carrier lookup is still running; check back in a few minutes." });
  } catch (e) {
    return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, 502);
  }
});

api.post("/shipments/:id/refresh", async (c) => {
  try {
    await checkPendingTasks(c.env);
    const n = await refreshAll(c.env);
    return c.json({ ok: true, message: `Updated ${n} tracked shipment(s)` });
  } catch (e) {
    return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, 502);
  }
});

const CONTAINER_FIELDS = ["milestone", "elm_delivery_appt", "received_at", "size"] as const;
api.patch("/containers/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Record<string, string | null>>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const f of CONTAINER_FIELDS)
    if (f in body) {
      sets.push(`${f} = ?`);
      binds.push(body[f] === "" ? null : body[f]);
    }
  if (body.milestone === "received" && !("received_at" in body)) sets.push("received_at = COALESCE(received_at, date('now'))");
  const actor = c.get("user");
  watchSets(body, actor, sets, binds);
  if (!sets.length) return c.json({ ok: true });
  const db = c.env.DB;
  const prev = await db
    .prepare(`SELECT shipment_id, number, milestone, elm_delivery_appt, received_at FROM containers WHERE id = ?`)
    .bind(id)
    .first<{ shipment_id: number; number: string; milestone: string; elm_delivery_appt: string | null; received_at: string | null }>();
  if (!prev) return c.json({ error: "Not found" }, 404);
  const stmts: D1PreparedStatement[] = [];
  const onPos = (e: Parameters<typeof forShipmentPos>[2]) =>
    stmts.push(forShipmentPos(db, prev.shipment_id, { container_number: prev.number, ...e }));
  if (body.milestone && body.milestone !== prev.milestone)
    onPos({ kind: "milestone", actor, field: "milestone", old_value: prev.milestone, new_value: body.milestone });
  // Logged changes: delivery appointment and received date (size and other fields are not).
  const nextReceived =
    "received_at" in body ? body.received_at || null : body.milestone === "received" ? (prev.received_at ?? today()) : prev.received_at;
  const nextAppt = "elm_delivery_appt" in body ? body.elm_delivery_appt || null : prev.elm_delivery_appt;
  if (nextAppt !== prev.elm_delivery_appt)
    onPos({ kind: "container_changed", actor, field: "elm_delivery_appt", old_value: prev.elm_delivery_appt, new_value: nextAppt });
  if (nextReceived !== prev.received_at)
    onPos({ kind: "container_changed", actor, field: "received_at", old_value: prev.received_at, new_value: nextReceived });
  stmts.push(db.prepare(`UPDATE containers SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).bind(...binds, id));
  await db.batch(stmts);
  if (body.milestone) {
    await c.env.DB.prepare(
      `INSERT INTO tracking_events (shipment_id, container_id, event, occurred_at, source)
       SELECT shipment_id, id, ?, datetime('now'), 'manual' FROM containers WHERE id = ?`,
    )
      .bind(`manual.${body.milestone}`, id)
      .run();
    // close the shipment when every container is received
    const open = await db
      .prepare(`SELECT status FROM shipments WHERE id = ? AND status != 'received'
                AND NOT EXISTS (SELECT 1 FROM containers WHERE shipment_id = shipments.id AND milestone != 'received')`)
      .bind(prev.shipment_id)
      .first<{ status: string }>();
    if (open)
      await db.batch([
        forShipmentPos(db, prev.shipment_id, {
          kind: "shipment_status",
          actor,
          field: "status",
          old_value: open.status,
          new_value: "received",
          body: "Every container received",
        }),
        db.prepare(`UPDATE shipments SET status = 'received', updated_at = datetime('now') WHERE id = ?`).bind(prev.shipment_id),
      ]);
    const closed = await db
      .prepare(`SELECT id FROM shipments WHERE id = ? AND status = 'received'`)
      .bind(prev.shipment_id)
      .first<{ id: number }>();
    if (closed) await stopTracking(c.env, closed.id);
  }
  return c.json({ ok: true });
});

api.delete("/containers/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const row = await db.prepare(`SELECT shipment_id, number FROM containers WHERE id = ?`).bind(id).first<{ shipment_id: number; number: string }>();
  if (!row) return c.json({ ok: true });
  await db.batch([
    forShipmentPos(db, row.shipment_id, { kind: "container_removed", actor: c.get("user"), container_number: row.number }),
    db.prepare(`DELETE FROM containers WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true });
});

// ---- Purchase orders
api.get("/pos", async (c) => {
  const status = c.req.query("status") ?? "open";
  const { results } = await c.env.DB.prepare(
    `SELECT po.*, v.name AS vendor,
       (SELECT json_group_array(sp.shipment_id) FROM shipment_pos sp WHERE sp.po_id = po.id) AS shipment_ids
     FROM purchase_orders po LEFT JOIN vendors v ON v.id = po.vendor_id
     ${status === "all" ? "" : "WHERE po.status = ?"}
     ORDER BY po.po_number DESC LIMIT 1000`,
  )
    .bind(...(status === "all" ? [] : [status]))
    .all<Record<string, unknown>>();
  return c.json(results.map((r) => ({ ...r, shipment_ids: JSON.parse((r.shipment_ids as string) ?? "[]") })));
});

// One PO with its shipments and its full PO History (oldest first).
api.get("/pos/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const po = await db
    .prepare(`SELECT po.*, v.name AS vendor FROM purchase_orders po LEFT JOIN vendors v ON v.id = po.vendor_id WHERE po.id = ?`)
    .bind(id)
    .first();
  if (!po) return c.json({ error: "Not found" }, 404);
  const [shipments, history] = await Promise.all([
    db
      .prepare(
        `SELECT s.id, s.mode, s.status, s.mbl, s.reference, s.carrier_name, s.eta, s.original_eta, s.ata, s.tracking_status,
           (SELECT json_group_array(json_object('number', c.number, 'milestone', c.milestone)) FROM containers c WHERE c.shipment_id = s.id) AS containers_json
         FROM shipment_pos sp JOIN shipments s ON s.id = sp.shipment_id WHERE sp.po_id = ? ORDER BY s.created_at`,
      )
      .bind(id)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT h.*, EXISTS (SELECT 1 FROM shipments s WHERE s.id = h.shipment_id) AS shipment_exists
         FROM po_history h WHERE h.po_id = ? ORDER BY ${RECORDED_ORDER}, h.id`,
      )
      .bind(id)
      .all(),
  ]);
  return c.json({
    ...po,
    shipments: shipments.results.map(({ containers_json, ...s }) => ({ ...s, containers: JSON.parse((containers_json as string) ?? "[]") })),
    history: history.results,
  });
});

// ---- Activity Feed: History Entries across all POs

// Some backfilled entries only know their date ("YYYY-MM-DDZ", from the spreadsheet import).
// They sort at the start of their day.
const RECORDED_ORDER = `CASE WHEN length(h.recorded_at) < 20 THEN substr(h.recorded_at, 1, 10) || 'T00:00:00.000Z' ELSE h.recorded_at END`;

const TRACKING_KINDS = ["tracking_event", "milestone"];

/**
 * Filters shared by the feed and its CSV export. from/to are ISO timestamps (the browser
 * turns the viewer's local days into exact times). Carrier tracking is left out unless
 * asked for, or unless a tracking type is picked.
 */
function historyFilter(q: (k: string) => string | undefined) {
  const where: string[] = [];
  const binds: unknown[] = [];
  const add = (sql: string, ...v: unknown[]) => (where.push(sql), binds.push(...v));
  const kinds = (q("type") ?? "").split(",").filter(Boolean);
  if (kinds.length) add(`h.kind IN (${kinds.map(() => "?").join(",")})`, ...kinds);
  else if (q("tracking") !== "1") add(`h.kind NOT IN (${TRACKING_KINDS.map(() => "?").join(",")})`, ...TRACKING_KINDS);
  if (q("field")) add(`h.field = ?`, q("field"));
  if (q("actor")) add(`h.actor = ?`, q("actor"));
  if (q("from")) add(`h.recorded_at >= ?`, q("from"));
  if (q("to")) add(`h.recorded_at < ?`, q("to"));
  if (q("vendor")) add(`v.name = ?`, q("vendor"));
  if (q("po")) add(`po.po_number LIKE ?`, `%${q("po")!.trim().toUpperCase()}%`);
  return {
    sql: `FROM po_history h JOIN purchase_orders po ON po.id = h.po_id LEFT JOIN vendors v ON v.id = po.vendor_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
    binds,
  };
}

api.get("/history", async (c) => {
  const f = historyFilter((k) => c.req.query(k));
  const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 500);
  const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
  const { results } = await c.env.DB.prepare(
    `SELECT h.*, po.po_number, v.name AS vendor, EXISTS (SELECT 1 FROM shipments s WHERE s.id = h.shipment_id) AS shipment_exists
     ${f.sql} ORDER BY ${RECORDED_ORDER} DESC, h.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...f.binds, limit + 1, offset)
    .all();
  return c.json({ entries: results.slice(0, limit), has_more: results.length > limit });
});

/** People and processes that appear in PO History, for the feed's "Who" filter. */
api.get("/history/actors", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT DISTINCT actor FROM po_history ORDER BY actor`).all<{ actor: string }>();
  return c.json(results.map((r) => r.actor));
});

/** True for entries that only know their date, not the time. */
const dateOnly = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}Z?$/.test(s);

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Quote when needed; prefix formula-like text so spreadsheets don't execute it.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

api.get("/history.csv", async (c) => {
  const f = historyFilter((k) => c.req.query(k));
  const { results } = await c.env.DB.prepare(
    `SELECT h.*, po.po_number, v.name AS vendor ${f.sql} ORDER BY ${RECORDED_ORDER} DESC, h.id DESC LIMIT 50000`,
  )
    .bind(...f.binds)
    .all<Record<string, unknown>>();
  const tz = c.req.query("tz") || "UTC";
  let local: Intl.DateTimeFormat;
  try {
    local = new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short", timeStyle: "medium", hourCycle: "h23" });
  } catch {
    local = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", dateStyle: "short", timeStyle: "medium", hourCycle: "h23" });
  }
  const header = [
    `Recorded (${tz})`, "Recorded (UTC)", "PO", "Vendor", "Who", "Type", "Field", "Old value", "New value",
    "Shipment", "Container", "Occurred", "Details", "Before history began",
  ];
  const lines = results.map((h) =>
    [
      dateOnly(h.recorded_at) ? String(h.recorded_at).slice(0, 10) : local.format(new Date(h.recorded_at as string)).replace(",", ""),
      dateOnly(h.recorded_at) ? String(h.recorded_at).slice(0, 10) : h.recorded_at,
      h.po_number,
      h.vendor,
      h.actor,
      h.kind,
      h.field,
      h.old_value,
      h.new_value,
      h.shipment_label,
      h.container_number,
      h.occurred_at,
      h.body,
      h.pre_history ? "yes" : "",
    ]
      .map(csvCell)
      .join(","),
  );
  const stamp = new Date().toISOString().slice(0, 10);
  // The leading BOM makes Excel read the file as UTF-8 (vendor names, notes).
  return new Response("﻿" + [header.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="po-history-${stamp}.csv"`,
    },
  });
});

api.get("/vendors", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM vendors ORDER BY name`).all();
  return c.json(results);
});

async function vendorId(env: Env, name: string | undefined | null) {
  const n = name?.trim();
  if (!n) return null;
  const row = await env.DB.prepare(
    `INSERT INTO vendors (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
  )
    .bind(n)
    .first<{ id: number }>();
  return row!.id;
}

api.post("/pos", async (c) => {
  const b = await c.req.json<Record<string, string>>();
  const num = (b.po_number ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!num) return c.json({ error: "PO number required" }, 400);
  const pay = resolvePayment({}, { payment_status: "not_paid", ...b }, today());
  if ("error" in pay) return c.json({ error: pay.error }, 400);
  const vid = await vendorId(c.env, b.vendor);
  const db = c.env.DB;
  const initial = {
    vendor: b.vendor?.trim() || null,
    vendor_pi: b.vendor_pi || null,
    order_date: b.order_date || today(),
    payment_status: pay.fields.payment_status ?? "not_paid",
    deposit_paid_on: pay.fields.deposit_paid_on ?? null,
    paid_on: pay.fields.paid_on ?? null,
    forwarder: b.forwarder || null,
    crd: b.crd || null,
    description: b.description || null,
  };
  // The "created" entry records the starting values, so later field changes read as old -> new.
  const snapshot = JSON.stringify(Object.fromEntries(Object.entries(initial).filter(([, v]) => v !== null)));
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO purchase_orders (po_number, vendor_id, vendor_pi, order_date, payment_status, deposit_paid_on, paid_on,
             forwarder, crd, description)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          num,
          vid,
          initial.vendor_pi,
          initial.order_date,
          initial.payment_status,
          initial.deposit_paid_on,
          initial.paid_on,
          initial.forwarder,
          initial.crd,
          initial.description,
        ),
      db
        .prepare(`INSERT INTO po_history (po_id, actor, kind, body) SELECT id, ?, 'created', ? FROM purchase_orders WHERE po_number = ?`)
        .bind(c.get("user"), snapshot, num),
    ]);
  } catch (e) {
    return c.json({ error: `PO ${num} already exists` }, 409);
  }
  const row = await db.prepare(`SELECT id FROM purchase_orders WHERE po_number = ?`).bind(num).first<{ id: number }>();
  return c.json({ id: row!.id }, 201);
});

const PO_FIELDS = [
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
api.patch("/pos/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<Record<string, string | null>>();
  if ("payment_status" in b || "deposit_paid_on" in b || "paid_on" in b) {
    const current = await c.env.DB.prepare(`SELECT payment_status, deposit_paid_on, paid_on FROM purchase_orders WHERE id = ?`)
      .bind(id)
      .first<{ payment_status: string | null; deposit_paid_on: string | null; paid_on: string | null }>();
    if (!current) return c.json({ error: "Not found" }, 404);
    const pay = resolvePayment(current, b, today());
    if ("error" in pay) return c.json({ error: pay.error }, 400);
    Object.assign(b, pay.fields);
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const f of PO_FIELDS)
    if (f in b) {
      sets.push(`${f} = ?`);
      binds.push(b[f] === "" ? null : b[f]);
    }
  if ("vendor" in b) {
    sets.push("vendor_id = ?");
    binds.push(await vendorId(c.env, b.vendor));
  }
  watchSets(b, c.get("user"), sets, binds);
  if (!sets.length) return c.json({ ok: true });
  const db = c.env.DB;
  // History statements compare against the stored values, so they run first in the same transaction.
  await db.batch([
    ...poFieldChanges(db, id, b, c.get("user")),
    db.prepare(`UPDATE purchase_orders SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).bind(...binds, id),
  ]);
  return c.json({ ok: true });
});

// A note on a PO goes in that PO's history. A note on a shipment (or one of its
// containers) goes in the history of every PO on the shipment.
api.post("/notes", async (c) => {
  const b = await c.req.json<{ po_id?: number; shipment_id?: number; container_id?: number; body: string }>();
  const text = b.body?.trim();
  if (!text) return c.json({ error: "Empty note" }, 400);
  const db = c.env.DB;
  const actor = c.get("user");
  const container = b.container_id
    ? await db.prepare(`SELECT shipment_id, number FROM containers WHERE id = ?`).bind(b.container_id).first<{ shipment_id: number; number: string }>()
    : null;
  const shipmentId = b.shipment_id ?? container?.shipment_id ?? null;
  const entry = { kind: "note" as const, actor, body: text, shipment_id: shipmentId, container_number: container?.number ?? null };
  const stmts = [
    db.prepare(`INSERT INTO notes (po_id, shipment_id, container_id, author, body) VALUES (?, ?, ?, ?, ?)`)
      .bind(b.po_id ?? null, shipmentId, b.container_id ?? null, actor, text),
  ];
  if (b.po_id) stmts.push(addEntry(db, b.po_id, entry));
  else if (shipmentId) stmts.push(forShipmentPos(db, shipmentId, entry));
  await db.batch(stmts);
  return c.json({ ok: true }, 201);
});

// One-time: fill PO History for data that existed before it began. Safe to re-run.
api.post("/admin/backfill-history", async (c) => c.json({ ok: true, ...(await backfillHistory(c.env)) }));

// Manual triggers (handy for testing cron behaviour)
api.post("/admin/digest", async (c) => c.json({ sent: await sendDigest(c.env) }));
// Same as the 6-hourly cron: finish pending lookups, start new tracking, refresh, archive finished.
api.post("/admin/sync-all", async (c) => {
  if (!c.env.TIMETOCARGO_API_KEY) return c.json({ ok: false, message: "TIMETOCARGO_API_KEY is not configured" }, 400);
  try {
    const summary = await syncAll(c.env);
    const { results } = await c.env.DB.prepare(
      `SELECT COALESCE(tracking_status, 'not tracked') AS status, count(*) AS n FROM shipments
       WHERE status = 'active' AND mode = 'ocean' GROUP BY 1`,
    ).all<{ status: string; n: number }>();
    return c.json({ ok: true, message: `${summary}. Now: ${results.map((r) => `${r.n} ${r.status}`).join(", ")}` });
  } catch (e) {
    return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, 502);
  }
});
