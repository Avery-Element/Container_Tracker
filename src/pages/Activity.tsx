// Activity Feed: History Entries across all POs, with filters and CSV export.
// Filters live in the URL, so a filtered view can be bookmarked or shared.
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type HistoryEntry } from "../api";
import { Actor, describe, fmtTimestamp, HISTORY_KINDS, Subject, TRACKING_KINDS } from "../components/History";
import { ErrorBox, fmtDate, useApi } from "../components/ui";
import { localToday } from "../components/NewPoForm";

/** "What changed" choices. A value is a history kind, optionally ":field". */
const TYPE_OPTIONS: { label: string; options: [string, string][] }[] = [
  {
    label: "Payment",
    options: [
      ["field_changed:payment_status", "Payment status changes"],
      ["field_changed:deposit_paid_on", "Deposit paid date changes"],
      ["field_changed:paid_on", "Paid date changes"],
    ],
  },
  {
    label: "PO",
    options: [
      ["created", HISTORY_KINDS.created],
      ["field_changed", "Any PO field change"],
      ["field_changed:crd", "Cargo ready date changes"],
      ["field_changed:etd", "ETD changes"],
      ["field_changed:status", "PO status changes"],
      ["note", "Notes"],
      ["imported", HISTORY_KINDS.imported],
    ],
  },
  {
    label: "Shipments",
    options: (["linked", "unlinked", "eta_changed", "shipment_status", "container_added", "container_removed", "container_changed", "tracking_started", "tracking_failed"] as const).map(
      (k) => [k, HISTORY_KINDS[k]] as [string, string],
    ),
  },
  { label: "Carrier tracking", options: [["tracking_event", HISTORY_KINDS.tracking_event], ["milestone", "Milestones"]] },
];

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("en-CA");
};
/** Local calendar day -> the exact UTC instant it starts. */
const startOfDay = (day: string) => new Date(`${day}T00:00:00`).toISOString();
const nextDay = (day: string) => {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
};

const PAGE = 200;

export default function Activity() {
  const [params, setParams] = useSearchParams();
  const { data: actors } = useApi<string[]>("/history/actors");
  const { data: vendors } = useApi<{ id: number; name: string }[]>("/vendors");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // An absent "from" means the default (last 30 days); an empty one means "any time".
  const from = params.has("from") ? params.get("from")! : daysAgo(30);
  const to = params.get("to") ?? "";
  const type = params.get("type") ?? "";
  const tracking = params.get("tracking") === "1";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (k === "from") next.set("from", v);
    else if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  /** Query string for the API, shared by the feed and the CSV link. */
  const query = useMemo(() => {
    const q = new URLSearchParams();
    const [kind, field] = type.split(":");
    if (kind) q.set("type", kind);
    if (field) q.set("field", field);
    if (tracking) q.set("tracking", "1");
    for (const k of ["actor", "vendor", "po"]) if (params.get(k)) q.set(k, params.get(k)!);
    if (from) q.set("from", startOfDay(from));
    if (to) q.set("to", nextDay(to));
    return q.toString();
  }, [params, type, tracking, from, to]);

  const load = async (offset: number) => {
    setLoading(true);
    try {
      const r = await api.get<{ entries: HistoryEntry[]; has_more: boolean }>(`/history?${query}&limit=${PAGE}&offset=${offset}`);
      setEntries((prev) => (offset ? [...prev, ...r.entries] : r.entries));
      setHasMore(r.has_more);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const csvHref = `/api/history.csv?${query}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`;
  const trackingType = TRACKING_KINDS.has(type.split(":")[0]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold">Activity</h1>
        <span className="text-sm text-slate-500">Everything recorded in PO History, newest first</span>
        <a href={csvHref} className="btn ml-auto" download>
          Export CSV
        </a>
      </div>

      <section className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
        <label className="lg:col-span-2">
          <span className="label">What changed</span>
          <select className="input" value={type} onChange={(e) => set("type", e.target.value)}>
            <option value="">All changes</option>
            {TYPE_OPTIONS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Who</span>
          <select className="input" value={params.get("actor") ?? ""} onChange={(e) => set("actor", e.target.value)}>
            <option value="">Anyone</option>
            {actors?.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label>
          <span className="label">Vendor</span>
          <select className="input" value={params.get("vendor") ?? ""} onChange={(e) => set("vendor", e.target.value)}>
            <option value="">Any vendor</option>
            {vendors?.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
          </select>
        </label>
        <label>
          <span className="label">PO #</span>
          <input className="input" placeholder="e.g. 5871" defaultValue={params.get("po") ?? ""} onKeyDown={(e) => e.key === "Enter" && set("po", e.currentTarget.value.trim())} onBlur={(e) => set("po", e.target.value.trim())} />
        </label>
        <div className="flex items-end">
          <label className="flex items-center gap-1.5 pb-2 text-sm text-slate-600" title={trackingType ? "Shown because a tracking type is picked" : undefined}>
            <input type="checkbox" checked={tracking || trackingType} disabled={trackingType} onChange={(e) => set("tracking", e.target.checked ? "1" : "")} />
            Include carrier tracking
          </label>
        </div>
        <label>
          <span className="label">From</span>
          <input type="date" className="input" value={from} max={to || localToday()} onChange={(e) => set("from", e.target.value)} />
        </label>
        <label>
          <span className="label">To</span>
          <input type="date" className="input" value={to} min={from || undefined} max={localToday()} onChange={(e) => set("to", e.target.value)} />
        </label>
        <div className="flex items-end gap-2 pb-1 text-xs lg:col-span-4">
          {[
            ["Last 7 days", daysAgo(7)],
            ["Last 30 days", daysAgo(30)],
            ["This month", localToday().slice(0, 8) + "01"],
            ["Any time", ""],
          ].map(([l, d]) => (
            <button key={l} type="button" className="rounded px-2 py-1 text-route hover:bg-route-50" onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.set("from", d); n.delete("to"); return n; }, { replace: true })}>
              {l}
            </button>
          ))}
          {[...params.keys()].length > 0 && (
            <button type="button" className="ml-auto rounded px-2 py-1 text-slate-500 hover:bg-slate-100" onClick={() => setParams({}, { replace: true })}>
              Clear filters
            </button>
          )}
        </div>
      </section>

      <ErrorBox error={error} />

      <section className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs font-display text-[0.9rem] font-semibold text-steel [&>th]:px-3 [&>th]:py-2">
              <th>When</th>
              <th>PO</th>
              <th>Vendor</th>
              <th>What happened</th>
              <th>Who</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className={`border-b border-slate-100 align-top [&>td]:px-3 [&>td]:py-2 ${TRACKING_KINDS.has(e.kind) ? "text-slate-600" : ""}`}>
                <td className="whitespace-nowrap text-xs tabular-nums text-slate-600">{fmtTimestamp(e.recorded_at)}</td>
                <td className="whitespace-nowrap font-medium">
                  <Link to={`/pos/${e.po_id}`} className="text-route-dark hover:underline">{e.po_number}</Link>
                </td>
                <td className="whitespace-nowrap text-slate-600">{e.vendor ?? "—"}</td>
                <td>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span>{describe(e)}</span>
                    <Subject e={e} />
                  </div>
                  {/* Carrier times are the port's local time, so show them as given */}
                  {e.occurred_at && <div className="text-xs text-slate-500">occurred {fmtDate(e.occurred_at, e.occurred_at.length > 10)}</div>}
                </td>
                <td className="whitespace-nowrap text-xs"><Actor actor={e.actor} /></td>
              </tr>
            ))}
            {!entries.length && !loading && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-500">Nothing matches these filters.</td>
              </tr>
            )}
          </tbody>
        </table>
        {(hasMore || loading) && (
          <div className="p-3 text-center">
            <button className="btn" disabled={loading} onClick={() => load(entries.length)}>
              {loading ? "Loading…" : "Show more"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
