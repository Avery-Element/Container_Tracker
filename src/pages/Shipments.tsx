import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type PoRef, type PurchaseOrder, type Shipment } from "../api";
import { AWAITING_BOOKING, EditableDate, EditableText, ErrorBox, EtaWithSlip, EtdCue, fmtDate, Holds, PoLinks, TrackingDot, useApi, VoyageTrack } from "../components/ui";
import NewPoForm, { PaymentSelect } from "../components/NewPoForm";
import { MILESTONES, MILESTONE_ORDER } from "../../shared/milestones";
import { ShipLink, type Row } from "./Dashboard";
import { lineWatch, setLineWatch, WatchBox, WATCHED_ROW, watchedBy } from "../components/Watch";

type SortKey = "entered" | "eta" | "status";
type Sort = { key: SortKey; dir: "asc" | "desc" } | null;

/** A table line: a shipment/container, or a PO that has no shipment booked yet. */
type Line = { kind: "ship"; r: Row } | { kind: "po"; p: PurchaseOrder };

/** Earliest order date across the shipment's POs (when the PO was entered). */
const enteredDate = (r: Row) =>
  r.s.pos.map((p) => p.order_date).filter((d): d is string => !!d).sort()[0] ?? null;

/** First ETA ever recorded for the container (or shipment); never changes once set. Shown as the slip beside the current ETA. */
const firstEta = (r: Row) => r.c?.original_eta ?? r.s.original_eta;

const SORT_VALUE: Record<SortKey, (r: Row) => string | number | null> = {
  entered: enteredDate,
  eta: (r) => r.c?.eta ?? r.s.eta,
  // Shipping order (Booked → Loaded → … → Received); rows without a container go last.
  status: (r) => (r.c ? MILESTONE_ORDER[r.c.milestone] ?? null : null),
};

// Unbooked POs have no ETA yet (blank → bottom); by status they sort ahead of "Booked".
const PO_SORT_VALUE: Record<SortKey, (p: PurchaseOrder) => string | number | null> = {
  entered: (p) => p.order_date,
  eta: () => null,
  status: () => -1,
};

function sortRows(rows: Line[], sort: Sort): Line[] {
  if (!sort) return rows;
  const get = (l: Line) => (l.kind === "ship" ? SORT_VALUE[sort.key](l.r) : PO_SORT_VALUE[sort.key](l.p));
  const sign = sort.dir === "asc" ? 1 : -1;
  // Blank values always go to the bottom, whichever direction.
  return [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    if (x == null || x === "" || y == null || y === "") return x != null && x !== "" ? -1 : y != null && y !== "" ? 1 : 0;
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
}

const isWatched = (l: Line) => (l.kind === "ship" ? lineWatch(l.r).watched : !!l.p.watched_at);

function SortHeader({ label, k, sort, setSort }: { label: string; k: SortKey; sort: Sort; setSort: (s: Sort) => void }) {
  const active = sort?.key === k;
  return (
    <th aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button
        type="button"
        className="-mx-1 inline-flex min-h-6 items-center gap-1 rounded px-1 hover:text-ink focus-visible:outline-2 focus-visible:outline-route"
        onClick={() => setSort({ key: k, dir: active && sort.dir === "asc" ? "desc" : "asc" })}
      >
        {label}
        <span aria-hidden className={active ? "text-route" : "text-slate-500"}>
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
  const milestone = params.get("milestone") ?? "";
  const setMilestone = (m: string) =>
    setParams((p) => (m ? p.set("milestone", m) : p.delete("milestone"), p), { replace: true });
  const [sort, setSort] = useState<Sort>(null);
  const [showNewPo, setShowNewPo] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== q) setParams((p) => (text ? p.set("q", text) : p.delete("q"), p), { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [text, q, setParams]);

  const { data, error, loading, reload } = useApi<Shipment[]>(
    `/shipments?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
  );
  // POs with no shipment booked yet. Active shows open ones; All also shows received/cancelled
  // ones (so a cancelled PO can be reopened); Received shows none.
  const { data: poData, error: poError, reload: reloadPos } = useApi<PurchaseOrder[]>(
    status === "received" ? null : `/pos?status=${status === "all" ? "all" : "open"}`,
  );
  const reloadAll = () => (reload(), reloadPos());

  const rows: Line[] = (data ?? []).flatMap((s): Line[] =>
    s.containers.length
      ? s.containers.map((c) => ({ kind: "ship", r: { s, c } }))
      : [{ kind: "ship", r: { s, c: null } }],
  );
  const needle = q.toLowerCase();
  const poRows: Line[] =
    status === "received"
      ? []
      : (poData ?? [])
          .filter((p) => !p.shipment_ids?.length)
          .filter(
            (p) =>
              !needle ||
              [p.po_number, p.vendor, p.vendor_pi, p.forwarder, p.description].join(" ").toLowerCase().includes(needle),
          )
          .map((p) => ({ kind: "po", p }));
  const filtered =
    milestone === AWAITING_BOOKING
      ? poRows
      : milestone
        ? rows.filter((l) => l.kind === "ship" && l.r.c?.milestone === milestone)
        : [...poRows, ...rows];
  const shown = sortRows(filtered, sort);
  const watchedCount = shown.filter(isWatched).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-slate-300 bg-white p-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setParams((p) => (p.set("status", t.key), p))}
              className={`rounded px-3 py-1 text-sm ${status === t.key ? "bg-route text-white" : "text-slate-600"}`}
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
          {status !== "received" && <option value={AWAITING_BOOKING}>Awaiting booking</option>}
          {MILESTONES.filter((m) => m.key !== "po_placed" && m.key !== "cargo_ready").map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>
        <span className="text-sm text-slate-500">{loading ? "Loading…" : `${shown.length} rows${watchedCount ? `, ${watchedCount} watched` : ""}`}</span>
        <SyncAllButton onDone={reloadAll} />
        <button className="btn" onClick={() => setShowNewPo((v) => !v)} aria-expanded={showNewPo}>
          + New PO
        </button>
        <Link to="/shipments/new" className="btn-primary">+ New shipment</Link>
      </div>
      {showNewPo && (
        <NewPoForm onCreated={() => (setShowNewPo(false), reloadPos())} onCancel={() => setShowNewPo(false)} />
      )}
      <ErrorBox error={error ?? poError} />
      {/* Scroll box sized to the screen so the header row and the sideways scrollbar are
          always in view, instead of the scrollbar sitting below the last row. */}
      <div className="card max-h-[75dvh] min-h-80 overflow-auto sm:max-h-[calc(100dvh-9rem)]">
        <table className="data sticky-frame">
          <thead>
            <tr>
              <SortHeader label="Date entered" k="entered" sort={sort} setSort={setSort} />
              <th>Vendor PI #</th><th>Vendor</th><th>PO</th>
              <SortHeader label="Status" k="status" sort={sort} setSort={setSort} />
              <th>FF</th><th>Carrier</th><th>BL / booking</th><th>Container / ref</th><th>Pallets</th>
              <SortHeader label="ETA" k="eta" sort={sort} setSort={setSort} />
              <th>ELM delivery</th><th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => {
              if (l.kind === "po") return <PoLine key={`po-${l.p.id}`} p={l.p} onChange={reloadPos} />;
              const r = l.r;
              const w = lineWatch(r);
              const savePo = (po: PoRef) => async (body: Record<string, string | null>) => {
                await api.patch(`/pos/${po.id}`, body);
                reload();
              };
              return (
              <tr key={`${r.s.id}-${r.c?.id ?? "x"}`} className={w.watched ? WATCHED_ROW : ""}>
                <td className="whitespace-nowrap">
                  {(r.c || r.s.pos.length > 0) && (
                    <WatchBox
                      watched={w.watched}
                      label={`Watch ${r.c ? `container ${r.c.number}` : `shipment ${r.s.mbl ?? r.s.reference ?? r.s.id}`}`}
                      title={
                        w.own || !w.watched
                          ? w.why || "Watch: highlight this line and list it on the Dashboard"
                          : `${w.why}. Unticking stops watching the PO and all its containers.`
                      }
                      onToggle={(next) => setLineWatch(r, next)}
                      onSaved={reloadAll}
                    />
                  )}
                  {fmtDate(enteredDate(r))}
                </td>
                <td className="whitespace-nowrap text-xs">
                  {r.s.pos.map((po) => (
                    <div key={po.id} title={r.s.pos.length > 1 ? `PO ${po.po_number}` : undefined}>
                      <EditableText value={po.vendor_pi ?? null} onSave={(v) => savePo(po)({ vendor_pi: v })} />
                    </div>
                  ))}
                </td>
                <td className="whitespace-nowrap">{r.s.vendor}</td>
                <td className="font-semibold"><PoLinks pos={r.s.pos} /></td>
                <td className="whitespace-nowrap">
                  {r.c ? <VoyageTrack milestone={r.c.milestone} /> : <span className="text-xs text-slate-500">{r.s.status}</span>}{" "}
                  <Holds holds={r.c?.holds ?? null} />
                  {/* Payment stays visible for the whole journey, one per PO on the shipment. */}
                  {r.s.pos.map((po) => (
                    <div key={po.id} className="mt-1 flex items-start gap-1">
                      {r.s.pos.length > 1 && <span className="pt-0.5 text-xs text-slate-500">{po.po_number}</span>}
                      <PaymentSelect po={po} onSave={savePo(po)} />
                    </div>
                  ))}
                </td>
                <td className="whitespace-nowrap">{r.s.forwarder ?? r.s.pos.find((po) => po.forwarder)?.forwarder ?? "—"}</td>
                <td className="whitespace-nowrap">{r.s.carrier_name ?? <span className="capitalize text-slate-500">{r.s.mode}</span>}</td>
                <td className="font-mono text-xs">{r.s.mbl}</td>
                <td className="whitespace-nowrap">
                  <ShipLink r={r} />
                  {r.s.mode === "ocean" && <TrackingDot status={r.s.tracking_status} error={r.s.tracking_error} />}
                </td>
                <td>{r.c && <PalletsBox id={r.c.id} number={r.c.number} checked={!!r.c.pallets} onSaved={reload} />}</td>
                <td><EtaWithSlip eta={r.c?.eta ?? r.s.eta} first={firstEta(r)} /></td>
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
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A PO with no shipment booked yet, laid out in the shipments table's columns. */
function PoLine({ p, onChange }: { p: PurchaseOrder; onChange: () => void }) {
  const patch = async (body: Record<string, string | null>) => {
    await api.patch(`/pos/${p.id}`, body);
    onChange();
  };
  const watched = !!p.watched_at;
  return (
    <tr className={watched ? WATCHED_ROW : "[&>td]:bg-amber-50/50"}>
      <td className="whitespace-nowrap">
        <WatchBox
          watched={watched}
          label={`Watch PO ${p.po_number}`}
          title={watched ? `Watched by ${watchedBy(p)}` : "Watch: highlight this PO, list it on the Dashboard, and keep watching its containers once booked"}
          onToggle={(next) => api.patch(`/pos/${p.id}`, { watched: next })}
          onSaved={onChange}
        />
        {fmtDate(p.order_date)}
      </td>
      <td className="whitespace-nowrap text-xs">
        <EditableText value={p.vendor_pi} onSave={(v) => patch({ vendor_pi: v })} />
      </td>
      <td className="whitespace-nowrap">{p.vendor}</td>
      <td className="font-semibold"><PoLinks pos={[p]} /></td>
      <td className="whitespace-nowrap">
        <select
          className="input w-auto! py-0.5! text-xs!"
          aria-label={`PO ${p.po_number} status`}
          value={p.status}
          onChange={(e) => patch({ status: e.target.value })}
        >
          <option value="open">Awaiting booking</option>
          <option value="received">PO received</option>
          <option value="cancelled">PO cancelled</option>
        </select>
        <div className="mt-1">
          <PaymentSelect po={p} onSave={patch} />
        </div>
      </td>
      <td className="whitespace-nowrap">{p.forwarder ?? "—"}</td>
      <td className="text-slate-500">—</td>
      <td className="text-slate-500">—</td>
      <td className="whitespace-nowrap">
        {p.status === "open" ? (
          <Link to={`/shipments/new?po=${p.id}`} className="text-sm font-medium text-route hover:underline">
            + Book shipment
          </Link>
        ) : (
          <span className="text-xs text-slate-500">—</span>
        )}
      </td>
      <td />
      {/* Not booked yet, so the ETA column holds the cargo ready date and the rough ETD. Once booked, the row shows the shipment's ETA instead. */}
      <td className="whitespace-nowrap">
        <div className="grid grid-cols-[auto_auto] items-center justify-start gap-x-1">
          <span className="text-xs text-slate-500">Cargo ready</span>
          <EditableDate value={p.crd} onSave={(v) => patch({ crd: v })} />
          <span className="text-xs text-slate-500" title="Estimated departure, before booking">ETD</span>
          <span className="inline-flex items-center gap-1">
            <EditableDate value={p.etd} onSave={(v) => patch({ etd: v })} />
            {p.status === "open" && <EtdCue etd={p.etd} />}
          </span>
        </div>
      </td>
      <td>—</td>
      <td className="min-w-48 max-w-72 text-xs text-slate-600">
        <p className="line-clamp-2" title={p.description ?? undefined}>{p.description}</p>
      </td>
    </tr>
  );
}

/** Pallets checkbox for one container. Saves straight away; each change goes in PO History. */
function PalletsBox({ id, number, checked, onSaved }: { id: number; number: string; checked: boolean; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <input
      type="checkbox"
      className={`size-4 cursor-pointer accent-route ${error ? "outline-2 outline-hold" : ""}`}
      aria-label={`Pallets for container ${number}`}
      title={error ? `Couldn't save: ${error}` : undefined}
      checked={checked}
      disabled={busy}
      onChange={async (e) => {
        setBusy(true);
        setError(null);
        try {
          await api.patch(`/containers/${id}`, { pallets: e.target.checked });
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
          onSaved();
        }
      }}
    />
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
          await api.post("/notes", { shipment_id: s.id, body });
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
        className="text-route hover:underline"
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
