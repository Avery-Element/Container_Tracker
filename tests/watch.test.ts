// Watching: ticking a container or PO records who and when, unticking clears it,
// the lists return it, and it never adds PO History entries.
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { api } from "../worker/routes/api";
import type { Env } from "../worker/env";
import { fakeD1, freshDb } from "./helpers/d1";

let db: DatabaseSync;
let env: Env;
const USER = "avery@example.com";
const app = new Hono<{ Bindings: Env; Variables: { user: string } }>()
  .use(async (c, next) => {
    c.set("user", USER);
    await next();
  })
  .route("/", api);

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(
    path,
    { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined },
    env,
  );
  return { status: res.status, json: (await res.json()) as unknown };
};

const historyCount = () => (db.prepare(`SELECT count(*) AS n FROM po_history`).get() as { n: number }).n;

beforeEach(() => {
  db = freshDb();
  env = { DB: fakeD1(db), ALERT_FROM: "x", ALERT_TO: "", APP_URL: "http://localhost" } as Env;
  db.exec(`
    INSERT INTO vendors (id, name) VALUES (1, 'Acme');
    INSERT INTO purchase_orders (id, po_number, vendor_id, payment_status) VALUES (1, '5871ELM', 1, 'not_paid');
    INSERT INTO shipments (id, mbl, eta, status) VALUES (10, 'EGLV123', '2026-12-01', 'active');
    INSERT INTO shipment_pos (shipment_id, po_id) VALUES (10, 1);
    INSERT INTO containers (id, shipment_id, number, milestone) VALUES (100, 10, 'TGHU5303645', 'arrived');
  `);
});

describe("Watching", () => {
  it("ticks and unticks a container without touching PO History", async () => {
    expect((await call("PATCH", "/containers/100", { watched: true })).status).toBe(200);
    const on = db.prepare(`SELECT watched_by, watched_at, milestone FROM containers WHERE id = 100`).get() as Record<string, string>;
    expect(on.watched_by).toBe(USER);
    expect(on.watched_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(on.milestone).toBe("arrived");

    await call("PATCH", "/containers/100", { watched: false });
    expect(db.prepare(`SELECT watched_by, watched_at FROM containers WHERE id = 100`).get()).toEqual({ watched_by: null, watched_at: null });
    expect(historyCount()).toBe(0);
    expect(db.prepare(`SELECT count(*) AS n FROM tracking_events`).get()).toEqual({ n: 0 });
  });

  it("ticks and unticks a PO without touching PO History", async () => {
    await call("PATCH", "/pos/1", { watched: true });
    expect(db.prepare(`SELECT watched_by FROM purchase_orders WHERE id = 1`).get()).toEqual({ watched_by: USER });
    await call("PATCH", "/pos/1", { watched: false });
    expect(db.prepare(`SELECT watched_by, watched_at FROM purchase_orders WHERE id = 1`).get()).toEqual({ watched_by: null, watched_at: null });
    expect(historyCount()).toBe(0);
  });

  it("still logs other fields changed in the same save", async () => {
    await call("PATCH", "/pos/1", { watched: true, forwarder: "Flexport" });
    expect(db.prepare(`SELECT kind, field, new_value FROM po_history`).all()).toEqual([
      { kind: "field_changed", field: "forwarder", new_value: "Flexport" },
    ]);
  });

  it("returns the watch on containers and POs in the shipment list and the PO list", async () => {
    await call("PATCH", "/containers/100", { watched: true });
    await call("PATCH", "/pos/1", { watched: true });
    const [s] = (await call("GET", "/shipments")).json as { containers: Record<string, unknown>[]; pos: Record<string, unknown>[] }[];
    expect(s.containers[0]).toMatchObject({ watched_by: USER });
    expect(s.pos[0]).toMatchObject({ watched_by: USER });
    const [po] = (await call("GET", "/pos")).json as Record<string, unknown>[];
    expect(po).toMatchObject({ watched_by: USER });
  });
});
