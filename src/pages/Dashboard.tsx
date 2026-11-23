import { Fragment } from "react";
import { Link } from "react-router-dom";
import { api, type Container, type Dashboard as D, type Shipment } from "../api";
import { daysFrom, EditableDate, ErrorBox, EtaWithSlip, fmtDate, Holds, PaymentBadge, PoLinks, useApi, VoyageTrack } from "../components/ui";
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

function firstEta(r: Row) {
  return r.c?.original_eta ?? r.s.original_eta;
}

function riskReasons(r: Row, today: string): string[] {
  const out: string[] = [];
  if (r.c?.holds) out.push("On hold");
  const slip = daysFrom(r.s.original_eta?.slice(0, 10) ?? "", r.s.eta);
  if (r.s.original_eta && slip !== null && slip > 1) out.push(`ETA slipped ${slip}d`);
  if (r.s.tracking_status === "failed") out.push("Tracking failed");
  return out;
}

/** "Today", "Tomorrow", "In 4 days", "2 days ago" for a date relative to today. */
function relativeDay(d: number): string {
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  return d > 0 ? `In ${d} days` : `${-d} days ago`;
}

function weekday(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
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
  // Arrivals grouped by ETA day, in date order.
  const byDay = new Map<string, Row[]>();
  for (const r of arriving) {
    const day = eta(r)!.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), r]);
  }
  const counts = Object.fromEntries(data.byMilestone.map((m) => [m.milestone, m.n]));

  return (
    <div className="space-y-6">
      {atRisk.length > 0 ? (
        <section className="card overflow-x-auto border-l-4! border-l-hazard!">
          <div className="flex items-baseline gap-3 px-4 pt-4">
            <h2 className="text-base font-semibold text-slate-900">Needs attention</h2>
            <span className="text-sm text-slate-600">
              {atRisk.length} {atRisk.length === 1 ? "container" : "containers"}
            </span>
          </div>
          <table className="data mt-2">
            <thead>
              <tr>
                <th>Container</th><th>PO</th><th>Vendor</th><th>Problem</th><th>Status</th><th>ETA</th>
              </tr>
            </thead>
            <tbody>
              {atRisk.map(({ r, why }) => (
                <tr key={`${r.s.id}-${r.c?.id}`}>
                  <td><ShipLink r={r} /></td>
                  <td><PoLinks pos={r.s.pos} /></td>
                  <td>{r.s.vendor}</td>
                  <td className="font-medium text-slate-900">{why.join(", ")}</td>
                  <td className="whitespace-nowrap">{r.c && <VoyageTrack milestone={r.c.milestone} />} <Holds holds={r.c?.holds ?? null} /></td>
                  <td><EtaWithSlip eta={eta(r)} first={firstEta(r)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <p className="text-sm text-slate-600">Nothing needs attention: no holds, slipped ETAs or tracking failures.</p>
      )}

      <section className="card p-4">
        <h2 className="mb-4 text-base font-semibold text-slate-900">Pipeline</h2>
        <Pipeline
          stops={[
            { key: "awaiting", label: "Awaiting booking", n: data.pendingPos.length, to: "/shipments" },
            ...MILESTONES.filter((m) => !["po_placed", "cargo_ready", "on_hold", "received"].includes(m.key)).map((m) => ({
              key: m.key,
              label: m.label,
              n: counts[m.key] ?? 0,
              hold: m.key === "discharged" ? counts.on_hold ?? 0 : 0,
            })),
          ]}
        />
      </section>

      <section className="card overflow-x-auto">
        <div className="flex items-baseline gap-3 px-4 pt-4">
          <h2 className="text-base font-semibold text-slate-900">Arrivals</h2>
          <span className="text-sm text-slate-600">
            {arriving.length} {arriving.length === 1 ? "container" : "containers"} due in the next 14 days
          </span>
        </div>
        <table className="data mt-2">
          <thead>
            <tr>
              <th>Port ETA</th><th>Container</th><th>PO</th><th>Vendor</th><th>Carrier</th><th>Status</th><th>ELM delivery</th>
            </tr>
          </thead>
          <tbody>
            {arriving.length === 0 && (
              <tr><td colSpan={7} className="text-slate-500">Nothing due in the next two weeks.</td></tr>
            )}
            {[...byDay].map(([day, group]) => {
              const d = daysFrom(today, day) ?? 0;
              return (
                <Fragment key={day}>
                  {group.map((r, i) => (
                    <tr key={`${r.s.id}-${r.c?.id}`} className={i === 0 ? "[&>td]:border-t [&>td]:border-t-slate-300" : ""}>
                      {i === 0 && (
                        <td rowSpan={group.length} className="w-32 whitespace-nowrap border-r border-r-slate-100">
                          <div className={`font-semibold ${d < 0 ? "text-hold" : "text-slate-900"}`}>
                            {weekday(day)} {fmtDate(day)}
                          </div>
                          <div className={`text-xs ${d < 0 ? "text-hold" : "text-slate-600"}`}>{relativeDay(d)}</div>
                        </td>
                      )}
                      <td><ShipLink r={r} /></td>
                      <td><PoLinks pos={r.s.pos} /></td>
                      <td>{r.s.vendor}</td>
                      <td>{r.s.carrier_name ?? <span className="capitalize">{r.s.mode}</span>}</td>
                      <td className="whitespace-nowrap">
                        {r.c ? <VoyageTrack milestone={r.c.milestone} /> : <span className="capitalize">{r.s.mode}</span>}
                        <EtaSlipNote r={r} />
                      </td>
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
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card overflow-x-auto">
          <h2 className="px-4 pt-4 text-base font-semibold text-slate-900">Awaiting booking, by cargo-ready date</h2>
          <table className="data mt-2">
            <thead>
              <tr><th>PO</th><th>Vendor</th><th>Cargo ready</th><th>Payment</th></tr>
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
          <h2 className="px-4 pt-4 text-base font-semibold text-slate-900">Recent alerts</h2>
          <ul className="divide-y divide-slate-100 p-2 text-sm">
            {data.alerts.length === 0 && <li className="px-2 py-2 text-slate-500">No alerts yet. They appear once live tracking is on.</li>}
            {data.alerts.map((a) => (
              <li key={a.id} className="flex gap-3 px-2 py-2">
                <span className="w-16 shrink-0 text-xs text-slate-600">{fmtDate(a.created_at)}</span>
                <Link to={`/shipments/${a.shipment_id}`} className="hover:underline">{a.message}</Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

/** On the arrivals board the date is the group heading, so only the slip is shown beside the status. */
function EtaSlipNote({ r }: { r: Row }) {
  const first = firstEta(r);
  const slip = first && eta(r) ? daysFrom(first.slice(0, 10), eta(r)) : null;
  if (!slip || slip <= 1) return null;
  return (
    <span
      title={`First published ETA: ${fmtDate(first)}`}
      className="ml-2 rounded-sm bg-hazard px-1 text-[11px] font-semibold tabular-nums text-slate-900"
    >
      +{slip}d
    </span>
  );
}

interface Stop {
  key: string;
  label: string;
  n: number;
  hold?: number;
  to?: string;
}

/** Counts at each stop along one line, like a transit map: where every container is right now. */
function Pipeline({ stops }: { stops: Stop[] }) {
  return (
    <div className="overflow-x-auto pb-1">
      <ol className="grid min-w-[46rem]" style={{ gridTemplateColumns: `repeat(${stops.length}, minmax(0, 1fr))` }}>
        {stops.map((s, i) => {
          const empty = s.n === 0;
          return (
            <li key={s.key} className="flex flex-col items-center text-center">
              <span className={`text-2xl font-semibold tabular-nums ${empty ? "text-slate-300" : "text-slate-900"}`}>{s.n}</span>
              <span className="relative my-1.5 flex h-3 w-full items-center justify-center" aria-hidden>
                <span
                  className={`absolute h-0.5 bg-slate-300 ${i === 0 ? "left-1/2 right-0" : i === stops.length - 1 ? "left-0 right-1/2" : "inset-x-0"}`}
                />
                <span
                  className={`relative size-3 rounded-full ${empty ? "border-2 border-slate-300 bg-white" : "bg-route"} ${
                    s.hold ? "ring-2 ring-hold ring-offset-1" : ""
                  }`}
                />
              </span>
              <span className={`px-1 text-xs leading-tight ${empty ? "text-slate-500" : "font-medium text-slate-800"}`}>
                {s.to ? <Link to={s.to} className="hover:underline">{s.label}</Link> : s.label}
              </span>
              {s.hold ? <span className="mt-0.5 text-xs font-semibold text-hold">{s.hold} on hold</span> : null}
            </li>
          );
        })}
      </ol>
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
