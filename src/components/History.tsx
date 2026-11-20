// Renders History Entries (PO History). Used by the PO page and the Activity Feed.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { HistoryEntry } from "../api";
import { milestoneLabel } from "../../shared/milestones";
import { PAYMENT_LABELS } from "../../shared/normalize";
import { fmtDate } from "./ui";

const FIELD_LABELS: Record<string, string> = {
  vendor: "Vendor",
  vendor_pi: "Vendor PI #",
  order_date: "Order date",
  payment_status: "Payment status",
  deposit_paid_on: "Deposit paid date",
  paid_on: "Paid date",
  forwarder: "Forwarder",
  crd: "Cargo ready date",
  status: "Status",
  description: "Products / notes",
  eta: "ETA",
  elm_delivery_appt: "ELM delivery appointment",
  received_at: "Received date",
  milestone: "Milestone",
};

const DATE_FIELDS = new Set(["order_date", "deposit_paid_on", "paid_on", "crd", "eta", "received_at"]);
const PO_STATUS: Record<string, string> = { open: "Awaiting booking", received: "PO received", cancelled: "PO cancelled" };
const SHIPMENT_STATUS: Record<string, string> = { active: "Active", received: "Received", cancelled: "Cancelled" };

/** Types of change, for filters and labels. Tracking kinds are grouped separately. */
export const HISTORY_KINDS: Record<string, string> = {
  created: "PO created",
  imported: "Imported",
  field_changed: "PO field changed",
  linked: "Linked to shipment",
  unlinked: "Unlinked from shipment",
  note: "Note",
  eta_changed: "ETA changed",
  container_added: "Container added",
  container_removed: "Container removed",
  container_changed: "Container changed",
  shipment_status: "Shipment status",
  tracking_started: "Tracking started",
  tracking_failed: "Tracking failed",
  tracking_event: "Carrier event",
  milestone: "Milestone",
};
export const TRACKING_KINDS = new Set(["tracking_event", "milestone"]);

/** "Nov 20, 2026, 2:14 PM" in the viewer's own time zone. */
export function fmtTimestamp(iso: string): string {
  return new Date(normalizeUtc(iso)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Stored times are UTC; older ones may lack the "Z". */
const normalizeUtc = (s: string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);

function fmtValue(field: string | null, kind: string, v: string | null): string {
  if (v === null || v === "") return "(empty)";
  if (field === "payment_status") return PAYMENT_LABELS[v] ?? v;
  if (field === "milestone") return milestoneLabel(v);
  if (field === "status") return (kind === "shipment_status" ? SHIPMENT_STATUS : PO_STATUS)[v] ?? v;
  if (field && DATE_FIELDS.has(field)) return fmtDate(v);
  if (field === "elm_delivery_appt") return fmtDate(v, v.length > 10);
  return v;
}

function Change({ e }: { e: HistoryEntry }) {
  return (
    <>
      <span className="text-slate-500 line-through decoration-slate-300">{fmtValue(e.field, e.kind, e.old_value)}</span>
      {" → "}
      <span className="font-medium">{fmtValue(e.field, e.kind, e.new_value)}</span>
    </>
  );
}

function Snapshot({ json }: { json: string | null }) {
  if (!json) return null;
  let values: Record<string, string>;
  try {
    values = JSON.parse(json);
  } catch {
    return null;
  }
  return (
    <span className="text-slate-500">
      {Object.entries(values)
        .map(([k, v]) => `${FIELD_LABELS[k] ?? k}: ${fmtValue(k, "created", v)}`)
        .join(" · ")}
    </span>
  );
}

/** What the entry says, as one line of text and markup. */
export function describe(e: HistoryEntry): ReactNode {
  const field = FIELD_LABELS[e.field ?? ""] ?? e.field;
  switch (e.kind) {
    case "created":
      return <>Created the PO. <Snapshot json={e.body} /></>;
    case "imported":
      return <>PO History began. Values at that time: <Snapshot json={e.body} /></>;
    case "field_changed":
      return <>{field}: <Change e={e} /></>;
    case "linked":
      return <>Linked to shipment{e.body && <span className="text-slate-500"> · {e.body}</span>}</>;
    case "unlinked":
      return <>Unlinked from shipment{e.body && <span className="text-slate-500"> ({e.body.toLowerCase()})</span>}</>;
    case "note":
      return <span className="whitespace-pre-line">“{e.body}”</span>;
    case "eta_changed":
      return <>ETA: <Change e={e} /></>;
    case "container_added":
      return <>Container added</>;
    case "container_removed":
      return <>Container removed</>;
    case "container_changed":
      return <>{field}: <Change e={e} /></>;
    case "shipment_status":
      return <>Shipment status: <Change e={e} />{e.body && <span className="text-slate-500"> · {e.body}</span>}</>;
    case "tracking_started":
      return <>Live tracking started</>;
    case "tracking_failed":
      return <>Tracking failed<span className="text-slate-500">: {e.body}</span></>;
    case "tracking_event":
      return <>{e.body}</>;
    case "milestone":
      return e.old_value ? <Change e={e} /> : <>Reached <span className="font-medium">{milestoneLabel(e.new_value ?? "")}</span></>;
    default:
      return <>{HISTORY_KINDS[e.kind] ?? e.kind}{e.body && `: ${e.body}`}</>;
  }
}

/** Shipment and container chips: what the entry is about. */
export function Subject({ e }: { e: HistoryEntry }) {
  return (
    <>
      {e.shipment_label &&
        (e.shipment_exists && e.shipment_id ? (
          <Link to={`/shipments/${e.shipment_id}`} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-teal-800 hover:underline">
            {e.shipment_label}
          </Link>
        ) : (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500" title="This shipment has since been deleted">
            {e.shipment_label}
          </span>
        ))}
      {e.container_number && (
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">{e.container_number}</span>
      )}
    </>
  );
}

/** Who did it. */
export function Actor({ actor }: { actor: string }) {
  const machine = actor === "Carrier tracking" || actor === "system";
  return <span className={machine ? "italic text-slate-500" : "text-slate-700"}>{actor}</span>;
}

/** A PO's history as a timeline, newest day first, grouped by day in the viewer's time zone. */
export function HistoryTimeline({ entries }: { entries: HistoryEntry[] }) {
  if (!entries.length) return <p className="text-sm text-slate-500">Nothing recorded yet.</p>;
  const days = new Map<string, HistoryEntry[]>();
  for (const e of [...entries].reverse()) {
    const day = new Date(normalizeUtc(e.recorded_at)).toLocaleDateString(undefined, { dateStyle: "full" });
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  return (
    <div className="space-y-5">
      {[...days].map(([day, list]) => (
        <section key={day}>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{day}</h3>
          <ol className="space-y-1.5 border-l border-slate-200 pl-4">
            {list.map((e) => {
              const tracking = TRACKING_KINDS.has(e.kind);
              return (
                <li key={e.id} className={`relative text-sm ${tracking ? "text-slate-600" : ""}`}>
                  <span className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ${tracking ? "bg-slate-300" : "bg-teal-600"}`} />
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <time className="w-16 shrink-0 text-xs tabular-nums text-slate-500" dateTime={e.recorded_at} title={fmtTimestamp(e.recorded_at)}>
                      {new Date(normalizeUtc(e.recorded_at)).toLocaleTimeString(undefined, { timeStyle: "short" })}
                    </time>
                    <span className="min-w-0">{describe(e)}</span>
                    <Subject e={e} />
                    {e.pre_history ? (
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800" title="Recorded before PO History began">
                        before history
                      </span>
                    ) : null}
                  </div>
                  <div className="pl-[4.5rem] text-xs text-slate-500">
                    <Actor actor={e.actor} />
                    {e.occurred_at && <> · occurred {fmtDate(e.occurred_at, e.occurred_at.length > 10)}</>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
