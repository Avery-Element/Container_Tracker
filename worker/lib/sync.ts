// Keeps local shipments/containers in step with TimeToCargo.
//
// Flow: startTracking() creates a batch task -> checkPendingTasks() reads the
// results and stores TimeToCargo tracking ids -> refreshAll() pulls the latest
// data for every active tracking in one list call (cron, webhooks, buttons).

import type { Env } from "../env";
import {
  archive,
  createBatch,
  getBatch,
  listActive,
  TtcError,
  type BatchItem,
  type TtcEvent,
  type TtcTrackingData,
} from "./timetocargo";
import { planTracking, ttcCompany } from "../../shared/carriers";
import { isValidContainerNumber } from "../../shared/container-number";
import { advanceMilestone, MILESTONE_ORDER, MILESTONES, TTC_EVENTS } from "../../shared/milestones";
import { raiseAlerts, type NewAlert } from "./alerts";
import { AFTER_DEPARTURE, isOriginEvent, isVoyageMilestone } from "../../shared/history";
import { CARRIER, forShipmentPos, type HistoryEntry } from "./history";

/** Write one History Entry on every PO of a shipment, as "Carrier tracking". */
const logForPos = (env: Env, shipmentId: number, e: Omit<HistoryEntry, "actor">) =>
  forShipmentPos(env.DB, shipmentId, { actor: CARRIER, ...e }).run();

interface ShipmentRow {
  id: number;
  mode: string;
  status: string;
  mbl: string | null;
  carrier_scac: string | null;
  tracking_ids: string | null;
  tracking_task_id: string | null;
  tracking_status: string | null;
}

interface ContainerRow {
  id: number;
  number: string;
  milestone: string;
  eta: string | null;
  original_eta: string | null;
  original_eta_source: string | null;
  discharged_at: string | null;
  first_synced_at: string | null;
}

const MANUAL_FINAL = new Set(["delivered", "received"]);

const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : null);

const noteDate = (s: string) =>
  new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * "ETA (first published)": the carrier's first ETA wins over a manually entered one,
 * then never changes. Returns the value/source to store and, if a manual date was
 * replaced by a different carrier date, the replaced value.
 */
function firstPublished(
  prev: { original_eta: string | null; original_eta_source: string | null },
  carrierEta: string | null,
) {
  if (!carrierEta || (prev.original_eta && prev.original_eta_source !== "manual"))
    return { value: prev.original_eta, source: prev.original_eta_source, replaced: null };
  const replaced = prev.original_eta && day(prev.original_eta) !== day(carrierEta) ? prev.original_eta : null;
  return { value: carrierEta, source: "carrier", replaced };
}

export function parseIds(json: string | null): string[] {
  try {
    return json ? (JSON.parse(json) as string[]) : [];
  } catch {
    return [];
  }
}

function requireKey(env: Env): string {
  if (!env.TIMETOCARGO_API_KEY) throw new TtcError("TIMETOCARGO_API_KEY is not configured", "NO_KEY");
  return env.TIMETOCARGO_API_KEY;
}

async function containerNumbers(env: Env, shipmentId: number) {
  const { results } = await env.DB.prepare(`SELECT number FROM containers WHERE shipment_id = ?`)
    .bind(shipmentId)
    .all<{ number: string }>();
  return results.map((r) => r.number);
}

// ---------------------------------------------------------------- start

/** Create TimeToCargo tracking for one or more shipments (one batch task). */
export async function startTracking(
  env: Env,
  shipmentIds: number[],
): Promise<{ ok: boolean; message: string; taskId?: string }> {
  const key = requireKey(env);
  const items: BatchItem[] = [];
  const queued: number[] = [];
  const skipped: string[] = [];

  for (const id of shipmentIds) {
    const s = await env.DB.prepare(`SELECT * FROM shipments WHERE id = ?`).bind(id).first<ShipmentRow>();
    if (!s || s.mode !== "ocean") continue;
    const plan = planTracking({
      mbl: s.mbl,
      scac: s.carrier_scac,
      containers: (await containerNumbers(env, id)).filter(isValidContainerNumber),
    });
    if (plan.type === "none") {
      await env.DB.prepare(`UPDATE shipments SET tracking_status='not_trackable', tracking_error=? WHERE id=?`)
        .bind(plan.reason, id)
        .run();
      await logForPos(env, id, { kind: "tracking_failed", body: plan.reason, dedupe_key: `trfail:${id}:none:${plan.reason}` });
      skipped.push(`#${id}: ${plan.reason}`);
      continue;
    }
    const company = ttcCompany(plan.scac);
    if (plan.type === "bill_of_lading") items.push({ company, value: plan.number, type: "bl" });
    else for (const n of plan.numbers) items.push({ company, value: n, type: "container" });
    queued.push(id);
  }

  if (!items.length) return { ok: false, message: skipped.join("; ") || "Nothing to track" };

  let taskId: string;
  try {
    taskId = await createBatch(key, items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of queued) {
      await env.DB.prepare(`UPDATE shipments SET tracking_status='failed', tracking_error=? WHERE id=?`)
        .bind(msg, id)
        .run();
      await logForPos(env, id, { kind: "tracking_failed", body: msg });
    }
    return { ok: false, message: msg };
  }
  for (const id of queued)
    await env.DB.prepare(
      `UPDATE shipments SET tracking_task_id=?, tracking_status='pending', tracking_error=NULL, updated_at=datetime('now') WHERE id=?`,
    )
      .bind(taskId, id)
      .run();
  return {
    ok: true,
    taskId,
    message: `Tracking requested for ${queued.length} shipment(s), ${items.length} number(s)${skipped.length ? `; skipped ${skipped.length}` : ""}`,
  };
}

// ---------------------------------------------------------------- pending tasks

/** Read finished batch tasks and attach the results to their shipments. */
export async function checkPendingTasks(env: Env): Promise<number> {
  const key = requireKey(env);
  const { results: pending } = await env.DB.prepare(
    `SELECT * FROM shipments WHERE tracking_status='pending' AND tracking_task_id IS NOT NULL`,
  ).all<ShipmentRow & { updated_at: string }>();
  const byTask = new Map<string, typeof pending>();
  for (const s of pending) byTask.set(s.tracking_task_id!, [...(byTask.get(s.tracking_task_id!) ?? []), s]);

  let done = 0;
  for (const [taskId, ships] of byTask) {
    let task;
    try {
      task = await getBatch(key, taskId);
    } catch (e) {
      // Task data is only cached ~6h; if it's gone, queue the shipments again.
      console.error(`batch ${taskId}:`, e);
      if (e instanceof TtcError && e.status === "WRONG_PARAMS")
        for (const s of ships)
          await env.DB.prepare(`UPDATE shipments SET tracking_status=NULL, tracking_task_id=NULL WHERE id=?`)
            .bind(s.id)
            .run();
      continue;
    }
    if (!task || task.status !== "PROCESSED") continue;

    for (const s of ships) {
      const numbers = new Set([s.mbl?.toUpperCase(), ...(await containerNumbers(env, s.id))].filter(Boolean));
      const mine = (task.results ?? []).filter((r) => numbers.has(r.request?.track_number.value.toUpperCase()));
      const ok = mine.filter((r) => r.status === "OK" && r.data);
      if (ok.length) {
        const ids = new Set(parseIds(s.tracking_ids));
        for (const r of ok) if (r.data!.tracking_metadata?.id) ids.add(r.data!.tracking_metadata.id);
        await env.DB.prepare(`UPDATE shipments SET tracking_ids=?, tracking_task_id=NULL, tracking_status='tracking' WHERE id=?`)
          .bind(JSON.stringify([...ids]), s.id)
          .run();
        // Only the first time tracking starts for this shipment, not every re-request.
        await logForPos(env, s.id, { kind: "tracking_started", dedupe_key: `trstart:${s.id}` });
        for (const r of ok) await applyTracking(env, s.id, r.data!);
      } else {
        const reason =
          mine.map((r) => `${r.request?.track_number.value}: ${r.status_description ?? r.status}`).join("; ") ||
          "Carrier returned no data";
        await env.DB.prepare(`UPDATE shipments SET tracking_status='failed', tracking_error=?, tracking_task_id=NULL WHERE id=?`)
          .bind(reason, s.id)
          .run();
        await logForPos(env, s.id, { kind: "tracking_failed", body: reason, dedupe_key: `trfail:${s.id}:${taskId}` });
        await raiseAlerts(env, [
          {
            shipmentId: s.id,
            containerId: null,
            kind: "tracking_failed",
            message: `Tracking failed for ${s.mbl ?? `shipment #${s.id}`}: ${reason}`,
            dedupeKey: `trfail:${s.id}:${taskId}`,
          },
        ]);
      }
      done++;
    }
  }
  return done;
}

// ---------------------------------------------------------------- refresh

/** Pull the latest data for every active TimeToCargo tracking (one list call). */
export async function refreshAll(env: Env): Promise<number> {
  const key = requireKey(env);
  const items = await listActive(key);
  const { results: ships } = await env.DB.prepare(
    `SELECT s.id, s.mbl, s.tracking_ids, (SELECT group_concat(number) FROM containers WHERE shipment_id = s.id) AS numbers
     FROM shipments s WHERE s.tracking_status = 'tracking' AND s.status = 'active'`,
  ).all<{ id: number; mbl: string | null; tracking_ids: string | null; numbers: string | null }>();

  let updated = 0;
  for (const item of items) {
    const value = (item.track_number ?? item.tracked_item?.track_number ?? "").toUpperCase();
    const s =
      ships.find((x) => parseIds(x.tracking_ids).includes(item.id)) ??
      ships.find((x) => x.mbl?.toUpperCase() === value || (x.numbers ?? "").split(",").includes(value));
    const payload = item.tracked_item?.data;
    if (!s || !payload || payload.status !== "OK" || !payload.data) continue;
    await applyTracking(env, s.id, payload.data);
    updated++;
  }
  return updated;
}

// ---------------------------------------------------------------- apply

function sizeFrom(iso: string | null | undefined, type: string | null): string | null {
  if (iso) {
    if (iso.startsWith("2")) return "20GP";
    if (iso.startsWith("45") || iso.startsWith("4H")) return "40HQ";
    if (iso.startsWith("4")) return "40GP";
  }
  if (type && /high cube/i.test(type)) return type.includes("45") ? "45HQ" : "40HQ";
  if (type && /20/.test(type)) return "20GP";
  if (type && /40/.test(type)) return "40GP";
  return null;
}

/**
 * Voyage Milestones a container passed going from `from` to `to`, with when each was
 * reached. Includes `to` itself, and Departed when the vessel has sailed; skips steps
 * with no evidence (e.g. no transshipment on a direct sailing). A hold <-> available
 * swap is just the one step.
 */
function milestonesPassed(from: string, to: string, actual: TtcEvent[], departedAt: string | null) {
  const reachedAt = (m: string) =>
    actual
      .filter((e) => TTC_EVENTS[e.status_code!]?.milestone === m)
      // e.g. an origin gate-out (CGO) must not count as reaching "Out-gated" at destination
      .filter((e) => m === "departed" || !departedAt || e.date! >= departedAt)
      .map((e) => e.date!)
      .sort()[0] ?? (m === "departed" ? departedAt : null);
  const lo = MILESTONE_ORDER[from] ?? -1;
  const hi = MILESTONE_ORDER[to] ?? -1;
  if (hi <= lo) return isVoyageMilestone(to) ? [{ milestone: to, at: reachedAt(to) }] : [];
  return MILESTONES.filter((m) => {
    const o = MILESTONE_ORDER[m.key];
    if (o <= lo || o > hi || !isVoyageMilestone(m.key)) return false;
    return m.key === to || reachedAt(m.key) !== null;
  }).map((m) => ({ milestone: m.key as string, at: reachedAt(m.key) }));
}

/** Write one TimeToCargo tracking result into our tables and raise alerts for changes. */
export async function applyTracking(env: Env, shipmentId: number, d: TtcTrackingData) {
  const loc = (i: number | null | undefined) => {
    if (i === null || i === undefined) return null;
    const l = d.locations?.find((x) => x.id === i);
    return l ? [l.name, l.country].filter(Boolean).join(", ") : null;
  };
  const terminal = (i: number | null | undefined) =>
    i === null || i === undefined ? null : (d.terminals?.find((t) => t.id === i)?.name ?? null);

  const events = (d.containers ?? []).flatMap((c) => c.events ?? []);
  const byCode = (code: string) =>
    events.filter((e) => e.status_code === code && e.date).sort((a, b) => a.date!.localeCompare(b.date!));
  const vad = byCode("VAD").at(-1);
  const vdl = byCode("VDL")[0];
  const podDate = d.summary?.pod?.date ?? null;

  const ata = vad?.actual ? vad.date : null;
  const eta = vad?.date ?? podDate;
  // Some carriers (e.g. Evergreen) send no VDL event; if anything has happened
  // after loading at origin, the vessel has sailed on the summary POL date.
  const sailed = events.some((e) => e.actual && AFTER_DEPARTURE.includes(e.status_code ?? ""));
  const etd = vdl?.date ?? d.summary?.pol?.date ?? null;
  const atd = vdl?.actual ? vdl.date : sailed ? etd : null;
  // Current vessel = latest actual event with a vessel (later legs after transshipment), else the arrival leg.
  const byDateDesc = [...events].filter((e) => e.date).sort((a, b) => b.date!.localeCompare(a.date!));
  const withVessel = byDateDesc.find((e) => e.actual && e.vessel) ?? (vad?.vessel ? vad : byDateDesc.find((e) => e.vessel));
  const alerts: NewAlert[] = [];
  // Manually entered first-published ETAs replaced by the carrier's: "from|to" -> container numbers.
  const overwritten = new Map<string, string[]>();
  const noteOverwrite = (from: string, to: string, label: string) => {
    const k = `${day(from)}|${day(to)}`;
    overwritten.set(k, [...(overwritten.get(k) ?? []), label]);
  };

  const prevShip = (await env.DB.prepare(`SELECT eta, original_eta, original_eta_source FROM shipments WHERE id = ?`)
    .bind(shipmentId)
    .first<{ eta: string | null; original_eta: string | null; original_eta_source: string | null }>()) ?? {
    eta: null,
    original_eta: null,
    original_eta_source: null,
  };
  const shipFirst = firstPublished(prevShip, eta);
  if (shipFirst.replaced) noteOverwrite(shipFirst.replaced, eta!, "shipment");

  await env.DB.prepare(
    `UPDATE shipments SET pol=COALESCE(?, pol), pod=COALESCE(?, pod), vessel=COALESCE(?, vessel), voyage=COALESCE(?, voyage),
       etd=COALESCE(?, etd), atd=?, eta=COALESCE(?, eta), original_eta=?, original_eta_source=?, ata=?,
       tracking_status='tracking', tracking_error=NULL, last_synced_at=datetime('now'), updated_at=datetime('now')
     WHERE id=?`,
  )
    .bind(
      loc(d.summary?.pol?.location),
      loc(d.summary?.pod?.location),
      withVessel?.vessel ?? null,
      withVessel?.voyage ?? null,
      etd,
      atd,
      eta,
      shipFirst.value,
      shipFirst.source,
      ata,
      shipmentId,
    )
    .run();

  // Shipment ETA, logged only when the day changes (container ETAs are not logged).
  if (eta && day(eta) !== day(prevShip.eta))
    await logForPos(env, shipmentId, { kind: "eta_changed", field: "eta", old_value: day(prevShip.eta), new_value: day(eta) });

  if (d.shipment_status === "STUCK")
    alerts.push({
      shipmentId,
      containerId: null,
      kind: "eta_change",
      message: `Shipment #${shipmentId}: carrier reports the shipment as delayed/stuck`,
      dedupeKey: `stuck:${shipmentId}:${day(new Date().toISOString())}`,
    });

  const { results: existing } = await env.DB.prepare(
    `SELECT id, number, milestone, eta, original_eta, original_eta_source, discharged_at, first_synced_at
     FROM containers WHERE shipment_id = ?`,
  )
    .bind(shipmentId)
    .all<ContainerRow>();

  for (const c of d.containers ?? []) {
    const number = c.number.toUpperCase();
    let row = existing.find((e) => e.number === number);
    if (!row) {
      const ins = await env.DB.prepare(
        `INSERT INTO containers (shipment_id, number, number_valid, milestone) VALUES (?, ?, ?, 'booked') RETURNING id`,
      )
        .bind(shipmentId, number, isValidContainerNumber(number) ? 1 : 0)
        .first<{ id: number }>();
      row = {
        id: ins!.id,
        number,
        milestone: "booked",
        eta: null,
        original_eta: null,
        original_eta_source: null,
        discharged_at: null,
        first_synced_at: null,
      };
      await logForPos(env, shipmentId, { kind: "container_added", container_number: number });
    }

    const actual = (c.events ?? []).filter((e) => e.actual && e.date && e.status_code);
    const arrived = actual.some((e) => e.status_code === "VAD" || e.status_code === "CDD");
    let derived = "booked";
    for (const e of actual) {
      const m = TTC_EVENTS[e.status_code!]?.milestone;
      if (!m) continue;
      if (e.status_code === "CGO" && !arrived) continue; // origin gate-out, not destination
      if ((MILESTONE_ORDER[m] ?? -1) > (MILESTONE_ORDER[derived] ?? -1)) derived = m;
    }
    if (sailed && (MILESTONE_ORDER[derived] ?? -1) < (MILESTONE_ORDER.departed ?? 0)) derived = "departed";
    const last = (code: string) =>
      actual.filter((e) => e.status_code === code).sort((a, b) => a.date!.localeCompare(b.date!)).at(-1)?.date ?? null;
    const cVad = (c.events ?? []).filter((e) => e.status_code === "VAD" && e.date).at(0);
    const cEta = cVad?.date ?? eta;
    const cAta = last("VAD");
    const discharged = last("CDD");
    const outgated = arrived ? (last("CGO") ?? last("CDC")) : last("CDC");
    const milestone = MANUAL_FINAL.has(row.milestone) ? row.milestone : advanceMilestone(row.milestone, derived);
    const first = firstPublished(row, cEta);
    if (first.replaced) noteOverwrite(first.replaced, cEta!, number);

    await env.DB.prepare(
      `UPDATE containers SET milestone=?, eta=COALESCE(?, eta), original_eta=?, original_eta_source=?, ata=?,
         discharged_at=?, outgated_at=COALESCE(?, outgated_at), empty_returned_at=?, terminal=COALESCE(?, terminal),
         size=COALESCE(?, size), first_synced_at=COALESCE(first_synced_at, datetime('now')), updated_at=datetime('now')
       WHERE id=?`,
    )
      .bind(
        milestone,
        cEta,
        first.value,
        first.source,
        cAta,
        discharged,
        outgated,
        last("CER"),
        terminal(d.summary?.pod?.terminal),
        sizeFrom(c.iso_code, c.type),
        row.id,
      )
      .run();

    // Event history for the timeline (actual events only, deduped).
    for (const e of actual) {
      const label = TTC_EVENTS[e.status_code!]?.label ?? e.status ?? e.status_code;
      const location = [loc(e.location), e.vessel].filter(Boolean).join(" · ") || null;
      const key = `ttc:${number}:${e.status_code}:${e.date}`;
      const ins = await env.DB.prepare(
        `INSERT OR IGNORE INTO tracking_events (shipment_id, container_id, event, occurred_at, location, source, external_id)
         VALUES (?, ?, ?, ?, ?, 'timetocargo', ?)`,
      )
        .bind(shipmentId, row.id, label, e.date, location, key)
        .run();
      // PO History: every new raw event up to Origin departure; after that, Milestone changes only.
      if (ins.meta.changes && isOriginEvent(e.status_code, e.date, atd))
        await logForPos(env, shipmentId, {
          kind: "tracking_event",
          container_number: number,
          occurred_at: e.date,
          body: [label, location].filter(Boolean).join(" · "),
          dedupe_key: key,
        });
    }

    // One entry per voyage Milestone passed, in order, even when one sync jumps several
    // steps (so "Departed" is never skipped).
    if (milestone !== row.milestone) {
      let from = row.milestone;
      for (const step of milestonesPassed(row.milestone, milestone, actual, atd)) {
        await logForPos(env, shipmentId, {
          kind: "milestone",
          field: "milestone",
          container_number: number,
          old_value: from,
          new_value: step.milestone,
          occurred_at: step.at,
        });
        from = step.milestone;
      }
    }

    // ---- change detection -> alerts
    // The spreadsheet ETA is often the warehouse date, so skip ETA alerts on a
    // container's first sync and only alert on carrier-to-carrier changes.
    const oldEta = day(row.eta);
    const newEta = day(cEta);
    if (row.first_synced_at && !cAta && oldEta && newEta && Math.abs(Date.parse(newEta) - Date.parse(oldEta)) > 86_400_000) {
      alerts.push({
        shipmentId,
        containerId: row.id,
        kind: "eta_change",
        message: `${number}: ETA ${newEta > oldEta ? "slipped" : "moved up"} ${oldEta} → ${newEta}`,
        dedupeKey: `eta:${row.id}:${newEta}`,
      });
    }
    if (!row.discharged_at && discharged) {
      alerts.push({
        shipmentId,
        containerId: row.id,
        kind: "discharged",
        message: `${number}: discharged at ${loc(d.summary?.pod?.location) ?? "port"} on ${day(discharged)}`,
        dedupeKey: `discharged:${row.id}`,
      });
    }
  }

  if (overwritten.size) {
    const lines = [...overwritten].map(([k, labels]) => {
      const [from, to] = k.split("|");
      const which = overwritten.size > 1 ? ` (${labels.filter((l) => l !== "shipment").join(", ") || "shipment"})` : "";
      return `ETA (first published) overwritten by carrier${which}: was ${noteDate(from)} (entered manually), now ${noteDate(to)}.`;
    });
    await env.DB.prepare(`INSERT INTO notes (shipment_id, author, body) VALUES (?, 'carrier', ?)`)
      .bind(shipmentId, lines.join("\n"))
      .run();
    await logForPos(env, shipmentId, { kind: "note", body: lines.join("\n") });
  }

  if (alerts.length) await raiseAlerts(env, alerts);
}

// ---------------------------------------------------------------- stop

/** Archive TimeToCargo tracking for a finished shipment (stops monthly billing). */
export async function stopTracking(env: Env, shipmentId: number) {
  if (!env.TIMETOCARGO_API_KEY) return;
  const s = await env.DB.prepare(`SELECT tracking_ids FROM shipments WHERE id = ?`)
    .bind(shipmentId)
    .first<{ tracking_ids: string | null }>();
  const ids = parseIds(s?.tracking_ids ?? null);
  try {
    await archive(env.TIMETOCARGO_API_KEY, ids);
    await env.DB.prepare(`UPDATE shipments SET tracking_status='stopped' WHERE id=?`).bind(shipmentId).run();
  } catch (e) {
    console.error(`archive #${shipmentId} failed`, e);
  }
}

// ---------------------------------------------------------------- webhook

export interface TtcWebhook {
  id: string;
  type: string;
  resource: { tracked_item_id: string; track_number: { type: string; value: string } | null } | null;
  data: { tracking_status?: string; tracking_status_description?: string | null } | null;
}

export async function handleWebhook(env: Env, body: TtcWebhook, raw: string) {
  const ins = await env.DB.prepare(`INSERT OR IGNORE INTO webhook_events (id, type, payload) VALUES (?, ?, ?)`)
    .bind(body.id, body.type, raw.slice(0, 50_000))
    .run();
  if (ins.meta.changes === 0) return { duplicate: true, type: body.type };

  if (body.type === "tracking.info_not_found") {
    const value = body.resource?.track_number?.value?.toUpperCase();
    if (value) {
      const s = await env.DB.prepare(
        `SELECT s.id FROM shipments s WHERE s.status='active' AND (upper(s.mbl) = ?1
           OR EXISTS (SELECT 1 FROM containers c WHERE c.shipment_id = s.id AND c.number = ?1))`,
      )
        .bind(value)
        .first<{ id: number }>();
      if (s) {
        const reason = `${value}: ${body.data?.tracking_status_description ?? body.data?.tracking_status ?? "not found"}`;
        await env.DB.prepare(`UPDATE shipments SET tracking_status='failed', tracking_error=? WHERE id=?`)
          .bind(reason, s.id)
          .run();
        await logForPos(env, s.id, { kind: "tracking_failed", body: reason, dedupe_key: `trfail:${s.id}:${body.id}` });
      }
    }
    return { type: body.type };
  }
  if (["tracking.eta_update", "tracking.history_update", "tracking.info_found", "tracking.delivered"].includes(body.type)) {
    await checkPendingTasks(env);
    await refreshAll(env);
  }
  return { type: body.type };
}

// ---------------------------------------------------------------- cron

/** Cron / "Sync tracking": finish pending tasks, start new tracking, refresh all, stop finished. */
export async function syncAll(env: Env): Promise<string> {
  if (!env.TIMETOCARGO_API_KEY) return "TIMETOCARGO_API_KEY not set";
  const notes: string[] = [];

  // Stop tracking shipments we've closed locally.
  const { results: finished } = await env.DB.prepare(
    `SELECT id FROM shipments WHERE status != 'active' AND tracking_status IN ('tracking','pending')`,
  ).all<{ id: number }>();
  for (const s of finished) await stopTracking(env, s.id);

  await checkPendingTasks(env);

  const { results: untracked } = await env.DB.prepare(
    `SELECT id FROM shipments WHERE status='active' AND mode='ocean' AND tracking_status IS NULL LIMIT 200`,
  ).all<{ id: number }>();
  if (untracked.length) {
    const started = await startTracking(env, untracked.map((s) => s.id));
    notes.push(started.message);
    // Lookups usually finish within a minute; wait briefly so one click/run collects them.
    if (started.taskId) {
      for (let i = 0; i < 9; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const task = await getBatch(env.TIMETOCARGO_API_KEY, started.taskId).catch(() => null);
        if (task?.status === "PROCESSED") break;
      }
      await checkPendingTasks(env);
    }
  }

  notes.push(`${await refreshAll(env)} updated`);
  if (finished.length) notes.push(`${finished.length} finished shipment(s) archived`);
  return notes.join("; ");
}
