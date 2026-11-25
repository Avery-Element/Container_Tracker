import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type PurchaseOrder } from "../api";
import { useApi } from "../components/ui";
import { CARRIERS, carrierFromMbl } from "../../shared/carriers";
import { findContainerNumbers, isValidContainerNumber } from "../../shared/container-number";

export default function NewShipment() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { data: pos } = useApi<PurchaseOrder[]>("/pos?status=open");
  const [poIds, setPoIds] = useState<number[]>(params.get("po") ? [Number(params.get("po"))] : []);
  const [f, setF] = useState({ mode: "ocean", carrier_scac: "", mbl: "", reference: "", forwarder: "", eta: "", containers: "" });
  const [track, setTrack] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // What the "Creating shipment" popup shows; null when nothing is being saved.
  const [step, setStep] = useState<"saving" | "tracking" | null>(null);
  // Set straight away on submit, so a second click is ignored even before React re-renders.
  const submitting = useRef(false);
  // One key per form: if "Create shipment" reaches the server twice, it returns the same shipment.
  const clientKey = useRef(crypto.randomUUID());
  // Booking from a PO line: start with that PO's estimated ETA.
  const fromPo = pos?.find((p) => p.id === Number(params.get("po")));
  useEffect(() => {
    if (fromPo?.eta) setF((prev) => (prev.eta ? prev : { ...prev, eta: fromPo.eta!.slice(0, 10) }));
  }, [fromPo?.eta]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    const next = { ...f, [k]: e.target.value };
    if (k === "mbl" && !f.carrier_scac) {
      const c = carrierFromMbl(e.target.value);
      if (c) next.carrier_scac = c.scac;
    }
    setF(next);
  };
  const containers = findContainerNumbers(f.containers);

  return (
    <form
      className="card mx-auto max-w-3xl space-y-4 p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        if (submitting.current) return;
        submitting.current = true;
        setErr(null);
        setStep("saving");
        try {
          const { id } = await api.post<{ id: number }>("/shipments", { ...f, po_ids: poIds, containers, client_key: clientKey.current });
          if (track && f.mode === "ocean") {
            setStep("tracking");
            await api.post(`/shipments/${id}/track`).catch(() => undefined);
          }
          nav(`/shipments/${id}`);
        } catch (e) {
          setErr((e as Error).message);
          setStep(null);
          submitting.current = false;
        }
      }}
    >
      <h1 className="text-3xl font-semibold">New shipment</h1>
      <div>
        <span className="label">Purchase orders on this shipment</span>
        <div className="flex flex-wrap gap-2">
          {poIds.map((id) => {
            const p = pos?.find((x) => x.id === id);
            return (
              <span key={id} className="rounded-full bg-route-50 px-2 py-0.5 text-sm text-route-dark">
                {p?.po_number ?? id} {p?.vendor && <span className="ml-1 text-slate-500">{p.vendor}</span>}{" "}
                <button type="button" onClick={() => setPoIds(poIds.filter((x) => x !== id))}>×</button>
              </span>
            );
          })}
          <select className="input max-w-64" value="" onChange={(e) => e.target.value && setPoIds([...poIds, Number(e.target.value)])}>
            <option value="">Add PO…</option>
            {pos?.filter((p) => !poIds.includes(p.id)).map((p) => (
              <option key={p.id} value={p.id}>{p.po_number} ({p.vendor})</option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label><span className="label">Mode</span>
          <select className="input" value={f.mode} onChange={set("mode")}>
            <option value="ocean">Ocean</option><option value="air">Air</option><option value="parcel">Parcel</option>
          </select>
        </label>
        {f.mode === "ocean" ? (
          <>
            <label><span className="label">Carrier master BL or booking #</span>
              <input className="input font-mono" placeholder="EGLV093600315607" value={f.mbl} onChange={set("mbl")} />
            </label>
            <label><span className="label">Carrier</span>
              <select className="input" value={f.carrier_scac} onChange={set("carrier_scac")}>
                <option value="">—</option>
                {CARRIERS.map((c) => <option key={c.scac} value={c.scac}>{c.name}</option>)}
              </select>
            </label>
          </>
        ) : (
          <label className="md:col-span-2"><span className="label">Tracking # / AWB</span>
            <input className="input" value={f.reference} onChange={set("reference")} />
          </label>
        )}
        <label><span className="label">Forwarder</span><input className="input" placeholder="THI / SEKO" value={f.forwarder} onChange={set("forwarder")} /></label>
        <label><span className="label">ETA (if known)</span><input type="date" className="input" value={f.eta} onChange={set("eta")} /></label>
      </div>
      {f.mode === "ocean" && (
        <label className="block"><span className="label">Container numbers (one per line, optional)</span>
          <textarea className="input h-20 font-mono" value={f.containers} onChange={set("containers")} />
          <div className="mt-1 flex flex-wrap gap-2 text-xs">
            {containers.map((c) => (
              <span key={c} className={isValidContainerNumber(c) ? "text-emerald-700" : "text-amber-700"}>
                {c} {isValidContainerNumber(c) ? "✓" : "⚠ check digit"}
              </span>
            ))}
          </div>
        </label>
      )}
      {f.mode === "ocean" && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} />
          Start live tracking right away. Needs a carrier BL (EGLV…, COSU…, ONEY…) or a container number. A forwarder house bill alone won't work.
        </label>
      )}
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={step !== null}>{step ? "Creating…" : "Create shipment"}</button>
        {err && <span className="text-sm text-red-700">{err}</span>}
      </div>
      {step && <CreatingPopup step={step} />}
    </form>
  );
}

/** Covers the page while the shipment is saved and tracking starts, so nobody clicks twice. */
function CreatingPopup({ step }: { step: "saving" | "tracking" }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="creating-title" className="w-full max-w-sm rounded-[3px] bg-ink p-6 text-white">
        <div className="flex items-center gap-3">
          <span aria-hidden className="size-5 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <h2 id="creating-title" className="font-display text-xl font-semibold">Creating shipment</h2>
        </div>
        <ol className="mt-4 space-y-2 text-sm" aria-live="polite">
          <li className={step === "saving" ? "text-white" : "text-white/60"}>
            {step === "saving" ? "Saving shipment…" : "Shipment saved ✓"}
          </li>
          {step === "tracking" && (
            <li>Starting live tracking. The carrier lookup can take up to 30 seconds.</li>
          )}
        </ol>
        <p className="mt-4 text-xs text-white/60">Please wait. You'll go to the shipment when it's done.</p>
      </div>
    </div>
  );
}
