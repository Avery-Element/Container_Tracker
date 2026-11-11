// Turns the manually-maintained "Order Status - Container" CSV into normalized
// POs / shipments / containers. Pure functions so they can be unit-tested.

import { parse } from "csv-parse/sync";
import {
  findContainerNumbers,
  isValidContainerNumber,
} from "../../shared/container-number";
import { normalizeCarrier } from "../../shared/carriers";
import {
  inferYear,
  normalizePayment,
  normalizeVendor,
  parseTime,
  parseUSDate,
} from "../../shared/normalize";

export interface ParsedContainer {
  number: string;
  valid: boolean;
  received: boolean;
  apptDate: string | null; // ISO date of ELM delivery appointment
  apptTime: string | null; // HH:MM
  flags: string[]; // HOT, DELAY, EXAM ...
  size: string | null;
}

export interface ParsedRow {
  line: number; // 1-based line in the CSV file where the row starts
  orderDate: string | null;
  vendorPi: string | null;
  vendor: string | null;
  poNumbers: string[];
  payment: string | null;
  forwarder: string | null;
  carrierRaw: string | null;
  carrierName: string | null;
  scac: string | null;
  mbls: string[];
  mode: "ocean" | "air" | "parcel" | null; // null = no shipment yet (PO stage)
  reference: string | null; // tracking # for air/parcel
  containers: ParsedContainer[];
  received: boolean;
  cancelled: boolean;
  portEta: string | null;
  crd: string | null;
  etd: string | null;
  notes: string | null;
  issues: string[];
}

const NON_MBL = /^(LCL|DDP|AIR|UPS|FEDEX|DHL|NA|N\/A|COSCO|CHECK IN|AIR FREIGHT)$/i;
const PARCEL = /\b(UPS|FEDEX|DHL)\b|\b1Z[0-9A-Z ]{10,}/i;
const AIR = /\b(AIR|AWB|HAWB|FLIGHT|FLT)\b/i;

function clean(s: string | undefined): string | null {
  const t = (s ?? "").replace(/\r/g, "").trim();
  return t ? t : null;
}

function splitLines(s: string | null): string[] {
  return (s ?? "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function parsePoNumbers(raw: string | null): string[] {
  const out = new Set<string>();
  for (const m of (raw ?? "").matchAll(/(\d{4})\s*ELM/gi)) out.add(`${m[1]}ELM`);
  return [...out];
}

function parseMbls(raw: string | null): string[] {
  return splitLines(raw)
    .map((l) => l.replace(/\s+/g, "").toUpperCase())
    .filter((l) => /^[A-Z0-9]{8,}$/.test(l) && /\d{5,}/.test(l) && !NON_MBL.test(l))
    // parcel/air numbers in the MBL column aren't ocean bills
    .filter((l) => !/^1Z/.test(l) && !/^THI\d+/.test(l));
}

/** Parse one line of the Container cell, e.g. "YMMU6732705 - 1/3 8am rcvd". */
export function parseContainerLine(
  line: string,
  refIso: string | null,
): ParsedContainer[] {
  const numbers = findContainerNumbers(line);
  if (numbers.length === 0) return [];
  const lower = line.toLowerCase();
  const received = /\b(rcvd|received|receivdd)\b/.test(lower);
  const flags = ["HOT", "DELAY", "EXAM"].filter((f) => new RegExp(`\\b${f}\\b`, "i").test(line));
  const size = line.match(/\b(20GP|40GP|40HQ|45HQ|20')/i)?.[1]?.toUpperCase() ?? null;

  // appointment: first M/D after the container number
  const afterNumber = line.slice(line.search(/[A-Z]{3}[UJZ]\s?\d/i) + 10);
  let apptDate: string | null = null;
  let apptTime: string | null = null;
  const dm = afterNumber.match(/(\d{1,2})\/(\d{1,2})(?!\/\d)\s*(?:@\s*)?([0-9:]{1,5}\s*(?:am|pm)|\d{4}\b)?/i);
  if (dm && refIso) {
    apptDate = inferYear(Number(dm[1]), Number(dm[2]), refIso);
    apptTime = dm[3] ? parseTime(dm[3]) : null;
  }
  return numbers.map((number) => ({
    number,
    valid: isValidContainerNumber(number),
    received,
    apptDate,
    apptTime,
    flags,
    size,
  }));
}

function detectMode(r: {
  ff: string | null;
  carrier: string | null;
  mblCell: string | null;
  containerCell: string | null;
  hasContainers: boolean;
  hasOceanCarrier: boolean;
}): ParsedRow["mode"] {
  if (r.hasContainers) return "ocean";
  const text = [r.ff, r.carrier, r.mblCell, r.containerCell].filter(Boolean).join(" ");
  if (PARCEL.test(text) || /^\d{12,}$/.test((r.containerCell ?? "").replace(/\s/g, "")))
    return "parcel";
  if (AIR.test(text) || /\bTHI\d{6,}/.test(text) || /^\d{3}-\d{8}$/.test(r.containerCell ?? ""))
    return "air";
  if (r.hasOceanCarrier && (r.mblCell || r.containerCell)) return "ocean";
  return null;
}

export function parseRow(cells: string[], line: number): ParsedRow | null {
  const [date, pi, vendor, po, wires, ff, carrier, mbl, container, , eta, notes] = cells.map(clean);
  // Need at least one shipping/PO field; skips blank padding and side tables
  // (e.g. the vendor holiday-return list at the bottom of the sheet).
  if (!vendor && !po && !carrier && !mbl && !container) return null;

  const issues: string[] = [];
  const firstDate = splitLines(date)[0] ?? null;
  const orderDate = parseUSDate(firstDate);
  if (firstDate && !orderDate) issues.push(`Unreadable order date "${firstDate}"`);

  const etaRaw = (eta ?? "").toLowerCase();
  const received = /^(rcvd|received|rec)/.test(etaRaw);
  const portEta = received ? null : parseUSDate(eta);
  const ref = orderDate ?? portEta ?? null;

  const containers: ParsedContainer[] = [];
  for (const l of splitLines(container)) containers.push(...parseContainerLine(l, ref));
  for (const c of containers)
    if (!c.valid) issues.push(`Container ${c.number} fails ISO 6346 check digit`);

  const carrierInfo = normalizeCarrier(carrier);
  const mode = detectMode({
    ff,
    carrier,
    mblCell: mbl,
    containerCell: container,
    hasContainers: containers.length > 0,
    hasOceanCarrier: !!carrierInfo,
  });

  const allText = [container, notes, eta].filter(Boolean).join(" ");
  const crdM = allText.match(/\bCRD\s*(?:end of\s*)?(\d{1,2})\/(\d{1,2})/i);
  const crd = crdM && ref ? inferYear(Number(crdM[1]), Number(crdM[2]), ref) : null;
  const etdM = allText.match(/\bETD\s*(\d{1,2})\/(\d{1,2})/i);
  const etd = etdM && ref ? inferYear(Number(etdM[1]), Number(etdM[2]), ref) : null;
  let eta2 = portEta;
  if (!eta2) {
    const etaM = allText.match(/\bETA\s*(\d{1,2})\/(\d{1,2})/i);
    if (etaM && ref) eta2 = inferYear(Number(etaM[1]), Number(etaM[2]), ref);
  }

  const cancelled = /cancel/i.test(allText) || /cancel/i.test(mbl ?? "");
  let reference: string | null = null;
  if (mode === "air" || mode === "parcel") {
    reference = (container ?? mbl ?? "").replace(/\s+/g, " ").trim() || null;
  }

  const poNumbers = parsePoNumbers(po);
  if (poNumbers.length === 0 && po && !/^(na|sample|new po|no po)$/i.test(po.trim()))
    issues.push(`PO "${po}" not in ####ELM format`);
  if (carrier && !carrierInfo && mode === "ocean")
    issues.push(`Unknown ocean carrier "${carrier}"`);

  return {
    line,
    orderDate,
    vendorPi: pi ? splitLines(pi).join(", ") : null,
    vendor: normalizeVendor(vendor),
    poNumbers,
    payment: normalizePayment(wires),
    forwarder: ff ? ff.replace(/\s+/g, " ").toUpperCase() : null,
    carrierRaw: carrier,
    carrierName: carrierInfo?.name ?? (mode === "ocean" ? carrier : null),
    scac: carrierInfo?.scac ?? null,
    mbls: mode === "ocean" ? parseMbls(mbl) : [],
    mode,
    reference,
    containers,
    received,
    cancelled,
    portEta: eta2,
    crd,
    etd,
    notes,
    issues,
  };
}

export function parseTrackerCsv(text: string): ParsedRow[] {
  const records = parse(text, {
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
    info: true,
  }) as unknown as { record: string[]; info: { bytes: number } }[];
  const rows: ParsedRow[] = [];
  // info.bytes = bytes consumed through the end of the record; count newlines
  // up to the previous record's end to get the starting line of this one.
  const buf = new TextEncoder().encode(text);
  const dec = new TextDecoder();
  for (let i = 1; i < records.length; i++) {
    const before = dec.decode(buf.subarray(0, records[i - 1].info.bytes));
    const line = (before.match(/\n/g)?.length ?? 0) + (before.endsWith("\n") ? 1 : 2);
    const r = parseRow(records[i].record, line);
    if (r) rows.push(r);
  }
  return rows;
}
