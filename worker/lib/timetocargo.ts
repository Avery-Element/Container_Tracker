// TimeToCargo v2 API client. Spec: https://timetocargo.com/docs/openapi.json
// Auth is an `api_key` query parameter. Single tracking is limited to
// 8 requests/minute, so we create tracking through the batch endpoint.

const BASE = "https://tracking.timetocargo.com/v2";

export type NumberType = "container" | "bl" | "bk";

export interface TtcLocWithDate {
  location: number | null;
  terminal: number | null;
  date: string | null;
}

export interface TtcEvent {
  location: number | null;
  terminal: number | null;
  status: string | null;
  status_code: string | null;
  date: string | null;
  actual: boolean | null;
  vessel: string | null;
  voyage: string | null;
}

export interface TtcTrackingData {
  summary?: { origin?: TtcLocWithDate; pol?: TtcLocWithDate; pod?: TtcLocWithDate; destination?: TtcLocWithDate };
  locations?: { id: number; name: string | null; state: string | null; country: string | null }[];
  terminals?: { id: number; name: string | null }[];
  containers?: { number: string; type: string | null; iso_code?: string | null; events: TtcEvent[] }[];
  shipment_status?: "IN_TRANSIT" | "DELIVERED" | "UNKNOWN" | "STUCK";
  references?: { booking_numbers: string[]; bill_of_lading_numbers: string[] };
  tracking_metadata?: { id: string; status: string } | null;
}

export interface TtcResult {
  success: boolean;
  status: string; // OK | INFO_NOT_FOUND | LINE_IS_UNDER_MAINTENANCE | LINE_NO_RESPONSE | UNEXPECTED_ERROR
  status_description: string | null;
  data: TtcTrackingData | null;
  request?: { track_number: { type?: NumberType; value: string }; company: string };
}

export interface TtcListItem {
  id: string;
  status: string;
  track_number: string;
  tracked_item: {
    track_number: string;
    track_number_type: NumberType | null;
    data: { success: boolean; status: string; status_description: string | null; data: TtcTrackingData | null } | null;
    updated_at: string | null;
  };
}

export class TtcError extends Error {
  constructor(message: string, public status: string) {
    super(message);
  }
}

async function call<T extends { success?: boolean; status?: string; status_description?: string | null }>(
  apiKey: string,
  path: string,
  params: Record<string, string> = {},
  init?: RequestInit,
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
  });
  const text = await res.text();
  let json: T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    throw new TtcError(`TimeToCargo HTTP ${res.status}: ${text.slice(0, 200)}`, "HTTP_ERROR");
  }
  // Request-level failures (bad key, quota, rate limit) come back in `status`.
  const fatal = ["WRONG_PARAMS", "API_KEY_WRONG", "API_KEY_LIMIT_REACHED", "API_KEY_RATE_LIMIT", "LOW_BALANCE", "SERVICE_UNAVAILABLE", "UNEXPECTED_ERROR"];
  if (!res.ok || (json.status && fatal.includes(json.status))) {
    throw new TtcError(
      `TimeToCargo ${json.status ?? res.status}: ${json.status_description ?? text.slice(0, 200)}`,
      json.status ?? "HTTP_ERROR",
    );
  }
  return json;
}

export interface BatchItem {
  company: string;
  value: string;
  type: NumberType;
}

/** Start tracking up to 500 numbers. Returns a task id to poll with getBatch. */
export async function createBatch(apiKey: string, items: BatchItem[]): Promise<string> {
  const body = {
    tracked_items: items.map((i) => ({ company: i.company, track_number: { value: i.value, type: i.type } })),
  };
  const json = await call<{ data: { task_id: string } | null; status: string }>(apiKey, "/tracking/batch", {}, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!json.data?.task_id) throw new TtcError("TimeToCargo returned no task id", json.status);
  return json.data.task_id;
}

export async function getBatch(apiKey: string, taskId: string) {
  const json = await call<{
    data: { task_id: string; status: "CREATED" | "HANDLING" | "PROCESSED"; results?: TtcResult[] } | null;
    status: string;
  }>(apiKey, "/tracking/batch", { task_id: taskId });
  return json.data;
}

/** All active tracked shipments on the account, with their latest data. */
export async function listActive(apiKey: string): Promise<TtcListItem[]> {
  const out: TtcListItem[] = [];
  for (let page = 1; page <= 20; page++) {
    const json = await call<{
      data: { data: TtcListItem[] | null; meta?: { totalPages?: number } } | null;
      status: string;
    }>(apiKey, "/shipments", { status: "ACTIVE", limit: "500", page: String(page) });
    out.push(...(json.data?.data ?? []));
    if (!json.data?.meta?.totalPages || page >= json.data.meta.totalPages) break;
  }
  return out;
}

/** Stop tracking (archive) so finished shipments stop counting against the monthly quota. */
export async function archive(apiKey: string, ids: string[]) {
  if (!ids.length) return;
  await call(apiKey, "/shipments", {}, { method: "DELETE", body: JSON.stringify({ shipmentIds: ids }) });
}

/**
 * Verify `x-timetocargo-signature: sha256=<hmac>` where the HMAC-SHA256 is
 * computed over `${timestamp}.${rawBody}`. Accepts hex or base64 digests.
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  now = Date.now(),
): Promise<boolean> {
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  const tsMs = ts > 1e12 ? ts : ts * 1000;
  if (!Number.isFinite(ts) || Math.abs(now - tsMs) > 15 * 60_000) return false; // replay window
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)),
  );
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const b64 = btoa(String.fromCharCode(...mac));
  const given = signature.trim().replace(/^sha256=/i, "");
  return [hex, b64, b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")].some((exp) =>
    safeEqual(exp, exp === hex ? given.toLowerCase() : given),
  );
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
