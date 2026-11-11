import { useCallback, useEffect, useState } from "react";
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

const MILESTONE_STYLES: Record<string, string> = {
  po_placed: "bg-slate-100 text-slate-700",
  cargo_ready: "bg-slate-100 text-slate-700",
  booked: "bg-sky-50 text-sky-700",
  loaded: "bg-sky-100 text-sky-800",
  departed: "bg-blue-100 text-blue-800",
  transshipment: "bg-indigo-100 text-indigo-800",
  arrived: "bg-violet-100 text-violet-800",
  discharged: "bg-amber-100 text-amber-800",
  on_hold: "bg-red-100 text-red-800",
  available: "bg-emerald-100 text-emerald-800",
  outgated: "bg-teal-100 text-teal-800",
  delivered: "bg-teal-200 text-teal-900",
  received: "bg-slate-200 text-slate-600",
};

export function MilestoneBadge({ milestone }: { milestone: string }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${
        MILESTONE_STYLES[milestone] ?? "bg-slate-100 text-slate-700"
      }`}
    >
      {milestoneLabel(milestone)}
    </span>
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
        <span key={h.name} className="mr-1 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
          {h.name} hold
        </span>
      ))}
    </>
  );
}

export function TrackingStatus({ status, error }: { status: string | null; error?: string | null }) {
  const map: Record<string, [string, string]> = {
    tracking: ["Live", "bg-emerald-500"],
    pending: ["Looking up…", "bg-amber-400"],
    failed: ["Tracking failed", "bg-red-500"],
    stopped: ["Tracking stopped", "bg-slate-400"],
    not_trackable: ["Not trackable", "bg-slate-300"],
  };
  const [label, dot] = map[status ?? ""] ?? ["Not tracked", "bg-slate-300"];
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
      className={`rounded px-1 text-left hover:bg-teal-50 ${current ? "" : "text-xs text-teal-700"}`}
    >
      {current ? fmtDate(current, withTime) : placeholder}
    </button>
  );
}
