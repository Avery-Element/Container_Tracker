// Drives the real API routes against an in-memory database and checks PO History.
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
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

const history = (poId: number) =>
  db
    .prepare(`SELECT kind, actor, field, old_value, new_value, shipment_id, shipment_label, container_number, body FROM po_history WHERE po_id = ? ORDER BY id`)
    .all(poId) as Record<string, unknown>[];

beforeEach(() => {
  db = freshDb();
  env = { DB: fakeD1(db), ALERT_FROM: "x", ALERT_TO: "", APP_URL: "http://localhost" } as Env;
  db.exec(`
    INSERT INTO vendors (id, name) VALUES (1, 'Acme');
    INSERT INTO purchase_orders (id, po_number, vendor_id, payment_status, crd) VALUES
      (1, '5871ELM', 1, 'not_paid', '2026-11-01'), (2, '5872ELM', 1, 'not_paid', NULL);
    INSERT INTO shipments (id, mbl, eta, status) VALUES (10, 'EGLV123', '2026-12-01', 'active');
    INSERT INTO shipment_pos (shipment_id, po_id) VALUES (10, 1), (10, 2);
    INSERT INTO containers (id, shipment_id, number, milestone) VALUES (100, 10, 'TGHU5303645', 'arrived'), (101, 10, 'MSCU1234566', 'arrived');
  `);
});

describe("POs", () => {
  it("logs creation with the starting values", async () => {
    const { status, json } = await call("POST", "/pos", { po_number: "5999elm", vendor: "Globex", payment_status: "not_paid", crd: "2026-12-10" });
    expect(status).toBe(201);
    const [e] = history(json.id as number);
    expect(e).toMatchObject({ kind: "created", actor: USER });
    expect(JSON.parse(e.body as string)).toMatchObject({ vendor: "Globex", payment_status: "not_paid", crd: "2026-12-10" });
  });

  it("logs nothing for a duplicate PO number", async () => {
    expect((await call("POST", "/pos", { po_number: "5871ELM" })).status).toBe(409);
    expect(db.prepare(`SELECT count(*) AS n FROM po_history`).get()).toEqual({ n: 0 });
  });

  it("logs each changed field, and nothing for unchanged ones", async () => {
    await call("PATCH", "/pos/1", { forwarder: "THI", crd: "2026-11-01", vendor: "Globex" });
    expect(history(1).map((e) => [e.field, e.old_value, e.new_value, e.actor])).toEqual([
      ["forwarder", null, "THI", USER],
      ["vendor", "Acme", "Globex", USER],
    ]);
  });
});

describe("payment", () => {
  it("logs status and date as two entries from one save", async () => {
    await call("PATCH", "/pos/1", { payment_status: "deposit_paid", deposit_paid_on: "2026-11-03" });
    expect(history(1).map((e) => [e.field, e.old_value, e.new_value])).toEqual([
      ["payment_status", "not_paid", "deposit_paid"],
      ["deposit_paid_on", null, "2026-11-03"],
    ]);
    expect(db.prepare(`SELECT payment_status, deposit_paid_on FROM purchase_orders WHERE id = 1`).get()).toEqual({
      payment_status: "deposit_paid",
      deposit_paid_on: "2026-11-03",
    });
  });

  it("rejects a status outside the fixed list and logs nothing", async () => {
    const res = await call("PATCH", "/pos/1", { payment_status: "half" });
    expect(res.status).toBe(400);
    expect(history(1)).toEqual([]);
  });

  it("stores the payment date on a new PO", async () => {
    const { json } = await call("POST", "/pos", { po_number: "6000ELM", payment_status: "paid", paid_on: "2026-11-10" });
    expect(db.prepare(`SELECT payment_status, paid_on FROM purchase_orders WHERE id = ?`).get(json.id as number)).toEqual({
      payment_status: "paid",
      paid_on: "2026-11-10",
    });
    expect(JSON.parse(history(json.id as number)[0].body as string)).toMatchObject({ payment_status: "paid", paid_on: "2026-11-10" });
  });
});

describe("notes", () => {
  it("puts a shipment note on every PO on the shipment", async () => {
    await call("POST", "/notes", { shipment_id: 10, body: "Booked on EVER X" });
    for (const po of [1, 2]) expect(history(po)).toMatchObject([{ kind: "note", body: "Booked on EVER X", shipment_label: "EGLV123" }]);
  });

  it("puts a PO note only on that PO", async () => {
    await call("POST", "/notes", { po_id: 2, body: "Vendor wants balance early" });
    expect(history(1)).toEqual([]);
    expect(history(2)).toMatchObject([{ kind: "note", actor: USER }]);
  });

  it("puts a container note on every PO with the container number", async () => {
    await call("POST", "/notes", { container_id: 100, body: "Seal broken" });
    expect(history(2)).toMatchObject([{ kind: "note", container_number: "TGHU5303645", shipment_id: 10 }]);
  });
});

describe("shipments", () => {
  it("logs linking on each PO at creation, listing the containers", async () => {
    const { json } = await call("POST", "/shipments", { po_ids: [1, 1], mbl: "cosu999", containers: ["tghu5303645"] });
    expect(history(1)).toMatchObject([{ kind: "linked", shipment_id: json.id, shipment_label: "COSU999", body: "Containers: TGHU5303645" }]);
  });

  it("logs linking a PO to an existing shipment once", async () => {
    db.exec(`INSERT INTO purchase_orders (id, po_number) VALUES (3, '5873ELM')`);
    await call("POST", "/shipments/10/pos", { po_id: 3 });
    await call("POST", "/shipments/10/pos", { po_id: 3 });
    expect(history(3)).toMatchObject([{ kind: "linked", shipment_label: "EGLV123" }]);
  });

  it("logs an ETA change only when the day changes", async () => {
    await call("PATCH", "/shipments/10", { eta: "2026-12-01" });
    await call("PATCH", "/shipments/10", { eta: "2026-12-05" });
    expect(history(1)).toMatchObject([{ kind: "eta_changed", old_value: "2026-12-01", new_value: "2026-12-05" }]);
  });

  it("logs status changes", async () => {
    await call("PATCH", "/shipments/10", { status: "cancelled" });
    expect(history(2)).toMatchObject([{ kind: "shipment_status", old_value: "active", new_value: "cancelled" }]);
  });

  it("keeps history and logs unlinking when a shipment is deleted", async () => {
    await call("POST", "/notes", { shipment_id: 10, body: "hello" });
    await call("DELETE", "/shipments/10");
    expect(history(1).map((e) => [e.kind, e.shipment_label, e.body])).toEqual([
      ["note", "EGLV123", "hello"],
      ["unlinked", "EGLV123", "Shipment deleted"],
    ]);
  });
});

describe("containers", () => {
  it("logs containers added and removed", async () => {
    await call("POST", "/shipments/10/containers", { number: "OOLU1234560" });
    await call("POST", "/shipments/10/containers", { number: "OOLU1234560" }); // already there
    const added = db.prepare(`SELECT id FROM containers WHERE number = 'OOLU1234560'`).get() as { id: number };
    await call("DELETE", `/containers/${added.id}`);
    expect(history(1).map((e) => [e.kind, e.container_number])).toEqual([
      ["container_added", "OOLU1234560"],
      ["container_removed", "OOLU1234560"],
    ]);
  });

  it("logs delivery appointment changes but not size", async () => {
    await call("PATCH", "/containers/100", { elm_delivery_appt: "2026-12-08", size: "40HQ" });
    expect(history(1)).toMatchObject([
      { kind: "container_changed", field: "elm_delivery_appt", old_value: null, new_value: "2026-12-08", container_number: "TGHU5303645" },
    ]);
  });

  it("logs a manual milestone, the received date, and the shipment closing", async () => {
    await call("PATCH", "/containers/100", { milestone: "received", received_at: "2026-12-09" });
    expect(history(1).map((e) => [e.kind, e.field, e.new_value])).toEqual([
      ["milestone", "milestone", "received"],
      ["container_changed", "received_at", "2026-12-09"],
    ]);
    await call("PATCH", "/containers/101", { milestone: "received", received_at: "2026-12-09" });
    expect(history(1).at(-1)).toMatchObject({ kind: "shipment_status", old_value: "active", new_value: "received", actor: USER });
    expect(db.prepare(`SELECT status FROM shipments WHERE id = 10`).get()).toEqual({ status: "received" });
  });
});
