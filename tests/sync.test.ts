import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyTracking } from "../worker/lib/sync";
import { verifyWebhookSignature, type TtcEvent, type TtcTrackingData } from "../worker/lib/timetocargo";
import type { Env } from "../worker/env";
import { fakeD1, freshDb } from "./helpers/d1";

let db: DatabaseSync;
let env: Env;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  db = freshDb();
  db.exec(`INSERT INTO shipments (id, mode, carrier_scac, mbl, eta, status) VALUES (1, 'ocean', 'EGLV', 'EGLV1', '2026-11-20', 'active');
           INSERT INTO containers (id, shipment_id, number, milestone, eta) VALUES (1, 1, 'TGHU5303645', 'departed', '2026-11-20');`);
  env = { DB: fakeD1(db), ALERT_FROM: "x", ALERT_TO: "", APP_URL: "http://localhost" } as Env;
});

const ev = (status_code: string, date: string, actual: boolean, extra: Partial<TtcEvent> = {}): TtcEvent => ({
  location: status_code.startsWith("V") && status_code !== "VDL" ? 1 : 0,
  terminal: null,
  status: null,
  status_code,
  date,
  actual,
  vessel: "EVER X",
  voyage: "001E",
  ...extra,
});

function data(events: TtcEvent[], status: TtcTrackingData["shipment_status"] = "IN_TRANSIT"): TtcTrackingData {
  return {
    summary: {
      pol: { location: 0, terminal: null, date: "2026-10-20T00:00:00" },
      pod: { location: 1, terminal: 0, date: events.find((e) => e.status_code === "VAD")?.date ?? null },
    },
    locations: [
      { id: 0, name: "Yantian", state: null, country: "China" },
      { id: 1, name: "Tacoma", state: "WA", country: "United States" },
    ],
    terminals: [{ id: 0, name: "Husky Terminal" }],
    containers: [{ number: "TGHU5303645", type: "40' High Cube Dry", iso_code: "45G1", events }],
    shipment_status: status,
    references: { booking_numbers: [], bill_of_lading_numbers: ["EGLV1"] },
  };
}

const departed = [ev("CLL", "2026-10-19T10:00:00", true), ev("VDL", "2026-10-20T08:00:00", true)];
const alerts = () => db.prepare("SELECT kind, message FROM alerts ORDER BY id").all() as { kind: string; message: string }[];
const container = () => db.prepare("SELECT * FROM containers WHERE id = 1").get() as Record<string, unknown>;

describe("applyTracking (TimeToCargo)", () => {
  it("first sync: fills shipment + container, records events, no ETA alert", async () => {
    await applyTracking(env, 1, data([...departed, ev("VAD", "2026-11-12T08:00:00", false)]));
    const s = db.prepare("SELECT pol, pod, vessel, atd, eta, tracking_status FROM shipments WHERE id=1").get();
    expect(s).toEqual({
      pol: "Yantian, China",
      pod: "Tacoma, United States",
      vessel: "EVER X",
      atd: "2026-10-20T08:00:00",
      eta: "2026-11-12T08:00:00",
      tracking_status: "tracking",
    });
    expect(container()).toMatchObject({ milestone: "departed", size: "40HQ", terminal: "Husky Terminal" });
    expect(container().first_synced_at).toBeTruthy();
    expect(alerts()).toEqual([]);
    const events = db.prepare("SELECT event FROM tracking_events ORDER BY occurred_at").all();
    expect(events).toEqual([{ event: "Loaded on vessel" }, { event: "Vessel departed origin" }]);
  });

  it("alerts on ETA slip and discharge, dedupes repeats, advances milestones", async () => {
    await applyTracking(env, 1, data([...departed, ev("VAD", "2026-11-12T08:00:00", false)]));
    await applyTracking(env, 1, data([...departed, ev("VAD", "2026-11-16T08:00:00", false)]));
    await applyTracking(env, 1, data([...departed, ev("VAD", "2026-11-16T08:00:00", false)]));
    expect(alerts().map((a) => a.kind)).toEqual(["eta_change"]);
    expect(alerts()[0].message).toContain("slipped 2026-11-12 → 2026-11-16");

    const arrived = [...departed, ev("VAD", "2026-11-16T10:00:00", true), ev("CDD", "2026-11-17T09:00:00", true)];
    await applyTracking(env, 1, data(arrived));
    expect(container()).toMatchObject({ milestone: "discharged", discharged_at: "2026-11-17T09:00:00" });
    expect(alerts().map((a) => a.kind)).toEqual(["eta_change", "discharged"]);

    await applyTracking(env, 1, data([...arrived, ev("CGO", "2026-11-19T09:00:00", true)], "DELIVERED"));
    expect(container()).toMatchObject({ milestone: "outgated", outgated_at: "2026-11-19T09:00:00" });
  });

  it("handles carriers with no VDL/VAD events (Evergreen-style, real payload shape)", async () => {
    const d = data([
      ev("CLT", "2026-10-28T00:00:00", true, { location: 2, vessel: "EVER SIGMA", voyage: "0499-144E" }),
      ev("CDT", "2026-10-15T00:00:00", true, { location: 2, vessel: "EVER BEFIT" }),
      ev("CLL", "2026-10-09T00:00:00", true, { vessel: "EVER BEFIT" }),
      ev("CGI", "2026-10-05T00:00:00", true, { vessel: null, voyage: null }),
    ]);
    d.summary!.pod!.date = "2026-11-23T00:00:00";
    d.summary!.pol!.date = "2026-10-09T00:00:00";
    await applyTracking(env, 1, d);
    const s = db.prepare("SELECT vessel, voyage, atd, eta FROM shipments WHERE id=1").get();
    expect(s).toEqual({ vessel: "EVER SIGMA", voyage: "0499-144E", atd: "2026-10-09T00:00:00", eta: "2026-11-23T00:00:00" });
    expect(container().milestone).toBe("transshipment");
  });

  it("ignores an origin gate-out before arrival", async () => {
    await applyTracking(env, 1, data([ev("CGO", "2026-10-18T09:00:00", true), ...departed]));
    expect(container().milestone).toBe("departed");
  });

  describe("ETA (first published)", () => {
    const first = () => ({
      ship: db.prepare("SELECT original_eta, original_eta_source FROM shipments WHERE id=1").get(),
      cont: db.prepare("SELECT original_eta, original_eta_source FROM containers WHERE id=1").get(),
    });
    const notes = () => db.prepare("SELECT author, body FROM notes").all() as { author: string; body: string }[];

    it("is set from the carrier's first ETA and then stays fixed", async () => {
      await applyTracking(env, 1, data([...departed, ev("VAD", "2026-11-12T08:00:00", false)]));
      await applyTracking(env, 1, data([...departed, ev("VAD", "2026-11-16T08:00:00", false)]));
      const fixed = { original_eta: "2026-11-12T08:00:00", original_eta_source: "carrier" };
      expect(first()).toEqual({ ship: fixed, cont: fixed });
      expect(notes()).toEqual([]);
    });

    it("carrier replaces a manually entered value once, with a note", async () => {
      db.exec(`UPDATE shipments SET original_eta = '2026-11-01', original_eta_source = 'manual' WHERE id = 1;
               UPDATE containers SET original_eta = '2026-11-01', original_eta_source = 'manual' WHERE id = 1;`);
      await applyTracking(env, 1, data([...departed, ev("VAD", "2026-11-12T08:00:00", false)]));
      await applyTracking(env, 1, data([...departed, ev("VAD", "2026-11-16T08:00:00", false)]));
      const fixed = { original_eta: "2026-11-12T08:00:00", original_eta_source: "carrier" };
      expect(first()).toEqual({ ship: fixed, cont: fixed });
      expect(notes()).toEqual([
        {
          author: "carrier",
          body: "ETA (first published) overwritten by carrier: was Nov 1, 2026 (entered manually), now Nov 12, 2026.",
        },
      ]);
    });

    it("no note when the manual date already matches the carrier's", async () => {
      db.exec(`UPDATE shipments SET original_eta = '2026-11-12', original_eta_source = 'manual' WHERE id = 1;`);
      await applyTracking(env, 1, data([...departed, ev("VAD", "2026-11-12T08:00:00", false)]));
      expect(first().ship).toEqual({ original_eta: "2026-11-12T08:00:00", original_eta_source: "carrier" });
      expect(notes()).toEqual([]);
    });
  });

  it("never overrides manual delivered/received", async () => {
    db.exec("UPDATE containers SET milestone = 'received' WHERE id = 1");
    await applyTracking(env, 1, data([...departed, ev("CDD", "2026-11-17T09:00:00", true)]));
    expect(container().milestone).toBe("received");
  });
});

describe("webhook signature", () => {
  const secret = "abcDEF123_-abcDEF123_-";
  const body = '{"id":"evt_1","type":"tracking.test"}';
  const ts = "1794000000";
  const now = 1794000000 * 1000;
  const hex = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

  it("accepts a valid sha256= signature", async () => {
    expect(await verifyWebhookSignature(secret, body, `sha256=${hex}`, ts, now)).toBe(true);
  });
  it("rejects tampered body, wrong secret, or stale timestamp", async () => {
    expect(await verifyWebhookSignature(secret, body + " ", `sha256=${hex}`, ts, now)).toBe(false);
    expect(await verifyWebhookSignature("other", body, `sha256=${hex}`, ts, now)).toBe(false);
    expect(await verifyWebhookSignature(secret, body, `sha256=${hex}`, ts, now + 60 * 60_000)).toBe(false);
  });
});
