import type { Env } from "../env";

export async function sendEmail(env: Env, subject: string, html: string): Promise<boolean> {
  const to = (env.ALERT_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!env.RESEND_API_KEY || to.length === 0) {
    console.log(`[email skipped: RESEND_API_KEY/ALERT_TO not set] ${subject}`);
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.ALERT_FROM, to, subject, html }),
  });
  if (!res.ok) {
    console.error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return false;
  }
  return true;
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
