import { Fragment, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { etdUrgency } from "../../shared/etd";
import { milestoneLabel } from "../../shared/milestones";
import { PAYMENT_LABELS } from "../../shared/normalize";
import { api } from "../api";

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    if (!path) return;
    setLoading(true);
    api
      .get<T>(path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [path]);
  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

/**
 * A container number as it is painted on the door: owner code, serial, and the
 * check digit in a box. Anything that isn't an ISO 6346 number is shown as typed.
 */
export function ContainerNumber({ number }: { number: string }) {
  const m = /^([A-Z]{4})(\d{6})(\d)$/.exec(number);
  if (!m) return <span className="font-mono">{number}</span>;
  return (
    <span className="whitespace-nowrap font-mono">
      {m[1]}
      <span className="ml-1">{m[2]}</span>
      <span className="ml-1 inline-block border border-current px-[2px] leading-tight">{m[3]}</span>
    </span>
  );
}

/** Shipments status-filter value (and `?milestone=` URL value) for POs with no shipment booked yet. */
export const AWAITING_BOOKING = "awaiting";

/** The stops a container passes on its way to ELM, in order. */
const TRACK_STOPS = ["Booked", "Loaded", "Departed", "Arrived", "Discharged", "Available", "Out-gated", "Delivered"];

/** Where each milestone sits on the track. Transshipment is still at sea; a hold sits at discharge. */
const TRACK_POSITION: Record<string, number> = {
  booked: 0,
  loaded: 1,
  departed: 2,
  transshipment: 2,
  arrived: 3,
  discharged: 4,
  on_hold: 4,
  available: 5,
  outgated: 6,
  delivered: 7,
  received: 7,
};

/**
 * A container's progress as a row of stops: filled up to where it is now, a ring on the
 * current stop (red if on hold), and the milestone name beside it.
 */
export function VoyageTrack({ milestone }: { milestone: string }) {
  const pos = TRACK_POSITION[milestone] ?? -1;
  const hold = milestone === "on_hold";
  const done = milestone === "received";
  const label = milestoneLabel(milestone);
  return (
    <span
      className="inline-flex items-center gap-2 whitespace-nowrap"
      role="img"
      aria-label={pos >= 0 ? `${label}, stage ${pos + 1} of ${TRACK_STOPS.length}` : label}
      title={TRACK_STOPS.map((s, i) => (i === pos ? `▸ ${s}` : s)).join("\n")}
    >
      <span className="flex items-center" aria-hidden>
        {TRACK_STOPS.map((s, i) => (
          <Fragment key={s}>
            {i > 0 && <span className={`w-2.5 ${i <= pos ? "h-0.5 bg-route" : "h-px bg-slate-300"}`} />}
            {i < pos || (done && i === pos) ? (
              <span className="size-2 rounded-full bg-route" />
            ) : i === pos ? (
              <span className={`size-2.5 rounded-full border-2 bg-white ${hold ? "border-hold" : "border-route"}`} />
            ) : (
              <span className="size-1.5 rounded-full bg-slate-300" />
            )}
          </Fragment>
        ))}
      </span>
      <span className={`text-xs font-medium ${hold ? "text-hold" : done ? "text-slate-500" : "text-slate-800"}`}>{label}</span>
    </span>
  );
}

/**
 * Current ETA with how far it has moved from the first published ETA.
 * Late by more than a day (the same rule as the email alerts) is flagged in hazard yellow.
 */
export function EtaWithSlip({ eta, first }: { eta: string | null | undefined; first: string | null | undefined }) {
  const slip = eta && first ? daysFrom(first.slice(0, 10), eta) : null;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {fmtDate(eta)}
      {slip ? (
        <span
          title={`First published ETA: ${fmtDate(first)}`}
          className={`rounded-sm px-1 text-[11px] font-semibold tabular-nums ${
            slip > 1 ? "bg-hazard text-slate-900" : "text-slate-600"
          }`}
        >
          {slip > 0 ? `+${slip}d` : `−${-slip}d`}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Small tag beside an unbooked PO's estimated ETD: hazard yellow when it's within a week,
 * hold red once it has passed. Shows nothing otherwise. Uses the date on this computer.
 */
export function EtdCue({ etd }: { etd: string | null | undefined }) {
  const u = etdUrgency(new Date().toLocaleDateString("en-CA"), etd);
  if (!u) return null;
  const text = u.level === "overdue" ? `${-u.days}d late` : u.days === 0 ? "today" : `in ${u.days}d`;
  return (
    <span
      title={u.level === "overdue" ? "Estimated departure has passed and the PO isn't booked yet" : "Estimated departure is within a week"}
      className={`rounded-sm px-1 text-[11px] font-semibold tabular-nums ${
        u.level === "overdue" ? "bg-hold text-white" : "bg-hazard text-slate-900"
      }`}
    >
      {text}
    </span>
  );
}

/** PO numbers as links to each PO's page. */
export function PoLinks({ pos, sep = ", " }: { pos: { id: number; po_number: string }[]; sep?: string }) {
  return (
    <>
      {pos.map((p, i) => (
        <Fragment key={p.id}>
          {i > 0 && sep}
          <Link to={`/pos/${p.id}`} className="text-route-dark hover:underline">{p.po_number}</Link>
        </Fragment>
      ))}
    </>
  );
}

export function PaymentBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const color =
    status === "paid"
      ? "text-emerald-700"
      : status === "deposit_paid"
        ? "text-amber-700"
        : status === "not_paid"
          ? "text-red-700"
          : "text-slate-500";
  return <span className={`text-xs font-medium ${color}`}>{PAYMENT_LABELS[status] ?? status}</span>;
}

export function fmtDate(s: string | null | undefined, withTime = false): string {
  if (!s) return "—";
  const [d, t] = s.replace(" ", "T").split("T");
  const [y, m, day] = d.split("-").map(Number);
  if (!y) return s;
  const out = new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: y !== new Date().getFullYear() ? "numeric" : undefined,
    timeZone: "UTC",
  });
  return withTime && t ? `${out} ${t.slice(0, 5)}` : out;
}

export function daysFrom(today: string, s: string | null | undefined): number | null {
  if (!s) return null;
  return Math.round((Date.parse(s.slice(0, 10)) - Date.parse(today)) / 86_400_000);
}

export function Holds({ holds }: { holds: string | null }) {
  if (!holds) return null;
  const list = JSON.parse(holds) as { name: string }[];
  return (
    <>
      {list.map((h) => (
        <span key={h.name} className="mr-1 rounded-sm bg-hold px-1.5 py-0.5 text-[11px] font-semibold text-white">
          {h.name} hold
        </span>
      ))}
    </>
  );
}

const TRACKING: Record<string, [string, string]> = {
  tracking: ["Live", "bg-emerald-500"],
  pending: ["Looking up…", "bg-amber-400"],
  failed: ["Tracking failed", "bg-red-500"],
  stopped: ["Tracking stopped", "bg-slate-400"],
  not_trackable: ["Not trackable", "bg-slate-300"],
};
const trackingOf = (status: string | null) => TRACKING[status ?? ""] ?? ["Not tracked", "bg-slate-300"];

/** Just the coloured dot (green Live, red failed); the label is its tooltip and screen-reader text. */
export function TrackingDot({ status, error }: { status: string | null; error?: string | null }) {
  const [label, dot] = trackingOf(status);
  return (
    <span className={`ml-1.5 inline-block size-2 shrink-0 rounded-full align-middle ${dot}`} title={error ? `${label}: ${error}` : label} role="img" aria-label={label} />
  );
}

export function TrackingStatus({ status, error }: { status: string | null; error?: string | null }) {
  const [label, dot] = trackingOf(status);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-600" title={error ?? undefined}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>;
}

/**
 * Click-to-edit date (or date+time) cell. Saves on Enter/blur, Esc cancels.
 * `value` is "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM".
 */
export function EditableDate({
  value,
  withTime = false,
  onSave,
  placeholder = "+ set",
}: {
  value: string | null | undefined;
  withTime?: boolean;
  onSave: (v: string | null) => Promise<void>;
  placeholder?: string;
}) {
  const current = value ? value.replace(" ", "T").slice(0, withTime ? 16 : 10) : "";
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(current);
  const [saving, setSaving] = useState(false);
  useEffect(() => setV(current), [current]);

  const commit = async () => {
    if (v === current) return setEditing(false);
    setSaving(true);
    try {
      await onSave(v || null);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  if (editing)
    return (
      <input
        autoFocus
        type={withTime ? "datetime-local" : "date"}
        className="input w-48 py-1 text-xs"
        value={v}
        disabled={saving}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setV(current);
            setEditing(false);
          }
        }}
      />
    );
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit"
      className={`min-h-6 rounded px-1 text-left hover:bg-route-50 focus-visible:outline-2 focus-visible:outline-route ${current ? "" : "text-xs text-route"}`}
    >
      {current ? fmtDate(current, withTime) : placeholder}
    </button>
  );
}

/** Click-to-edit text; saves on Enter or when focus leaves, Escape cancels. */
export function EditableText({ value, onSave, placeholder = "+ set", list }: { value: string | null; onSave: (v: string) => Promise<void>; placeholder?: string; list?: string }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);
  const commit = async () => {
    setEditing(false);
    if (v.trim() !== (value ?? "")) await onSave(v.trim());
  };
  if (editing)
    return (
      <input
        autoFocus
        list={list}
        className="input py-1 text-sm"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") (setV(value ?? ""), setEditing(false));
        }}
      />
    );
  return (
    <button type="button" onClick={() => setEditing(true)} title="Click to edit" className={`min-h-6 rounded px-1 text-left hover:bg-route-50 ${value ? "" : "text-xs text-route"}`}>
      {value || placeholder}
    </button>
  );
}
