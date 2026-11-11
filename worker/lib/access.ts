// Verifies the Cloudflare Access JWT (Cf-Access-Jwt-Assertion) so the API
// can't be reached by bypassing Access. Enabled when ACCESS_TEAM_DOMAIN and
// ACCESS_AUD are set.

import type { Env } from "../env";

interface Jwk extends JsonWebKey {
  kid: string;
}

let cachedKeys: { at: number; keys: Jwk[] } | null = null;

async function getKeys(team: string): Promise<Jwk[]> {
  if (cachedKeys && Date.now() - cachedKeys.at < 3_600_000) return cachedKeys.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  const json = (await res.json()) as { keys: Jwk[] };
  cachedKeys = { at: Date.now(), keys: json.keys };
  return json.keys;
}

function b64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** Returns the authenticated email, or null if the token is missing/invalid. */
export async function verifyAccess(env: Env, req: Request): Promise<string | null> {
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { kid: string; alg: string };
  const payload = JSON.parse(new TextDecoder().decode(b64url(p))) as {
    aud: string | string[];
    exp: number;
    iss: string;
    email?: string;
  };
  const jwk = (await getKeys(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== "RS256") return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64url(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!ok || !aud.includes(env.ACCESS_AUD) || payload.exp * 1000 < Date.now()) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  return payload.email ?? "unknown";
}
