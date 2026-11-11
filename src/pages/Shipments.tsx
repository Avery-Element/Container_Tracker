import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Shipment } from "../api";
import { EditableDate, ErrorBox, fmtDate, Holds, MilestoneBadge, TrackingStatus, useApi } from "../components/ui";
import { MILESTONES, MILESTONE_ORDER } from "../../shared/milestones";
import { ShipLink, type Row } from "./Dashboard";

type SortKey = "entered" | "eta_first" | "eta" | "status";
type Sort = { key: SortKey; dir: "asc" | "desc" } | null;

/** Earliest order date across the shipment's POs (when the PO was entered). */
const enteredDate = (r: Row) =>
  r.s.pos.map((p) => p.order_date).filter((d): d is string => !!d).sort()[0] ?? null;

/** First ETA ever recorded for the container (or shipment); never changes once set. */
const firstEta = (r: Row) => r.c?.original_eta ?? r.s.original_eta;

const SORT_VALUE: Record<SortKey, (r: Row) => string | number | null> = {
  entered: enteredDate,
  eta_first: (r) => firstEta(r),
  eta: (r) => r.c?.eta ?? r.s.eta,
  // Shipping order (Booked → Loaded → … → Received); rows without a container go last.
  status: (r) => (r.c ? MILESTONE_ORDER[r.c.milestone] ?? null : null),
};

function sortRows(rows: Row[], sort: Sort): Row[] {
  if (!sort) return rows;
  const get = SORT_VALUE[sort.key];
  const sign = sort.dir === "asc" ? 1 : -1;
  // Blank values always go to the bottom, whichever direction.
  return [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    if (x == null || x === "" || y == null || y === "") return x != null && x !== "" ? -1 : y != null && y !== "" ? 1 : 0;
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
}

function SortHeader({ label, k, sort, setSort }: { label: string; k: SortKey; sort: Sort; setSort: (s: Sort) => void }) {
  const active = sort?.key === k;
  return (
    <th aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button
        type="button"
        className="-mx-1 inline-flex min-h-6 items-center gap-1 rounded px-1 uppercase hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-teal-600"
        onClick={() => setSort({ key: k, dir: active && sort.dir === "asc" ? "desc" : "asc" })}
      >
        {label}
        <span aria-hidden className={active ? "text-teal-700" : "text-slate-400"}>
          {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

const TABS = [
  { key: "active", label: "Active" },
  { key: "received", label: "Received" },
  { key: "all", label: "All" },
];

export default function Shipments() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "active";
  const q = params.get("q") ?? "";
  const [text, setText] = useState(q);
  const [milestone, setMilestone] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== q) setParams((p) => (text ? p.set("q", text) : p.delete("q"), p), { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [text, q, setParams]);

  const { data, error, loading, reload } = useApi<Shipment[]>(
    `/shipments?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
  );
  const rows: Row[] = (data ?? []).flatMap((s): Row[] =>
    s.containers.length ? s.containers.map((c) => ({ s, c })) : [{ s, c: null }],
  );
  const shown = sortRows(milestone ? rows.filter((r) => r.c?.milestone === milestone) : rows, sort);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-slate-300 bg-white p-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setParams((p) => (p.set("status", t.key), p))}
              className={`rounded px-3 py-1 text-sm ${status === t.key ? "bg-teal-700 text-white" : "text-slate-600"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          className="input min-w-0 flex-1 basis-56 sm:max-w-xs"
          placeholder="Search PO, container, BL, vendor, notes…"
          aria-label="Search shipments"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select
          className="input w-auto max-w-48"
          aria-label="Filter by status"
          value={milestone}
          onChange={(e) => setMilestone(e.target.value)}
        >
          <option value="">All statuses</option>
          {MILESTONES.filter((m) => m.key !== "po_placed" && m.key !== "cargo_ready").map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>
        <span className="text-sm text-slate-500">{loading ? "Loading…" : `${shown.length} rows`}</span>
        <SyncAllButton onDone={reload} />
        <Link to="/shipments/new" className="btn-primary">+ New shipment</Link>
      </div>
      <ErrorBox error={error} />
      {/* Scroll box sized to the screen so the header row, the container column and the
          sideways scrollbar are always in view, instead of the scrollbar sitting below the last row. */}
      <div className="card max-h-[75dvh] min-h-80 overflow-auto sm:max-h-[calc(100dvh-9rem)]">
        <table className="data sticky-frame">
          <thead>
            <tr>
              <th>Container / ref</th><th>PO</th>
              <SortHeader label="Date entered" k="entered" sort={sort} setSort={setSort} />
              <th>Vendor</th><th>Carrier</th><th>BL / booking</th>
              <SortHeader label="Status" k="status" sort={sort} setSort={setSort} />
              <SortHeader label="ETA (first published)" k="eta_first" sort={sort} setSort={setSort} />
              <SortHeader label="ETA (current)" k="eta" sort={sort} setSort={setSort} />
              <th>ELM delivery</th><th>Notes</th><th>Tracking</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.s.id}-${r.c?.id ?? "x"}`}>
                <td className="whitespace-nowrap"><ShipLink r={r} /></td>
                <td>{r.s.pos.map((p) => p.po_number).join(", ")}</td>
                <td className="whitespace-nowrap">{fmtDate(enteredDate(r))}</td>
                <td className="whitespace-nowrap">{r.s.vendor}</td>
                <td className="whitespace-nowrap">{r.s.carrier_name ?? <span className="capitalize text-slate-500">{r.s.mode}</span>}</td>
                <td className="font-mono text-xs">{r.s.mbl}</td>
                <td className="whitespace-nowrap">
                  {r.c ? <MilestoneBadge milestone={r.c.milestone} /> : <span className="text-xs text-slate-500">{r.s.status}</span>}{" "}
                  <Holds holds={r.c?.holds ?? null} />
                </td>
                <td className="whitespace-nowrap">{fmtDate(firstEta(r))}</td>
                <td className="whitespace-nowrap">{fmtDate(r.c?.eta ?? r.s.eta)}</td>
                <td className="whitespace-nowrap">
                  {r.c ? (
                    <EditableDate
                      withTime
                      value={r.c.elm_delivery_appt}
                      onSave={async (v) => (await api.patch(`/containers/${r.c!.id}`, { elm_delivery_appt: v }), reload())}
                    />
                  ) : "—"}
                </td>
                <td><NoteCell s={r.s} onAdded={reload} /></td>
                <td>{r.s.mode === "ocean" && <TrackingStatus status={r.s.tracking_status} error={r.s.tracking_error} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NoteCell({ s, onAdded }: { s: Shipment; onAdded: () => void }) {
  const [adding, setAdding] = useState(false);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const note = s.latest_note;

  if (adding)
    return (
      <form
        className="flex min-w-64 gap-1"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!body.trim()) return;
          setSaving(true);
          await api.post("/notes", { shipment_id: s.id, po_id: s.pos[0]?.id, body });
          setSaving(false);
          setBody("");
          setAdding(false);
          onAdded();
        }}
      >
        <input
          autoFocus
          className="input py-1 text-xs"
          placeholder="Add a note…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
        />
        <button className="btn px-2 py-1 text-xs" disabled={saving || !body.trim()}>Save</button>
      </form>
    );

  return (
    <div className="group min-w-48 max-w-72 text-xs">
      {note ? (
        <div title={`${note.body}
— ${note.author ?? ""} ${fmtDate(note.created_at)}`}>
          <p className="line-clamp-2 whitespace-pre-line text-slate-700">{note.body}</p>
          <span className="text-slate-500">
            {fmtDate(note.created_at)}
            {s.notes_count > 1 && (
              <Link to={`/shipments/${s.id}`} className="ml-1 hover:underline">· {s.notes_count} notes</Link>
            )}
          </span>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="text-teal-700 hover:underline"
      >
        + Add note
      </button>
    </div>
  );
}

function SyncAllButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="ml-auto flex items-center gap-2">
      {msg && <span className="text-xs text-slate-600">{msg}</span>}
      <button
        className="btn"
        disabled={busy}
        title="Start tracking for untracked active shipments and refresh the rest"
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            setMsg((await api.post<{ message: string }>("/admin/sync-all")).message);
          } catch (e) {
            setMsg((e as Error).message);
          }
          setBusy(false);
          onDone();
        }}
      >
        {busy ? "Syncing…" : "Sync tracking"}
      </button>
    </div>
  );
}
