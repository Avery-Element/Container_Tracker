// One PO: its details (editable), its shipments, and its full PO History.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type PoDetail as PD } from "../api";
import { EditableDate, ErrorBox, fmtDate, useApi, VoyageTrack, ContainerNumber } from "../components/ui";
import { PaymentSelect } from "../components/NewPoForm";
import { HistoryTimeline, TRACKING_KINDS } from "../components/History";

/** Click-to-edit text; saves on Enter or when focus leaves, Escape cancels. */
function EditableText({ value, onSave, placeholder = "+ set", list }: { value: string | null; onSave: (v: string) => Promise<void>; placeholder?: string; list?: string }) {
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export default function PoDetail() {
  const { id } = useParams();
  const { data: po, error, reload } = useApi<PD>(`/pos/${id}`);
  const { data: vendors } = useApi<{ id: number; name: string }[]>("/vendors");
  const [showTracking, setShowTracking] = useState(true);
  const [note, setNote] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  if (error) return <ErrorBox error={error} />;
  if (!po) return <p className="text-sm text-slate-500">Loading…</p>;

  const patch = async (body: Record<string, string | null | undefined>) => {
    setSaveError(null);
    try {
      await api.patch(`/pos/${po.id}`, body);
    } catch (e) {
      setSaveError((e as Error).message);
      throw e;
    } finally {
      reload();
    }
  };
  const save = (field: string) => (v: string | null) => patch({ [field]: v }).catch(() => {});
  const history = showTracking ? po.history : po.history.filter((e) => !TRACKING_KINDS.has(e.kind));
  const hiddenCount = po.history.length - history.length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-3xl font-semibold">PO {po.po_number}</h1>
        <span className="text-sm text-slate-500">{po.vendor ?? "No vendor"}</span>
        <Link to="/activity" className="ml-auto text-sm text-route hover:underline">All activity</Link>
      </div>

      <section className="card grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Vendor">
          <EditableText value={po.vendor} list="po-vendors" onSave={save("vendor")} />
          <datalist id="po-vendors">{vendors?.map((v) => <option key={v.id} value={v.name} />)}</datalist>
        </Field>
        <Field label="Vendor PI #"><EditableText value={po.vendor_pi} onSave={save("vendor_pi")} /></Field>
        <Field label="Forwarder"><EditableText value={po.forwarder} onSave={save("forwarder")} /></Field>
        <Field label="Status">
          <select className="input w-auto! py-0.5! text-sm!" aria-label="PO status" value={po.status} onChange={(e) => save("status")(e.target.value)}>
            <option value="open">Awaiting booking</option>
            <option value="received">PO received</option>
            <option value="cancelled">PO cancelled</option>
          </select>
        </Field>
        <Field label="Order date"><EditableDate value={po.order_date} onSave={save("order_date")} /></Field>
        <Field label="Cargo ready date"><EditableDate value={po.crd} onSave={save("crd")} /></Field>
        <Field label="Payment">
          {/* PaymentSelect shows its own errors */}
          <PaymentSelect po={po} onSave={async (p) => { try { await api.patch(`/pos/${po.id}`, p); } finally { reload(); } }} />
        </Field>
        <Field label="Products / notes"><EditableText value={po.description} onSave={save("description")} /></Field>
        {saveError && <p className="text-sm text-red-700 sm:col-span-2 lg:col-span-4">{saveError}</p>}
      </section>

      <section className="card p-4">
        <h2 className="mb-2 text-lg font-semibold text-ink">Shipments</h2>
        {po.shipments.length === 0 ? (
          <p className="text-sm text-slate-500">
            Not booked yet.{" "}
            {po.status === "open" && <Link to={`/shipments/new?po=${po.id}`} className="text-route hover:underline">+ Book shipment</Link>}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {po.shipments.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                <Link to={`/shipments/${s.id}`} className="font-mono text-route-dark hover:underline">{s.mbl ?? s.reference ?? `#${s.id}`}</Link>
                <span className="text-slate-500">{s.carrier_name ?? s.mode}</span>
                <span className="text-slate-500">ETA {fmtDate(s.ata ?? s.eta)}</span>
                <span className="capitalize text-slate-500">{s.status}</span>
                <span className="flex flex-wrap gap-1">
                  {s.containers.map((c) => (
                    <span key={c.number} className="flex items-center gap-1 text-xs">
                      <span className="text-slate-600"><ContainerNumber number={c.number} /></span>
                      <VoyageTrack milestone={c.milestone} />
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold text-ink">PO History</h2>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" checked={showTracking} onChange={(e) => setShowTracking(e.target.checked)} />
            Show carrier tracking
          </label>
          {!showTracking && hiddenCount > 0 && <span className="text-xs text-slate-500">{hiddenCount} tracking entries hidden</span>}
        </div>
        <form
          className="mb-4 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!note.trim()) return;
            await api.post("/notes", { po_id: po.id, body: note });
            setNote("");
            reload();
          }}
        >
          <input className="input" placeholder={`Add a note to PO ${po.po_number}…`} value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn">Add</button>
        </form>
        <HistoryTimeline entries={history} />
      </section>
    </div>
  );
}
