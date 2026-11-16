import { useState } from "react";
import { api } from "../api";
import { useApi } from "./ui";

export default function NewPoForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const { data: vendors } = useApi<{ id: number; name: string }[]>("/vendors");
  const [f, setF] = useState({ po_number: "", vendor: "", vendor_pi: "", order_date: "", crd: "", payment_status: "not_paid", forwarder: "", description: "" });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="card grid gap-3 p-4 md:grid-cols-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        setErr(null);
        try {
          await api.post("/pos", f);
          onCreated();
        } catch (e) {
          setErr((e as Error).message);
        }
        setSaving(false);
      }}
    >
      <h2 className="text-sm font-semibold text-slate-700 md:col-span-4">New purchase order</h2>
      <label><span className="label">PO #</span><input required autoFocus className="input" placeholder="6200ELM" value={f.po_number} onChange={set("po_number")} /></label>
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
        <button className="btn-primary" disabled={saving}>{saving ? "Creating…" : "Create PO"}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        {err && <span className="text-sm text-red-700">{err}</span>}
      </div>
    </form>
  );
}

/** Payment status picker for a PO; shows any legacy free-text value the import brought in. */
export function PaymentSelect({ value, onChange, className = "input w-auto! py-0.5! text-xs!" }: { value: string | null; onChange: (v: string) => void; className?: string }) {
  return (
    <select className={className} aria-label="Payment status" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">Payment —</option>
      <option value="not_paid">Not paid</option>
      <option value="deposit_paid">Deposit paid</option>
      <option value="paid">Paid</option>
      {value && !["not_paid", "deposit_paid", "paid"].includes(value) && <option value={value}>{value}</option>}
    </select>
  );
}
