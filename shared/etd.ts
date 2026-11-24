// How close a PO's estimated ETD is, so the logistics coordinator knows when to chase the vendor.
// Only meaningful for POs that are still awaiting booking.

/** Days ahead that count as "coming up". */
export const ETD_SOON_DAYS = 7;

export type EtdUrgency = { level: "overdue" | "soon"; days: number } | null;

/** "overdue" when the ETD has passed, "soon" when it is today or within ETD_SOON_DAYS, otherwise null. Dates are YYYY-MM-DD. */
export function etdUrgency(today: string, etd: string | null | undefined): EtdUrgency {
  if (!etd) return null;
  const days = Math.round((Date.parse(etd.slice(0, 10)) - Date.parse(today)) / 86_400_000);
  if (Number.isNaN(days)) return null;
  if (days < 0) return { level: "overdue", days };
  if (days <= ETD_SOON_DAYS) return { level: "soon", days };
  return null;
}
