import { Hono } from "hono";
import type { Env } from "./env";
import { api } from "./routes/api";
import { verifyAccess } from "./lib/access";
import { verifyWebhookSignature } from "./lib/timetocargo";
import { handleWebhook, syncAll } from "./lib/sync";
import { checkLastFreeDays, sendDigest } from "./lib/alerts";

const app = new Hono<{ Bindings: Env; Variables: { user: string } }>();

// TimeToCargo webhook: outside Cloudflare Access, authenticated by HMAC signature.
app.post("/api/webhooks/timetocargo", async (c) => {
  const raw = await c.req.text();
  if (!c.env.TIMETOCARGO_WEBHOOK_SECRET) return c.json({ error: "Webhook secret not configured" }, 503);
  const ok = await verifyWebhookSignature(
    c.env.TIMETOCARGO_WEBHOOK_SECRET,
    raw,
    c.req.header("x-timetocargo-signature") ?? null,
    c.req.header("x-timetocargo-timestamp") ?? null,
  );
  if (!ok) return c.json({ error: "Bad signature" }, 401);
  // Acknowledge fast (10s timeout on their side); process in the background.
  c.executionCtx.waitUntil(
    handleWebhook(c.env, JSON.parse(raw), raw).catch((e) => console.error("webhook failed", e)),
  );
  return c.json({ ok: true }, 200);
});

// Everything else under /api requires a Cloudflare Access identity when configured.
app.use("/api/*", async (c, next) => {
  const host = new URL(c.req.url).hostname;
  const local = host === "localhost" || host === "127.0.0.1";
  // `npm run dev` on your own PC: there's no Cloudflare Access login locally, so skip the check.
  // import.meta.env.DEV is false in the deployed build, so this can never apply to the live site.
  if (import.meta.env.DEV && local) {
    c.set("user", "local-dev");
    return next();
  }
  if (c.env.ACCESS_AUD && c.env.ACCESS_TEAM_DOMAIN) {
    const email = await verifyAccess(c.env, c.req.raw);
    if (!email) return c.json({ error: "Unauthorized" }, 401);
    c.set("user", email);
  } else {
    // Fail closed: without Access settings the API only answers on localhost.
    if (!local)
      return c.json({ error: "Cloudflare Access is not configured (set ACCESS_TEAM_DOMAIN and ACCESS_AUD)" }, 503);
    c.set("user", "local-dev");
  }
  await next();
});

app.route("/api", api);
app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : c.env.ASSETS.fetch(c.req.raw)));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === "0 15 * * *") {
      ctx.waitUntil(
        (async () => {
          console.log("sync:", await syncAll(env).catch((e) => String(e)));
          await checkLastFreeDays(env);
          await sendDigest(env);
        })(),
      );
    } else {
      ctx.waitUntil(
        (async () => {
          console.log("sync:", await syncAll(env).catch((e) => String(e)));
          await checkLastFreeDays(env);
        })(),
      );
    }
  },
} satisfies ExportedHandler<Env>;
