// Which Tracking Events go into PO History (see GLOSSARY.md, "Origin departure").
//
// Up to Origin departure every raw carrier event is logged. From departure on, only
// Milestone changes are logged (the "Departed" milestone marks the departure itself).

import { MILESTONE_ORDER } from "./milestones";

/** TimeToCargo codes that only happen once the vessel has left the port of loading. */
export const AFTER_DEPARTURE = ["VDL", "VAT", "CDT", "TSD", "CLT", "VDT", "VAD", "CDD", "CGO", "CDC", "CER"];

/**
 * Log this raw Tracking Event? True for events before Origin departure.
 * `departedAt` is when the vessel left the port of loading, if known.
 */
export function isOriginEvent(code: string | null | undefined, date: string | null | undefined, departedAt: string | null): boolean {
  if (!code || code === "VDL") return false; // the departure itself is logged as the Departed milestone
  // Once the departure time is known, go by date: some codes (e.g. CGO gate-out) happen at both ends.
  if (departedAt && date) return date <= departedAt;
  return !AFTER_DEPARTURE.includes(code);
}

/** Log this Milestone change? True from Departed onwards; earlier steps are covered by raw events. */
export function isVoyageMilestone(milestone: string): boolean {
  return (MILESTONE_ORDER[milestone] ?? -1) >= (MILESTONE_ORDER.departed ?? 0);
}
