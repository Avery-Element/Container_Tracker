import { Link } from "react-router-dom";
import { api, type Container, type Dashboard as D, type Shipment } from "../api";
import { daysFrom, EditableDate, ErrorBox, fmtDate, Holds, MilestoneBadge, PaymentBadge, PoLinks, useApi } from "../components/ui";
import { MILESTONES } from "../../shared/milestones";

export interface Row {
  s: Shipment;
  c: Container | null;
}

export function flatten(shipments: Shipment[]): Row[] {
  return shipments.flatMap((s): Row[] =>
    s.containers.length
      ? s.containers.filter((c) => c.milestone !== "received").map((c) => ({ s, c }))
      : [{ s, c: null }],
  );
}

function eta(r: Row) {
  return r.c?.eta ?? r.s.eta;
}

function riskReasons(r: Row, today: string): string[] {
  const out: string[] = [];
  if (r.c?.holds) out.push("On hold");
  const slip = daysFrom(r.s.original_eta?.slice(0, 10) ?? "", r.s.eta);
  if (r.s.original_eta && slip !== null && slip > 1) out.push(`ETA slipped ${slip}d`);
  if (r.s.tracking_status === "failed") out.push("Tracking failed");
  return out;
}

export default function Dashboard() {
  const { data, error, reload } = useApi<D>("/dashboard");
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="text-sm text-slate-500">Loading…</p>;

  const rows = flatten(data.active);
  const today = data.today;
  const atRisk = rows.map((r) => ({ r, why: riskReasons(r, today) })).filter((x) => x.why.length);
  const arriving = rows
    .filter((r) => {
      const d = daysFrom(today, eta(r));
      return d !== null && d >= -3 && d <= 14 && !["outgated", "delivered"].includes(r.c?.milestone ?? "");
    })
    .sort((a, b) => (eta(a) ?? "").localeCompare(eta(b) ?? ""));
  const counts = Object.fromEntries(data.byMilestone.map((m) => [m.milestone, m.n]));
  const inTransit = rows.filter((r) => r.c).length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Containers in progress" value={inTransit} />
        <Kpi label="Arriving next 14 days" value={arriving.length} />
        <Kpi label="Need attention" value={atRisk.length} tone={atRisk.length ? "red" : undefined} />
        <Kpi label="POs awaiting booking" value={data.pendingPos.length} />
      </div>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Pipeline</h2>
        <div className="flex flex-wrap gap-2">
          <Stage label="Awaiting booking" n={data.pendingPos.length} />
          {MILESTONES.filter((m) => !["po_placed", "cargo_ready", "received"].includes(m.key)).map((m) => (
            <Stage key={m.key} label={m.label} n={counts[m.key] ?? 0} highlight={m.key === "on_hold"} />
          ))}
        </div>
      </section>

      {atRisk.length > 0 && (
        <section className="card overflow-x-auto">
          <h2 className="px-4 pt-4 text-sm font-semibold text-red-700">Needs attention</h2>
          <table className="data mt-2">
            <thead>
              <tr>
                <th>Container</th><th>PO</th><th>Vendor</th><th>Status</th><th>Why</th><th>ETA</th>
              </tr>
            </thead>
            <tbody>
              {atRisk.map(({ r, why }) => (
                <tr key={`${r.s.id}-${r.c?.id}`}>
                  <td><ShipLink r={r} /></td>
                  <td><PoLinks pos={r.s.pos} /></td>
                  <td>{r.s.vendor}</td>
                  <td>{r.c && <MilestoneBadge milestone={r.c.milestone} />} <Holds holds={r.c?.holds ?? null} /></td>
                  <td className="font-medium text-red-700">{why.join(" · ")}</td>
                  <td>{fmtDate(eta(r))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card overflow-x-auto">
        <h2 className="px-4 pt-4 text-sm font-semibold text-slate-700">Arriving soon</h2>
        <table className="data mt-2">
          <thead>
            <tr>
              <th>ETA</th><th>Container</th><th>PO</th><th>Vendor</th><th>Carrier</th><th>Status</th><th>ELM delivery</th>
            </tr>
          </thead>
          <tbody>
            {arriving.length === 0 && (
              <tr><td colSpan={7} className="text-slate-500">Nothing due in the next two weeks.</td></tr>
            )}
            {arriving.map((r) => (
              <tr key={`${r.s.id}-${r.c?.id}`}>
                <td className="whitespace-nowrap font-medium">{fmtDate(eta(r))}</td>
                <td><ShipLink r={r} /></td>
                <td><PoLinks pos={r.s.pos} /></td>
                <td>{r.s.vendor}</td>
                <td>{r.s.carrier_name ?? r.s.mode}</td>
                <td>{r.c ? <MilestoneBadge milestone={r.c.milestone} /> : r.s.mode}</td>
                <td className="whitespace-nowrap">
                  {r.c ? (
                    <EditableDate
                      withTime
                      value={r.c.elm_delivery_appt}
                      onSave={async (v) => (await api.patch(`/containers/${r.c!.id}`, { elm_delivery_appt: v }), reload())}
                    />
                  ) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card overflow-x-auto">
          <h2 className="px-4 pt-4 text-sm font-semibold text-slate-700">Awaiting booking (by cargo-ready date)</h2>
          <table className="data mt-2">
            <thead>
              <tr><th>PO</th><th>Vendor</th><th>CRD</th><th>Payment</th></tr>
            </thead>
            <tbody>
              {data.pendingPos.map((p) => (
                <tr key={p.id}>
                  <td className="font-medium"><PoLinks pos={[p]} /></td>
                  <td>{p.vendor}</td>
                  <td>{fmtDate(p.crd)}</td>
                  <td><PaymentBadge status={p.payment_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2 className="px-4 pt-4 text-sm font-semibold text-slate-700">Recent alerts</h2>
          <ul className="divide-y divide-slate-100 p-2 text-sm">
            {data.alerts.length === 0 && <li className="px-2 py-2 text-slate-500">No alerts yet. They appear once live tracking is on.</li>}
            {data.alerts.map((a) => (
              <li key={a.id} className="flex gap-3 px-2 py-2">
                <span className="w-16 shrink-0 text-xs text-slate-400">{fmtDate(a.created_at)}</span>
                <Link to={`/shipments/${a.shipment_id}`} className="hover:underline">{a.message}</Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "red" }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-3xl font-semibold ${tone === "red" ? "text-red-700" : "text-slate-900"}`}>{value}</div>
    </div>
  );
}

function Stage({ label, n, highlight }: { label: string; n: number; highlight?: boolean }) {
  return (
    <div
      className={`min-w-24 rounded-md border px-3 py-2 ${
        n === 0 ? "border-slate-100 text-slate-400" : highlight ? "border-red-200 bg-red-50 text-red-800" : "border-teal-100 bg-teal-50 text-teal-900"
      }`}
    >
      <div className="text-lg font-semibold">{n}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}

export function ShipLink({ r }: { r: Row }) {
  return (
    <Link to={`/shipments/${r.s.id}`} className="font-mono text-teal-800 hover:underline">
      {r.c?.number ?? r.s.reference ?? r.s.mbl ?? `#${r.s.id}`}
      {r.c && !r.c.number_valid && <span title="Check digit invalid — verify number" className="ml-1 text-amber-600">⚠</span>}
    </Link>
  );
}
