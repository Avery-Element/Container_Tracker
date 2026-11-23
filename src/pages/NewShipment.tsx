import { useState } from "react";
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
        try {
          const { id } = await api.post<{ id: number }>("/shipments", { ...f, po_ids: poIds, containers });
          if (track && f.mode === "ocean") await api.post(`/shipments/${id}/track`).catch(() => undefined);
          nav(`/shipments/${id}`);
        } catch (e) {
          setErr((e as Error).message);
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
        <button className="btn-primary">Create shipment</button>
        {err && <span className="text-sm text-red-700">{err}</span>}
      </div>
    </form>
  );
}
