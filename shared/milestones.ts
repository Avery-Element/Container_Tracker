export const MILESTONES = [
  { key: "po_placed", label: "PO placed", source: "manual" },
  { key: "cargo_ready", label: "Cargo ready", source: "manual" },
  { key: "booked", label: "Booked", source: "manual" },
  { key: "loaded", label: "Loaded at origin", source: "api" },
  { key: "departed", label: "Departed", source: "api" },
  { key: "transshipment", label: "Transshipment", source: "api" },
  { key: "arrived", label: "Arrived at port", source: "api" },
  { key: "discharged", label: "Discharged", source: "api" },
  { key: "on_hold", label: "On hold", source: "api" },
  { key: "available", label: "Available for pickup", source: "api" },
  { key: "outgated", label: "Out-gated", source: "api" },
  { key: "delivered", label: "Delivered to ELM", source: "manual" },
  { key: "received", label: "Received", source: "manual" },
] as const;

export type MilestoneKey = (typeof MILESTONES)[number]["key"];

export const MILESTONE_ORDER: Record<string, number> = Object.fromEntries(
  MILESTONES.map((m, i) => [m.key, i]),
);

export function milestoneLabel(key: string): string {
  return MILESTONES.find((m) => m.key === key)?.label ?? key;
}

/** TimeToCargo event status codes -> our ladder and a readable label. */
export const TTC_EVENTS: Record<string, { milestone: MilestoneKey; label: string }> = {
  CEP: { milestone: "booked", label: "Empty container to shipper" },
  CPS: { milestone: "loaded", label: "Picked up at shipper" },
  CGI: { milestone: "loaded", label: "Gated in at origin port" },
  CLL: { milestone: "loaded", label: "Loaded on vessel" },
  VDL: { milestone: "departed", label: "Vessel departed origin" },
  VAT: { milestone: "transshipment", label: "Arrived at transshipment port" },
  CDT: { milestone: "transshipment", label: "Discharged at transshipment port" },
  TSD: { milestone: "transshipment", label: "Transshipment delay" },
  CLT: { milestone: "transshipment", label: "Loaded at transshipment port" },
  VDT: { milestone: "transshipment", label: "Departed transshipment port" },
  LTS: { milestone: "transshipment", label: "Land transshipment" },
  BTS: { milestone: "transshipment", label: "Barge transshipment" },
  VAD: { milestone: "arrived", label: "Vessel arrived at destination port" },
  CDD: { milestone: "discharged", label: "Discharged at destination port" },
  CGO: { milestone: "outgated", label: "Gated out" },
  CDC: { milestone: "outgated", label: "Delivered to consignee" },
  CER: { milestone: "outgated", label: "Empty returned" },
};

/** Never move a container backwards on the ladder (except hold <-> available). */
export function advanceMilestone(current: string, next: string): string {
  const a = MILESTONE_ORDER[current] ?? -1;
  const b = MILESTONE_ORDER[next] ?? -1;
  const holdSwap =
    (current === "on_hold" && next === "available") ||
    (current === "available" && next === "on_hold");
  return b > a || holdSwap ? next : current;
}
