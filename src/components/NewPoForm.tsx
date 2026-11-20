import { useState } from "react";
import { api } from "../api";
import { EditableDate, useApi } from "./ui";
import { PAYMENT_STATUSES } from "../../shared/payment";

export default function NewPoForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const { data: vendors } = useApi<{ id: number; name: string }[]>("/vendors");
  const [f, setF] = useState({ po_number: "", vendor: "", vendor_pi: "", order_date: "", crd: "", payment_status: "not_paid", paid_date: "", forwarder: "", description: "" });
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
          const { paid_date, ...po } = f;
          const dateField = f.payment_status === "paid" ? "paid_on" : f.payment_status === "deposit_paid" ? "deposit_paid_on" : null;
          await api.post("/pos", dateField ? { ...po, [dateField]: paid_date } : po);
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
        <select
          className="input"
          value={f.payment_status}
          onChange={(e) => setF({ ...f, payment_status: e.target.value, paid_date: f.paid_date || localToday() })}
        >
          <option value="not_paid">Not paid</option><option value="deposit_paid">Deposit paid</option><option value="paid">Paid</option>
        </select>
      </label>
      {f.payment_status !== "not_paid" && (
        <label><span className="label">{f.payment_status === "paid" ? "Paid on" : "Deposit paid on"}</span>
          <input required type="date" className="input" max={localToday()} value={f.paid_date} onChange={set("paid_date")} />
        </label>
      )}
      <label className="md:col-span-4"><span className="label">Products / notes</span><input className="input" value={f.description} onChange={set("description")} /></label>
      <div className="flex items-center gap-3 md:col-span-4">
        <button className="btn-primary" disabled={saving}>{saving ? "Creating…" : "Create PO"}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        {err && <span className="text-sm text-red-700">{err}</span>}
      </div>
    </form>
  );
}

/** Today's date on this computer, as YYYY-MM-DD. */
export const localToday = () => new Date().toLocaleDateString("en-CA");

type PaymentPatch = { payment_status?: string; deposit_paid_on?: string | null; paid_on?: string | null };

/**
 * Payment status picker for a PO. Not paid saves at once; Deposit paid and Paid ask for the
 * date the money moved (default today) and save status + date together. The date of the
 * current status is shown next to it and can be clicked to correct it.
 * Shows any legacy free-text value the import brought in until it is changed.
 */
export function PaymentSelect({
  po,
  onSave,
}: {
  po: { payment_status: string | null; deposit_paid_on?: string | null; paid_on?: string | null };
  onSave: (patch: PaymentPatch) => Promise<void>;
}) {
  const [pending, setPending] = useState<"deposit_paid" | "paid" | null>(null);
  const [date, setDate] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = po.payment_status;
  const dateField = value === "paid" ? "paid_on" : value === "deposit_paid" ? "deposit_paid_on" : null;

  const save = async (patch: PaymentPatch) => {
    setErr(null);
    setSaving(true);
    try {
      await onSave(patch);
      setPending(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (pending)
    return (
      <form
        className="flex flex-wrap items-center gap-1 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          save({ payment_status: pending, [pending === "paid" ? "paid_on" : "deposit_paid_on"]: date });
        }}
      >
        <label className="flex items-center gap-1">
          {pending === "paid" ? "Paid on" : "Deposit paid on"}
          <input autoFocus required type="date" className="input w-auto! py-0.5! text-xs!" value={date} max={localToday()} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button className="btn-primary px-2! py-0.5! text-xs!" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" className="btn px-2! py-0.5! text-xs!" onClick={() => (setPending(null), setErr(null))}>Cancel</button>
        {err && <span className="text-red-700">{err}</span>}
      </form>
    );

  return (
    <span className="flex flex-wrap items-center gap-1 text-xs">
      <select
        className="input w-auto! py-0.5! text-xs!"
        aria-label="Payment status"
        value={value ?? ""}
        disabled={saving}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "not_paid") return void save({ payment_status: v });
          if (v === "deposit_paid" || v === "paid") {
            setDate((v === "paid" ? po.paid_on : po.deposit_paid_on) ?? localToday());
            setPending(v);
          }
        }}
      >
        {!value && <option value="" disabled>Payment —</option>}
        <option value="not_paid">Not paid</option>
        <option value="deposit_paid">Deposit paid</option>
        <option value="paid">Paid</option>
        {value && !PAYMENT_STATUSES.includes(value as never) && <option value={value} disabled>{value}</option>}
      </select>
      {dateField && (
        <span className="flex items-center text-slate-500" title={dateField === "paid_on" ? "Date paid" : "Date deposit paid"}>
          on
          <EditableDate value={po[dateField]} placeholder="+ date" onSave={(d) => save({ [dateField]: d })} />
        </span>
      )}
      {err && <span className="text-red-700">{err}</span>}
    </span>
  );
}
