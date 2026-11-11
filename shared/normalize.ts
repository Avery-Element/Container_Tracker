// Normalisers for messy spreadsheet values.

const VENDOR_ALIASES: Record<string, string> = {
  foshan: "Foshan",
  motostuhl: "Motostuhl",
  motosthul: "Motostuhl",
  motoshul: "Motostuhl",
  leadex: "Leadex",
  laedex: "Leadex",
  beite: "Beite",
  betie: "Beite",
  dechang: "Dechang",
  dedchang: "Dechang",
  flexspace: "FlexSpace",
  omni: "Omni",
  jiecang: "Jiecang",
  orcco: "Orcco",
  joye: "Joye",
  lumi: "Lumi",
  suzhou: "Suzhou",
};

export function normalizeVendor(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const key = t.toLowerCase().replace(/[^a-z]/g, "");
  return VENDOR_ALIASES[key] ?? t.replace(/\s+/g, " ");
}

export function normalizePayment(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/\bnot?\b.*paid|no paid/.test(t)) return "not_paid";
  if (t.includes("deposit")) return "deposit_paid";
  if (/^(paid|pad)\b|paid both/.test(t)) return "paid";
  return t;
}

export const PAYMENT_LABELS: Record<string, string> = {
  not_paid: "Not paid",
  deposit_paid: "Deposit paid",
  paid: "Paid",
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function isoDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Parse US dates like 11/9/2026, including the typos found in the tracker
 * ("5/202025", "1/282026", "7/7/20225", "5/20/0225").
 */
export function parseUSDate(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim().split(/\s+/)[0];
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,5})$/);
  if (!m) {
    const glued = t.match(/^(\d{1,2})\/(\d{1,2})(20\d{2})$/); // 5/202025 -> 5/20/2025
    if (glued) m = glued;
  }
  if (!m) return null;
  let year = Number(m[3]);
  if (m[3].length !== 4 || year < 2000) year = 2000 + Number(m[3].slice(-2));
  return isoDate(year, Number(m[1]), Number(m[2]));
}

/** Resolve a month/day with no year to the nearest sensible date on/after `ref` (minus a grace window). */
export function inferYear(month: number, day: number, refIso: string, graceDays = 75): string | null {
  const ref = new Date(refIso + "T00:00:00Z");
  for (const y of [ref.getUTCFullYear(), ref.getUTCFullYear() + 1]) {
    const iso = isoDate(y, month, day);
    if (!iso) continue;
    const diff = (new Date(iso + "T00:00:00Z").getTime() - ref.getTime()) / 86_400_000;
    if (diff >= -graceDays) return iso;
  }
  return null;
}

/** Parse "8am", "@ 0800", "10:30 am", "1pm" -> "08:00". */
export function parseTime(raw: string): string | null {
  const t = raw.toLowerCase().replace(/\s+/g, "");
  let m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3] === "pm") h += 12;
    return `${pad(h)}:${m[2] ?? "00"}`;
  }
  m = t.match(/^(\d{2})(\d{2})$/);
  if (m && Number(m[1]) < 24) return `${m[1]}:${m[2]}`;
  return null;
}
