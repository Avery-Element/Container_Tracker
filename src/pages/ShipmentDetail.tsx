import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type Container, type ShipmentDetail as SD } from "../api";
import { EditableDate, ErrorBox, fmtDate, Holds, MilestoneBadge, TrackingStatus, useApi } from "../components/ui";
import { PaymentSelect } from "../components/NewPoForm";
import { CARRIERS } from "../../shared/carriers";
import { MILESTONES } from "../../shared/milestones";

export default function ShipmentDetail() {
  const { id } = useParams();
  const { data: s, error, reload } = useApi<SD>(`/shipments/${id}`);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  if (error) return <ErrorBox error={error} />;
  if (!s) return <p className="text-sm text-slate-500">Loading…</p>;

  async function action(path: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ ok: boolean; message: string }>(path);
      setMsg(r.message);
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(false);
    reload();
  }

  const title = s.pos.map((p) => p.po_number).join(" + ") || s.reference || s.mbl || `Shipment #${s.id}`;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-4">
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-sm text-slate-500">
            {s.vendor ?? "—"} · {s.carrier_name ?? s.mode} {s.mbl && <span className="font-mono">· {s.mbl}</span>}
            {s.forwarder && ` · FF ${s.forwarder}`}
          </p>
          <div className="mt-1 flex flex-wrap gap-3">
            {s.pos.map((p) => (
              <span key={p.id} className="flex items-center gap-1.5 text-xs">
                {p.po_number}
                <PaymentSelect po={p} onSave={async (patch) => (await api.patch(`/pos/${p.id}`, patch), reload())} />
              </span>
            ))}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {s.mode === "ocean" && <TrackingStatus status={s.tracking_status} error={s.tracking_error} />}
          {s.mode === "ocean" && s.status === "active" && !s.tracking_status && (
            <button className="btn-primary" disabled={busy} onClick={() => action(`/shipments/${s.id}/track`)}>
              Start live tracking
            </button>
          )}
          {s.mode === "ocean" && s.status === "active" && ["failed", "not_trackable"].includes(s.tracking_status ?? "") && (
            <button className="btn" disabled={busy} onClick={() => action(`/shipments/${s.id}/track`)}>
              Retry tracking
            </button>
          )}
          {s.status === "active" && ["pending", "tracking"].includes(s.tracking_status ?? "") && (
            <button className="btn" disabled={busy} onClick={() => action(`/shipments/${s.id}/refresh`)}>
              Refresh now
            </button>
          )}
          <button className="btn" onClick={() => setEditing((e) => !e)}>{editing ? "Close" : "Edit"}</button>
        </div>
      </div>
      {msg && <div className="rounded-md bg-slate-100 px-3 py-2 text-sm">{msg}</div>}
      {s.tracking_error && <ErrorBox error={`Tracking: ${s.tracking_error}`} />}
      {editing && <EditShipment s={s} onSaved={() => (setEditing(false), reload())} />}

      <div className="grid gap-3 md:grid-cols-4">
        <Fact label="Route" value={s.pol || s.pod ? `${s.pol ?? "?"} → ${s.pod ?? "?"}` : "—"} />
        <Fact label="Vessel" value={s.vessel ? `${s.vessel} ${s.voyage ?? ""}` : "—"} />
        <Fact label="Departed" value={s.atd ? fmtDate(s.atd) : s.etd ? `ETD ${fmtDate(s.etd)}` : "—"} />
        <Fact
          label="Port arrival"
          value={s.ata ? `Arrived ${fmtDate(s.ata)}` : s.eta ? `ETA ${fmtDate(s.eta)}` : "—"}
          sub={s.original_eta && s.original_eta.slice(0, 10) !== s.eta?.slice(0, 10) ? `originally ${fmtDate(s.original_eta)}` : undefined}
        />
      </div>

      <section className="card overflow-x-auto">
        <h2 className="px-4 pt-4 text-sm font-semibold text-slate-700">Containers</h2>
        <table className="data mt-2">
          <thead>
            <tr>
              <th>Container</th><th>Status</th><th>ETA</th><th>Discharged</th><th>Terminal</th><th>ELM delivery appt</th><th>Update</th>
            </tr>
          </thead>
          <tbody>
            {s.containers.map((c) => (
              <ContainerRow key={c.id} c={c} onChange={reload} />
            ))}
          </tbody>
        </table>
        {s.mode === "ocean" && <AddContainer shipmentId={s.id} onAdded={reload} />}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Notes s={s} onAdded={reload} />
        <section className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Tracking events</h2>
          {s.events.length === 0 && <p className="text-sm text-slate-500">No events yet.</p>}
          <ol className="relative ml-2 border-l border-slate-200 text-sm">
            {s.events.map((e) => (
              <li key={e.id} className="mb-3 ml-4">
                <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border border-white bg-teal-600" />
                <div className="font-medium">{prettyEvent(e.event)} {e.number && <span className="font-mono text-xs text-slate-500">{e.number}</span>}</div>
                <div className="text-xs text-slate-500">
                  {fmtDate(e.occurred_at ?? e.created_at, true)} {e.location && `· ${e.location}`} · {e.source}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

function prettyEvent(e: string) {
  return e
    .replace(/^container\.transport\./, "")
    .replace(/^manual\./, "Marked ")
    .replace(/[._]/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-3">
      <div className="label">{label}</div>
      <div className="text-sm font-medium">{value}</div>
      {sub && <div className="text-xs text-amber-700">{sub}</div>}
    </div>
  );
}

function ContainerRow({ c, onChange }: { c: Container; onChange: () => void }) {
  const [appt, setAppt] = useState(c.elm_delivery_appt?.slice(0, 16) ?? "");
  const save = async (body: Record<string, string | null>) => {
    await api.patch(`/containers/${c.id}`, body);
    onChange();
  };
  return (
    <tr>
      <td className="whitespace-nowrap font-mono">
        {c.number}
        {!c.number_valid && <span className="ml-1 text-xs text-amber-600" title="ISO 6346 check digit failed">⚠ check</span>}
        {c.size && <div className="text-xs text-slate-500">{c.size}</div>}
      </td>
      <td><MilestoneBadge milestone={c.milestone} /> <Holds holds={c.holds} /></td>
      <td className="whitespace-nowrap">{fmtDate(c.eta)}</td>
      <td className="whitespace-nowrap">{fmtDate(c.discharged_at)}</td>
      <td className="text-xs">{c.terminal ?? "—"}</td>
      <td>
        <input
          type="datetime-local"
          className="input w-48"
          value={appt}
          onChange={(e) => setAppt(e.target.value)}
          onBlur={() => appt !== (c.elm_delivery_appt?.slice(0, 16) ?? "") && save({ elm_delivery_appt: appt || null })}
        />
      </td>
      <td>
        <select
          className="input w-40"
          value=""
          onChange={(e) => e.target.value && save({ milestone: e.target.value })}
        >
          <option value="">Set status…</option>
          {MILESTONES.filter((m) => !["po_placed", "cargo_ready"].includes(m.key)).map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>
      </td>
    </tr>
  );
}

function AddContainer({ shipmentId, onAdded }: { shipmentId: number; onAdded: () => void }) {
  const [n, setN] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="flex items-center gap-2 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const r = await api.post<{ valid: boolean }>(`/shipments/${shipmentId}/containers`, { number: n });
          setErr(r.valid ? null : "Added, but the check digit looks wrong. Double-check the number.");
          setN("");
          onAdded();
        } catch (e) {
          setErr((e as Error).message);
        }
      }}
    >
      <input className="input max-w-48 font-mono" placeholder="ABCU1234567" value={n} onChange={(e) => setN(e.target.value)} />
      <button className="btn" disabled={!n}>Add container</button>
      {err && <span className="text-sm text-amber-700">{err}</span>}
    </form>
  );
}

function EditShipment({ s, onSaved }: { s: SD; onSaved: () => void }) {
  const [f, setF] = useState({
    mode: s.mode,
    carrier_scac: s.carrier_scac ?? "",
    mbl: s.mbl ?? "",
    reference: s.reference ?? "",
    forwarder: s.forwarder ?? "",
    eta: s.eta?.slice(0, 10) ?? "",
    status: s.status,
  });
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const nav = useNavigate();
  async function del() {
    setDeleting(true);
    setErr(null);
    try {
      await api.del(`/shipments/${s.id}`);
      nav("/shipments");
    } catch (e) {
      setErr((e as Error).message);
      setDeleting(false);
    }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="card grid gap-3 p-4 md:grid-cols-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const body: Record<string, string> = {};
        for (const [k, v] of Object.entries(f)) {
          const orig = k === "eta" ? s.eta?.slice(0, 10) ?? "" : ((s as unknown as Record<string, string | null>)[k] ?? "");
          if (v !== orig) body[k] = v;
        }
        try {
          await api.patch(`/shipments/${s.id}`, body);
          onSaved();
        } catch (e) {
          setErr((e as Error).message);
        }
      }}
    >
      <label><span className="label">Mode</span>
        <select className="input" value={f.mode} onChange={set("mode")}>
          <option value="ocean">Ocean</option><option value="air">Air</option><option value="parcel">Parcel</option>
        </select>
      </label>
      <label><span className="label">Carrier</span>
        <select className="input" value={f.carrier_scac} onChange={set("carrier_scac")}>
          <option value="">—</option>
          {CARRIERS.map((c) => <option key={c.scac} value={c.scac}>{c.name}</option>)}
        </select>
      </label>
      <label><span className="label">BL / booking #</span><input className="input font-mono" value={f.mbl} onChange={set("mbl")} /></label>
      <label><span className="label">Forwarder</span><input className="input" value={f.forwarder} onChange={set("forwarder")} /></label>
      <label><span className="label">Tracking # (air/parcel)</span><input className="input" value={f.reference} onChange={set("reference")} /></label>
      <label><span className="label">ETA (manual)</span><input type="date" className="input" value={f.eta} onChange={set("eta")} /></label>
      <label><span className="label">Shipment status</span>
        <select className="input" value={f.status} onChange={set("status")}>
          <option value="active">Active</option><option value="received">Received</option><option value="cancelled">Cancelled</option>
        </select>
      </label>
      <div className="flex items-end gap-2">
        <button className="btn-primary">Save</button>
        {err && <span className="text-sm text-red-700">{err}</span>}
      </div>
      <p className="text-xs text-slate-500 md:col-span-4">Changing the carrier or BL resets live tracking. Click “Start live tracking” again after saving.</p>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 md:col-span-4">
        {confirmDelete ? (
          <>
            <span className="text-sm text-red-700">
              Delete this shipment, its containers, notes and tracking history? This can’t be undone. Linked POs are kept.
            </span>
            <button type="button" className="btn-danger" disabled={deleting} onClick={del}>
              {deleting ? "Deleting…" : "Yes, delete"}
            </button>
            <button type="button" className="btn" disabled={deleting} onClick={() => setConfirmDelete(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="btn text-red-700" onClick={() => setConfirmDelete(true)}>Delete shipment</button>
        )}
      </div>
    </form>
  );
}

function Notes({ s, onAdded }: { s: SD; onAdded: () => void }) {
  const [body, setBody] = useState("");
  return (
    <section className="card p-4">
      <h2 className="mb-2 text-sm font-semibold text-slate-700">Notes</h2>
      <form
        className="mb-3 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          await api.post("/notes", { shipment_id: s.id, body });
          setBody("");
          onAdded();
        }}
      >
        <input className="input" placeholder="Add a note…" value={body} onChange={(e) => setBody(e.target.value)} />
        <button className="btn" disabled={!body.trim()}>Add</button>
      </form>
      <ul className="space-y-2 text-sm">
        {s.notes.map((n) => (
          <li key={n.id} className="rounded-md bg-slate-50 px-3 py-2">
            <div className="whitespace-pre-wrap">{n.body}</div>
            <div className="mt-1 text-xs text-slate-400">{n.author} · {fmtDate(n.created_at)}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
