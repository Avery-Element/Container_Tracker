// Pallets: a per-container tick, logged in the PO History of every PO on the shipment.
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

const palletEntries = () =>
  db
    .prepare(`SELECT po_id, kind, actor, field, old_value, new_value, container_number FROM po_history WHERE field = 'pallets' ORDER BY id`)
    .all();

beforeEach(() => {
  db = freshDb();
  env = { DB: fakeD1(db), ALERT_FROM: "x", ALERT_TO: "", APP_URL: "http://localhost" } as Env;
  db.exec(`
    INSERT INTO vendors (id, name) VALUES (1, 'Acme');
    INSERT INTO purchase_orders (id, po_number, vendor_id, vendor_pi, forwarder) VALUES
      (1, '5871ELM', 1, 'PI-1', 'THI'), (2, '5872ELM', 1, 'PI-2', NULL);
    INSERT INTO shipments (id, mbl, eta, status) VALUES (10, 'EGLV123', '2026-12-01', 'active');
    INSERT INTO shipment_pos (shipment_id, po_id) VALUES (10, 1), (10, 2);
    INSERT INTO containers (id, shipment_id, number, milestone) VALUES (100, 10, 'TGHU5303645', 'arrived');
  `);
});

describe("Pallets", () => {
  it("starts unticked", () => {
    expect(db.prepare(`SELECT pallets FROM containers WHERE id = 100`).get()).toEqual({ pallets: 0 });
  });

  it("ticks and unticks, logging each change for every PO on the shipment", async () => {
    expect((await call("PATCH", "/containers/100", { pallets: true })).status).toBe(200);
    expect(db.prepare(`SELECT pallets FROM containers WHERE id = 100`).get()).toEqual({ pallets: 1 });
    const on = { kind: "container_changed", actor: USER, field: "pallets", old_value: "0", new_value: "1", container_number: "TGHU5303645" };
    expect(palletEntries()).toEqual([{ po_id: 1, ...on }, { po_id: 2, ...on }]);

    await call("PATCH", "/containers/100", { pallets: false });
    expect(db.prepare(`SELECT pallets FROM containers WHERE id = 100`).get()).toEqual({ pallets: 0 });
    expect(palletEntries().slice(2)).toMatchObject([
      { po_id: 1, old_value: "1", new_value: "0" },
      { po_id: 2, old_value: "1", new_value: "0" },
    ]);
  });

  it("logs nothing when the value doesn't change", async () => {
    await call("PATCH", "/containers/100", { pallets: false });
    expect(palletEntries()).toEqual([]);
  });

  it("returns pallets on containers, and each PO's PI and forwarder, in the shipment list", async () => {
    await call("PATCH", "/containers/100", { pallets: true });
    const [s] = (await call("GET", "/shipments")).json as { containers: Record<string, unknown>[]; pos: Record<string, unknown>[] }[];
    expect(s.containers[0]).toMatchObject({ pallets: 1 });
    expect(s.pos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ po_number: "5871ELM", vendor_pi: "PI-1", forwarder: "THI" }),
        expect.objectContaining({ po_number: "5872ELM", vendor_pi: "PI-2", forwarder: null }),
      ]),
    );
  });
});
