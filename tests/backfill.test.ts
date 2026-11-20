import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { backfillHistory, isoUtc } from "../worker/lib/backfill";
import type { Env } from "../worker/env";
import { fakeD1, freshDb } from "./helpers/d1";

let db: DatabaseSync;
let env: Env;

const history = (poId: number) =>
  db
    .prepare(
      `SELECT kind, actor, field, old_value, new_value, container_number, occurred_at, recorded_at, body, pre_history
       FROM po_history WHERE po_id = ? ORDER BY recorded_at, id`,
    )
    .all(poId) as Record<string, unknown>[];

beforeEach(() => {
  db = freshDb();
  env = { DB: fakeD1(db) } as Env;
  db.exec(`
    INSERT INTO vendors (id, name) VALUES (1, 'Acme');
    INSERT INTO purchase_orders (id, po_number, vendor_id, payment_status, crd) VALUES
      (1, '5871ELM', 1, 'not_paid', '2026-09-01'), (2, '5872ELM', 1, 'paid', NULL), (3, '5873ELM', NULL, 'deposit_paid', NULL);
    INSERT INTO shipments (id, mbl, atd, created_at) VALUES (10, 'EGLV123', '2026-10-20T08:00:00', '2026-09-20 12:00:00');
    INSERT INTO shipment_pos (shipment_id, po_id) VALUES (10, 1), (10, 2);
    INSERT INTO containers (id, shipment_id, number, milestone) VALUES (100, 10, 'TGHU5303645', 'delivered');

    -- Old UI stamped shipment notes with the first PO's id as well
    INSERT INTO notes (id, po_id, shipment_id, author, body, created_at) VALUES
      (1, 1, 10, 'matp@x.com', 'Booked on EVER X', '2026-09-21 09:30:00'),
      (2, 3, NULL, 'avery@x.com', 'Vendor wants balance early', '2026-09-22 10:00:00'),
      (3, NULL, 10, 'carrier', 'ETA (first published) overwritten', '2026-10-02 06:00:00');
    INSERT INTO notes (id, container_id, author, body, created_at) VALUES (4, 100, NULL, 'Seal broken', '2026-11-14 08:00:00');

    INSERT INTO tracking_events (shipment_id, container_id, event, occurred_at, location, source, external_id, created_at) VALUES
      (10, 100, 'Gated in at origin port', '2026-10-15T09:00:00', 'Yantian, China', 'timetocargo', 'ttc:TGHU5303645:CGI:2026-10-15T09:00:00', '2026-10-16 06:00:00'),
      (10, 100, 'Loaded on vessel', '2026-10-19T10:00:00', 'Yantian, China · EVER X', 'timetocargo', 'ttc:TGHU5303645:CLL:2026-10-19T10:00:00', '2026-10-20 06:00:00'),
      (10, 100, 'Vessel departed origin', '2026-10-20T08:00:00', 'Yantian, China', 'timetocargo', 'ttc:TGHU5303645:VDL:2026-10-20T08:00:00', '2026-10-20 12:00:00'),
      (10, 100, 'Vessel arrived at destination port', '2026-11-12T08:00:00', 'Tacoma', 'timetocargo', 'ttc:TGHU5303645:VAD:2026-11-12T08:00:00', '2026-11-12 18:00:00'),
      (10, 100, 'Discharged at destination port', '2026-11-13T08:00:00', 'Tacoma', 'timetocargo', 'ttc:TGHU5303645:CDD:2026-11-13T08:00:00', '2026-11-13 18:00:00'),
      (10, 100, 'manual.delivered', '2026-11-18 15:00:00', NULL, 'manual', NULL, '2026-11-18 15:00:00');
  `);
});

describe("backfillHistory", () => {
  it("gives every PO an Imported entry with its values at go-live", async () => {
    await backfillHistory(env);
    const imported = history(3).find((h) => h.kind === "imported")!;
    expect(imported).toMatchObject({ actor: "system", pre_history: 0 });
    expect(JSON.parse(imported.body as string)).toEqual({ payment_status: "deposit_paid", status: "open" }); // empty fields left out
    expect(JSON.parse(history(1).find((h) => h.kind === "imported")!.body as string)).toMatchObject({ vendor: "Acme", crd: "2026-09-01" });
  });

  it("brings in links, notes and tracking as pre-history with their original times", async () => {
    await backfillHistory(env);
    const po1 = history(1).filter((h) => h.kind !== "imported");
    expect(po1.map((h) => [h.kind, h.actor, h.new_value ?? h.body, h.recorded_at])).toEqual([
      ["linked", "system", null, "2026-09-20T12:00:00.000Z"],
      ["note", "matp@x.com", "Booked on EVER X", "2026-09-21T09:30:00.000Z"],
      ["note", "Carrier tracking", "ETA (first published) overwritten", "2026-10-02T06:00:00.000Z"],
      ["tracking_event", "Carrier tracking", "Gated in at origin port · Yantian, China", "2026-10-16T06:00:00.000Z"],
      ["tracking_event", "Carrier tracking", "Loaded on vessel · Yantian, China · EVER X", "2026-10-20T06:00:00.000Z"],
      ["milestone", "Carrier tracking", "departed", "2026-10-20T12:00:00.000Z"],
      ["milestone", "Carrier tracking", "arrived", "2026-11-12T18:00:00.000Z"],
      ["milestone", "Carrier tracking", "discharged", "2026-11-13T18:00:00.000Z"],
      ["note", "unknown user", "Seal broken", "2026-11-14T08:00:00.000Z"],
      ["milestone", "unknown user", "delivered", "2026-11-18T15:00:00.000Z"],
    ]);
    expect(po1.every((h) => h.pre_history === 1)).toBe(true);
    expect(po1.find((h) => h.new_value === "departed")).toMatchObject({ old_value: null, occurred_at: "2026-10-20T08:00:00", container_number: "TGHU5303645" });
    expect(po1.find((h) => h.new_value === "arrived")).toMatchObject({ old_value: "departed" });
  });

  it("puts shipment notes on every PO on the shipment, and PO notes on that PO only", async () => {
    await backfillHistory(env);
    const notes = (po: number) => history(po).filter((h) => h.kind === "note").map((h) => h.body);
    expect(notes(2)).toEqual(["Booked on EVER X", "ETA (first published) overwritten", "Seal broken"]);
    expect(notes(3)).toEqual(["Vendor wants balance early"]);
  });

  it("adds nothing when run again", async () => {
    const first = await backfillHistory(env);
    const second = await backfillHistory(env);
    expect(second.history_entries_total).toBe(first.history_entries_total);
  });

  it("skips what was already logged live between deploy and backfill", async () => {
    // As written by the live app, moments after the note/link/milestone happened
    db.exec(`
      INSERT INTO po_history (po_id, actor, kind, body, shipment_id, recorded_at) VALUES
        (3, 'avery@x.com', 'note', 'Vendor wants balance early', NULL, '2026-09-22T10:00:00.412Z'),
        (1, 'matp@x.com', 'linked', NULL, 10, '2026-11-20T15:00:00.000Z');
      INSERT INTO po_history (po_id, actor, kind, field, new_value, container_number, shipment_id) VALUES
        (1, 'Carrier tracking', 'milestone', 'milestone', 'discharged', 'TGHU5303645', 10);
    `);
    const r = await backfillHistory(env);
    expect(r.skipped_already_logged).toBe(3);
    expect(history(3).filter((h) => h.kind === "note")).toHaveLength(1);
    expect(history(1).filter((h) => h.kind === "linked")).toHaveLength(1);
    expect(history(1).filter((h) => h.new_value === "discharged")).toHaveLength(1);
    expect(history(2).filter((h) => h.new_value === "discharged")).toHaveLength(1); // PO 2 still gets its own
  });

  it("does not duplicate tracking that live sync already logged", async () => {
    db.exec(`INSERT INTO po_history (po_id, actor, kind, dedupe_key) VALUES (1, 'Carrier tracking', 'tracking_event', 'ttc:TGHU5303645:CGI:2026-10-15T09:00:00:po1')`);
    await backfillHistory(env);
    expect(history(1).filter((h) => h.kind === "tracking_event")).toHaveLength(2);
  });
});

describe("isoUtc", () => {
  it("normalises SQLite timestamps", () => {
    expect(isoUtc("2026-11-20 13:05:00")).toBe("2026-11-20T13:05:00.000Z");
    expect(isoUtc("2026-11-20T13:05:00.123Z")).toBe("2026-11-20T13:05:00.123Z");
    expect(isoUtc(null)).toBeNull();
  });
});
