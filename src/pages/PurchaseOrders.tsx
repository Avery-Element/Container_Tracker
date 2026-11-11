import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type PurchaseOrder } from "../api";
import { ErrorBox, fmtDate, PaymentBadge, useApi } from "../components/ui";

export default function PurchaseOrders() {
  const [status, setStatus] = useState("open");
  const [q, setQ] = useState("");
  const [showNew, setShowNew] = useState(false);
  const { data, error, reload } = useApi<PurchaseOrder[]>(`/pos?status=${status}`);
  const list = (data ?? []).filter(
    (p) => !q || `${p.po_number} ${p.vendor} ${p.vendor_pi} ${p.description}`.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select className="input max-w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Open</option>
          <option value="received">Received</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All</option>
        </select>
        <input className="input max-w-xs" placeholder="Filter PO, vendor, PI…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-sm text-slate-500">{list.length} POs</span>
        <button className="btn-primary ml-auto" onClick={() => setShowNew((v) => !v)}>
          {showNew ? "Close" : "+ New PO"}
        </button>
      </div>
      {showNew && <NewPo onCreated={() => (setShowNew(false), reload())} />}
      <ErrorBox error={error} />
      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>PO</th><th>Vendor</th><th>Vendor PI</th><th>Ordered</th><th>CRD</th><th>Payment</th><th>Status</th><th>Shipments</th><th>Products / notes</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <PoRow key={p.id} p={p} onChange={reload} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PoRow({ p, onChange }: { p: PurchaseOrder; onChange: () => void }) {
  const patch = async (body: Record<string, string>) => {
    await api.patch(`/pos/${p.id}`, body);
    onChange();
  };
  return (
    <tr>
      <td className="font-medium">{p.po_number}</td>
      <td>{p.vendor}</td>
      <td className="text-xs">{p.vendor_pi}</td>
      <td className="whitespace-nowrap">{fmtDate(p.order_date)}</td>
      <td>
        <input
          type="date"
          className="input w-36"
          defaultValue={p.crd ?? ""}
          onBlur={(e) => e.target.value !== (p.crd ?? "") && patch({ crd: e.target.value })}
        />
      </td>
      <td>
        <select className="input w-32" value={p.payment_status ?? ""} onChange={(e) => patch({ payment_status: e.target.value })}>
          <option value="">—</option>
          <option value="not_paid">Not paid</option>
          <option value="deposit_paid">Deposit paid</option>
          <option value="paid">Paid</option>
          {p.payment_status && !["not_paid", "deposit_paid", "paid"].includes(p.payment_status) && (
            <option value={p.payment_status}>{p.payment_status}</option>
          )}
        </select>
        <div className="mt-0.5"><PaymentBadge status={p.payment_status} /></div>
      </td>
      <td>
        <select className="input w-28" value={p.status} onChange={(e) => patch({ status: e.target.value })}>
          <option value="open">Open</option><option value="received">Received</option><option value="cancelled">Cancelled</option>
        </select>
      </td>
      <td className="whitespace-nowrap">
        {(p.shipment_ids ?? []).map((id) => (
          <Link key={id} to={`/shipments/${id}`} className="mr-2 text-teal-800 hover:underline">#{id}</Link>
        ))}
        {p.status === "open" && (
          <Link to={`/shipments/new?po=${p.id}`} className="text-xs text-slate-500 hover:underline">+ book</Link>
        )}
      </td>
      <td className="max-w-md text-xs text-slate-600">{p.description}</td>
    </tr>
  );
}

function NewPo({ onCreated }: { onCreated: () => void }) {
  const { data: vendors } = useApi<{ id: number; name: string }[]>("/vendors");
  const [f, setF] = useState({ po_number: "", vendor: "", vendor_pi: "", order_date: "", crd: "", payment_status: "not_paid", forwarder: "", description: "" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="card grid gap-3 p-4 md:grid-cols-4"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.post("/pos", f);
          onCreated();
        } catch (e) {
          setErr((e as Error).message);
        }
      }}
    >
      <label><span className="label">PO #</span><input required className="input" placeholder="6200ELM" value={f.po_number} onChange={set("po_number")} /></label>
      <label><span className="label">Vendor</span>
        <input className="input" list="vendors" value={f.vendor} onChange={set("vendor")} />
        <datalist id="vendors">{vendors?.map((v) => <option key={v.id} value={v.name} />)}</datalist>
      </label>
      <label><span className="label">Vendor PI #</span><input className="input" value={f.vendor_pi} onChange={set("vendor_pi")} /></label>
      <label><span className="label">Forwarder</span><input className="input" placeholder="THI / SEKO" value={f.forwarder} onChange={set("forwarder")} /></label>
      <label><span className="label">Order date</span><input type="date" className="input" value={f.order_date} onChange={set("order_date")} /></label>
      <label><span className="label">Cargo ready date</span><input type="date" className="input" value={f.crd} onChange={set("crd")} /></label>
      <label><span className="label">Payment</span>
        <select className="input" value={f.payment_status} onChange={set("payment_status")}>
          <option value="not_paid">Not paid</option><option value="deposit_paid">Deposit paid</option><option value="paid">Paid</option>
        </select>
      </label>
      <label className="md:col-span-4"><span className="label">Products / notes</span><input className="input" value={f.description} onChange={set("description")} /></label>
      <div className="flex items-center gap-3 md:col-span-4">
        <button className="btn-primary">Create PO</button>
        {err && <span className="text-sm text-red-700">{err}</span>}
      </div>
    </form>
  );
}
