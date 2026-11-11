// Carrier name normalisation and SCAC mapping.

export interface Carrier {
  name: string;
  scac: string;
  /** Prefixes used on the carrier's own master bill of lading numbers. */
  mblPrefixes: string[];
  /** Code TimeToCargo expects, when it differs from `scac` (see GET /v2/companies). */
  ttcCode?: string;
}

export const CARRIERS: Carrier[] = [
  { name: "Yang Ming", scac: "YMLU", mblPrefixes: ["YMJA", "YMLU"] },
  { name: "Evergreen", scac: "EGLV", mblPrefixes: ["EGLV"] },
  { name: "COSCO", scac: "COSU", mblPrefixes: ["COSU"] },
  { name: "HMM", scac: "HDMU", mblPrefixes: ["HDMU"] },
  { name: "ONE", scac: "ONEY", mblPrefixes: ["ONEY"] },
  { name: "OOCL", scac: "OOLU", mblPrefixes: ["OOLU"] },
  { name: "CMA CGM", scac: "CMDU", mblPrefixes: ["CMDU"] },
  { name: "Hapag-Lloyd", scac: "HLCU", mblPrefixes: ["HLCU"] },
  { name: "Maersk", scac: "MAEU", mblPrefixes: ["MAEU"], ttcCode: "MAEI" },
  { name: "MSC", scac: "MEDU", mblPrefixes: ["MEDU"] },
];

const ALIASES: Record<string, string> = {
  yangming: "Yang Ming",
  youngming: "Yang Ming",
  ym: "Yang Ming",
  evergreen: "Evergreen",
  emc: "Evergreen",
  cosco: "COSCO",
  hmm: "HMM",
  hyundai: "HMM",
  one: "ONE",
  oocl: "OOCL",
  cmacgm: "CMA CGM",
  cma: "CMA CGM",
  hapaglloyd: "Hapag-Lloyd",
  hapag: "Hapag-Lloyd",
  maersk: "Maersk",
  msc: "MSC",
};

export function normalizeCarrier(raw: string | null | undefined): Carrier | null {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  const name = ALIASES[key];
  return name ? (CARRIERS.find((c) => c.name === name) ?? null) : null;
}

export function carrierByScac(scac: string | null | undefined): Carrier | null {
  if (!scac) return null;
  return CARRIERS.find((c) => c.scac === scac.toUpperCase()) ?? null;
}

/** Carrier whose master BL prefix matches this number (e.g. "EGLV0936..." -> Evergreen). */
export function carrierFromMbl(mbl: string | null | undefined): Carrier | null {
  if (!mbl) return null;
  const up = mbl.toUpperCase();
  return CARRIERS.find((c) => c.mblPrefixes.some((p) => up.startsWith(p))) ?? null;
}

/** Carrier code to send to TimeToCargo. */
export function ttcCompany(scac: string): string {
  return carrierByScac(scac)?.ttcCode ?? scac;
}

export type TrackingPlan =
  | { type: "bill_of_lading"; number: string; scac: string }
  | { type: "container"; numbers: string[]; scac: string }
  | { type: "none"; reason: string };

/**
 * Decide how to ask the tracking API for a shipment. A carrier master BL is
 * best; forwarder house bills (SHZS..., THI..., W2...) are not visible to the
 * carriers, so fall back to tracking by container number.
 */
export function planTracking(opts: {
  mbl: string | null;
  scac: string | null;
  containers: string[];
}): TrackingPlan {
  const mblCarrier = carrierFromMbl(opts.mbl);
  if (mblCarrier && opts.mbl) {
    return { type: "bill_of_lading", number: opts.mbl.toUpperCase(), scac: mblCarrier.scac };
  }
  if (!opts.scac) return { type: "none", reason: "No ocean carrier set" };
  if (opts.containers.length > 0) {
    return { type: "container", numbers: opts.containers, scac: opts.scac };
  }
  return { type: "none", reason: "Need a carrier master BL or a container number" };
}
