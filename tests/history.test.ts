import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { addEntry, CARRIER, forShipmentPos, poFieldChanges } from "../worker/lib/history";
import { fakeD1, freshDb } from "./helpers/d1";

let db: DatabaseSync;
let d1: D1Database;

const rows = (poId?: number) =>
  db
    .prepare(`SELECT * FROM po_history ${poId ? "WHERE po_id = ?" : ""} ORDER BY id`)
    .all(...(poId ? [poId] : [])) as Record<string, unknown>[];

beforeEach(() => {
  db = freshDb();
  d1 = fakeD1(db);
  db.exec(`
    INSERT INTO vendors (id, name) VALUES (1, 'Acme'), (2, 'Globex');
    INSERT INTO purchase_orders (id, po_number, vendor_id, payment_status, crd)
      VALUES (1, '5871ELM', 1, 'not_paid', '2026-11-01'), (2, '5872ELM', 1, 'not_paid', NULL), (3, '5873ELM', 2, 'paid', NULL);
    INSERT INTO shipments (id, mbl, reference) VALUES (10, 'EGLV123', NULL), (11, NULL, NULL);
    INSERT INTO shipment_pos (shipment_id, po_id) VALUES (10, 1), (10, 2);
  `);
});

describe("append-only", () => {
  beforeEach(async () => {
    await addEntry(d1, 1, { kind: "note", actor: "a@x.com", body: "hello" }).run();
  });

  it("rejects updates", () => {
    expect(() => db.exec(`UPDATE po_history SET body = 'edited'`)).toThrow(/append-only/);
  });

  it("rejects deletes", () => {
    expect(() => db.exec(`DELETE FROM po_history`)).toThrow(/append-only/);
  });

  it("stops a PO with history from being deleted", () => {
    expect(() => db.exec(`DELETE FROM purchase_orders WHERE id = 1`)).toThrow(/FOREIGN KEY/);
  });

  it("stamps recorded_at as a UTC ISO timestamp", () => {
    expect(rows(1)[0].recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("poFieldChanges", () => {
  const apply = async (patch: Record<string, string | null>, actor = "a@x.com") =>
    d1.batch([
      ...poFieldChanges(d1, 1, patch, actor),
      d1.prepare(`UPDATE purchase_orders SET payment_status = COALESCE(?, payment_status), deposit_paid_on = COALESCE(?, deposit_paid_on), crd = ? WHERE id = 1`)
        .bind(patch.payment_status ?? null, patch.deposit_paid_on ?? null, "crd" in patch ? (patch.crd || null) : "2026-11-01"),
    ]);

  it("writes one entry per changed field with old and new values", async () => {
    await apply({ payment_status: "deposit_paid", deposit_paid_on: "2026-11-03", crd: "2026-11-15" });
    expect(rows(1).map((r) => [r.field, r.old_value, r.new_value, r.actor, r.kind])).toEqual([
      ["payment_status", "not_paid", "deposit_paid", "a@x.com", "field_changed"],
      ["deposit_paid_on", null, "2026-11-03", "a@x.com", "field_changed"],
      ["crd", "2026-11-01", "2026-11-15", "a@x.com", "field_changed"],
    ]);
  });

  it("writes nothing when the value is unchanged", async () => {
    await apply({ payment_status: "not_paid", crd: "2026-11-01" });
    expect(rows()).toEqual([]);
  });

  it("treats an empty string as clearing the field", async () => {
    await apply({ crd: "" });
    expect(rows(1).map((r) => [r.field, r.old_value, r.new_value])).toEqual([["crd", "2026-11-01", null]]);
  });

  it("logs the vendor by name", async () => {
    await d1.batch(poFieldChanges(d1, 1, { vendor: " Globex " }, "a@x.com"));
    await d1.batch(poFieldChanges(d1, 1, { vendor: "Acme" }, "a@x.com")); // unchanged
    expect(rows(1).map((r) => [r.field, r.old_value, r.new_value])).toEqual([["vendor", "Acme", "Globex"]]);
  });

  it("ignores fields that are not PO fields", () => {
    expect(poFieldChanges(d1, 1, { "crd; DROP TABLE po_history": "x" }, "a@x.com")).toEqual([]);
  });

  it("saves nothing if the change itself fails", async () => {
    await expect(
      d1.batch([...poFieldChanges(d1, 1, { crd: "2026-12-01" }, "a@x.com"), d1.prepare(`UPDATE nope SET x = 1`)]),
    ).rejects.toThrow();
    expect(rows()).toEqual([]);
  });
});

describe("forShipmentPos", () => {
  it("writes the entry on every PO linked to the shipment, with the shipment label", async () => {
    await forShipmentPos(d1, 10, { kind: "note", actor: "a@x.com", body: "Booked on EVER X" }).run();
    expect(rows().map((r) => [r.po_id, r.shipment_id, r.shipment_label, r.body])).toEqual([
      [1, 10, "EGLV123", "Booked on EVER X"],
      [2, 10, "EGLV123", "Booked on EVER X"],
    ]);
  });

  it("falls back to #id when the shipment has no MBL or reference", async () => {
    db.exec(`INSERT INTO shipment_pos (shipment_id, po_id) VALUES (11, 3)`);
    await forShipmentPos(d1, 11, { kind: "note", actor: "a@x.com", body: "x" }).run();
    expect(rows(3)[0].shipment_label).toBe("#11");
  });

  it("is idempotent per PO when given a dedupe key", async () => {
    const e = { kind: "tracking_event" as const, actor: CARRIER, body: "Loaded on vessel", dedupe_key: "ttc:TGHU1:CLL:2026-10-20" };
    await forShipmentPos(d1, 10, e).run();
    await forShipmentPos(d1, 10, e).run();
    expect(rows().map((r) => r.dedupe_key)).toEqual(["ttc:TGHU1:CLL:2026-10-20:po1", "ttc:TGHU1:CLL:2026-10-20:po2"]);
  });

  it("keeps the label after the shipment is deleted", async () => {
    await d1.batch([
      forShipmentPos(d1, 10, { kind: "unlinked", actor: "a@x.com", body: "Shipment deleted" }),
      d1.prepare(`DELETE FROM shipment_pos WHERE shipment_id = 10`),
      d1.prepare(`DELETE FROM shipments WHERE id = 10`),
    ]);
    expect(rows().map((r) => [r.po_id, r.kind, r.shipment_label])).toEqual([
      [1, "unlinked", "EGLV123"],
      [2, "unlinked", "EGLV123"],
    ]);
  });
});
