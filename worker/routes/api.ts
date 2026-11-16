import { Hono } from "hono";
import type { Env } from "../env";
import { checkPendingTasks, refreshAll, startTracking, stopTracking, syncAll } from "../lib/sync";
import { getBatch } from "../lib/timetocargo";
import { sendDigest } from "../lib/alerts";
import { normalizeContainerNumber, isValidContainerNumber } from "../../shared/container-number";
import { carrierByScac, carrierFromMbl } from "../../shared/carriers";
import { MILESTONE_ORDER } from "../../shared/milestones";

type Vars = { Variables: { user: string } };
export const api = new Hono<{ Bindings: Env } & Vars>();

const today = () => new Date().toISOString().slice(0, 10);

// Shipment list query reused by the dashboard and shipments page.
const SHIPMENT_SELECT = `
  SELECT s.*,
    (SELECT json_group_array(json_object('id', po.id, 'po_number', po.po_number, 'payment_status', po.payment_status, 'order_date', po.order_date))
       FROM shipment_pos sp JOIN purchase_orders po ON po.id = sp.po_id WHERE sp.shipment_id = s.id) AS pos_json,
    (SELECT v.name FROM shipment_pos sp JOIN purchase_orders po ON po.id = sp.po_id
       JOIN vendors v ON v.id = po.vendor_id WHERE sp.shipment_id = s.id LIMIT 1) AS vendor,
    (SELECT json_group_array(json_object('id', c.id, 'number', c.number, 'number_valid', c.number_valid,
        'milestone', c.milestone, 'eta', c.eta, 'original_eta', c.original_eta, 'holds', c.holds,
        'elm_delivery_appt', c.elm_delivery_appt, 'size', c.size, 'available', c.available))
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
  const s = await c.env.DB.prepare(
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
  for (const po of body.po_ids ?? [])
    await c.env.DB.prepare(`INSERT OR IGNORE INTO shipment_pos (shipment_id, po_id) VALUES (?, ?)`).bind(id, po).run();
  for (const raw of body.containers ?? []) {
    const n = normalizeContainerNumber(raw);
    if (!n) continue;
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO containers (shipment_id, number, number_valid, milestone, eta, original_eta, original_eta_source)
       VALUES (?1, ?2, ?3, 'booked', ?4, ?4, CASE WHEN ?4 IS NULL THEN NULL ELSE 'manual' END)`,
    )
      .bind(id, n, isValidContainerNumber(n) ? 1 : 0, body.eta || null)
      .run();
  }
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
  if (body.status === "received")
    await c.env.DB.prepare(
      `UPDATE containers SET milestone='received', received_at=COALESCE(received_at, date('now')) WHERE shipment_id=?`,
    )
      .bind(id)
      .run();
  await c.env.DB.prepare(`UPDATE shipments SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...binds, id)
    .run();
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
  await c.env.DB.prepare(`INSERT OR IGNORE INTO shipment_pos (shipment_id, po_id) VALUES (?, ?)`).bind(id, po_id).run();
  return c.json({ ok: true });
});

api.post("/shipments/:id/containers", async (c) => {
  const id = Number(c.req.param("id"));
  const { number } = await c.req.json<{ number: string }>();
  const n = normalizeContainerNumber(number ?? "");
  if (!/^[A-Z]{4}\d{6,8}$/.test(n)) return c.json({ error: "Container number should look like ABCU1234567" }, 400);
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO containers (shipment_id, number, number_valid, milestone, eta, original_eta, original_eta_source)
     SELECT ?, ?, ?, 'booked', eta, COALESCE(original_eta, eta),
       CASE WHEN original_eta IS NOT NULL THEN original_eta_source WHEN eta IS NOT NULL THEN 'manual' END
     FROM shipments WHERE id = ?`,
  )
    .bind(id, n, isValidContainerNumber(n) ? 1 : 0, id)
    .run();
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
  if (!sets.length) return c.json({ ok: true });
  await c.env.DB.prepare(`UPDATE containers SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...binds, id)
    .run();
  if (body.milestone) {
    await c.env.DB.prepare(
      `INSERT INTO tracking_events (shipment_id, container_id, event, occurred_at, source)
       SELECT shipment_id, id, ?, datetime('now'), 'manual' FROM containers WHERE id = ?`,
    )
      .bind(`manual.${body.milestone}`, id)
      .run();
    // close the shipment when every container is received
    await c.env.DB.prepare(
      `UPDATE shipments SET status = 'received' WHERE id = (SELECT shipment_id FROM containers WHERE id = ?)
       AND NOT EXISTS (SELECT 1 FROM containers WHERE shipment_id = shipments.id AND milestone != 'received')`,
    )
      .bind(id)
      .run();
    const closed = await c.env.DB.prepare(
      `SELECT s.id FROM shipments s JOIN containers c ON c.shipment_id = s.id WHERE c.id = ? AND s.status = 'received'`,
    )
      .bind(id)
      .first<{ id: number }>();
    if (closed) await stopTracking(c.env, closed.id);
  }
  return c.json({ ok: true });
});

api.delete("/containers/:id", async (c) => {
  await c.env.DB.prepare(`DELETE FROM containers WHERE id = ?`).bind(Number(c.req.param("id"))).run();
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
  const vid = await vendorId(c.env, b.vendor);
  try {
    const row = await c.env.DB.prepare(
      `INSERT INTO purchase_orders (po_number, vendor_id, vendor_pi, order_date, payment_status, forwarder, crd, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(
        num,
        vid,
        b.vendor_pi || null,
        b.order_date || today(),
        b.payment_status || null,
        b.forwarder || null,
        b.crd || null,
        b.description || null,
      )
      .first<{ id: number }>();
    return c.json({ id: row!.id }, 201);
  } catch (e) {
    return c.json({ error: `PO ${num} already exists` }, 409);
  }
});

const PO_FIELDS = ["vendor_pi", "order_date", "payment_status", "forwarder", "crd", "status", "description"] as const;
api.patch("/pos/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<Record<string, string | null>>();
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
  if (!sets.length) return c.json({ ok: true });
  await c.env.DB.prepare(`UPDATE purchase_orders SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...binds, id)
    .run();
  return c.json({ ok: true });
});

api.post("/notes", async (c) => {
  const b = await c.req.json<{ po_id?: number; shipment_id?: number; container_id?: number; body: string }>();
  if (!b.body?.trim()) return c.json({ error: "Empty note" }, 400);
  await c.env.DB.prepare(`INSERT INTO notes (po_id, shipment_id, container_id, author, body) VALUES (?, ?, ?, ?, ?)`)
    .bind(b.po_id ?? null, b.shipment_id ?? null, b.container_id ?? null, c.get("user"), b.body.trim())
    .run();
  return c.json({ ok: true }, 201);
});

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
