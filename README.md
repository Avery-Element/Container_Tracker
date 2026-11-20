# Container Tracker

Internal web app that tracks inbound POs and containers from booking to receipt at ELM. It replaces the manually updated "Order Status - Container" spreadsheet.

**Stack:**
- one Cloudflare Worker: a Hono API plus a React (Vite) single-page app;
- Cloudflare D1 database;
- Cloudflare Access for login;
- TimeToCargo for live container tracking;
- Resend for email alerts.

## How it works

**Milestones**

| Stage | Who updates it |
|---|---|
| PO placed → Cargo ready → Booked | You, in the app (PO page / New shipment) |
| Loaded → Departed → Transshipment → Arrived → Discharged → Out-gated | TimeToCargo, automatically (carrier data, refreshed ~twice a day) |
| Delivered to ELM → Received | You (container row → "Set status…") |

**Entered by hand:** ELM delivery appointment. Click the cell in the Shipments table or on the shipment page. (Last Free Day is managed outside this app; TimeToCargo doesn't provide it.)

**How each shipment gets tracked.** If the shipment has a carrier master BL (`EGLV…`, `COSU…`, `ONEY…`, `OOLU…`, `YMJA…`, `HDMU…`), the app tracks the BL. That counts as **one** TimeToCargo shipment however many containers it covers. Forwarder house bills (`SHZS…`, `OT…`, `THI…`) aren't visible to carriers, so for those it tracks each container number, and each container counts separately.

**Billing.** When a shipment is marked Received or Cancelled (or its last container is received), its TimeToCargo tracking is archived, so it stops counting against the monthly quota.

**Alerts** are emailed as soon as they happen:
- the ETA moves by more than a day;
- a container is discharged;
- the carrier reports the shipment as stuck/delayed;
- tracking fails.

**Daily digest** at 7am Pacific: everything in transit, plus POs awaiting booking.

**Scheduled jobs** (Cron Triggers):
- every 6 hours: start tracking any new active shipments, refresh all tracked ones in one API call (a backup in case webhooks are missed), and archive finished ones;
- once a day: send the digest.

## Local development

```bash
npm install
npm run import:csv -- "Order Status - Container.csv"   # -> data/import.sql + data/import-report.md
npm run db:migrate:local
npm run db:seed:local
npm run dev                                            # http://localhost:5173
npm test
```

Check `data/import-report.md` for rows that need fixing by hand, such as bad container numbers or unreadable dates. Re-running the seed **replaces** all data, so it refuses to run on a database that has any PO History (see [ADR 0001](docs/adr/0001-po-history-is-a-permanent-record.md)). To start your local copy over, delete the `.wrangler/state` folder, then run the migrate and seed commands again.

To test live tracking locally, copy `.dev.vars.example` to `.dev.vars`, fill in `TIMETOCARGO_API_KEY`, restart `npm run dev`, and click **Sync tracking** on the Shipments tab. Locally, updates only arrive when you click Sync or Refresh, because webhooks can't reach your PC.

## Deploying to Cloudflare (one-time setup)

1. **Log in and create the database:**
   ```bash
   npx wrangler login
   npx wrangler d1 create container-tracker
   ```
   Paste the printed `database_id` into `wrangler.jsonc`.

2. **Edit `vars` in `wrangler.jsonc`:**
   - `ALERT_FROM`: a sender on your domain, e.g. `Container Tracker <tracker@yourdomain.com>`;
   - `ALERT_TO`: comma-separated recipients;
   - `APP_URL`: e.g. `https://tracker.yourdomain.com`.

3. **Create the schema and load the data** (first setup only; the seed refuses to run once PO History exists):
   ```bash
   npm run db:migrate:remote
   npx wrangler d1 execute container-tracker --remote --file=data/import.sql
   ```

4. **Deploy:** `npm run deploy`. Then in the dashboard, go to Workers → container-tracker → Settings → Domains & Routes and add a custom domain such as `tracker.yourdomain.com`.

5. **Set up Cloudflare Access** (Zero Trust → Access → Applications → Add → Self-hosted):
   - Application domain: `tracker.yourdomain.com`.
   - Policy: Allow, with your company email domain or a list of specific emails.
   - Add a second application for `tracker.yourdomain.com/api/webhooks/timetocargo` with a **Bypass** policy for Everyone, so TimeToCargo can deliver updates. That path checks its own HMAC signature instead.
   - Copy the application's **Audience (AUD) tag** and your team domain (`<team>.cloudflareaccess.com`).
   - Add both to `vars` as `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`, then redeploy.
   - Until both are set, the API refuses every request except from localhost.
   - In Workers → Settings → Domains & Routes, consider turning off the `workers.dev` URL.

6. **Set up Resend:** add your domain in Resend and create the DNS records it shows in Cloudflare DNS. Then:
   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```

7. **Set up TimeToCargo:**
   1. Create an API key in your TimeToCargo account under "API for Developers".
   2. Store it: `npx wrangler secret put TIMETOCARGO_API_KEY`.
   3. Create a webhook in TimeToCargo with callback URL `https://tracker.yourdomain.com/api/webhooks/timetocargo`. Choose the events `tracking.eta_update`, `tracking.history_update`, `tracking.info_found`, `tracking.info_not_found` and `tracking.delivered`.
   4. Copy the signing secret. It's shown only once. Store it: `npx wrangler secret put TIMETOCARGO_WEBHOOK_SECRET`.
   5. Use TimeToCargo's "send test" to confirm delivery. `npx wrangler tail` should show the request returning 200; a 401 means the secret doesn't match.
   6. Active shipments start tracking at the next 6-hourly run, or straight away with **Sync tracking**.

**Testing the scheduled jobs by hand:** `POST /api/admin/digest`. This is behind Access.

## Project layout

```
migrations/0001_init.sql     D1 schema
scripts/import-csv.ts        one-time spreadsheet import (scripts/lib/* = parser)
shared/                      container check digit, carrier→SCAC map, milestones, normalisers
worker/index.ts              Worker entry: webhook, Access check, API, cron handler
worker/routes/api.ts         REST API used by the UI
worker/lib/timetocargo.ts    TimeToCargo API client + webhook signature check
worker/lib/sync.ts           start/refresh/archive tracking, webhook handling, change detection
worker/lib/alerts.ts         alert dedupe, daily digest
src/                         React UI (Dashboard, Shipments, Shipment detail, POs, New shipment)
tests/                       vitest: parser + sync/alert logic
```

## Known limits / next steps

- Air and parcel shipments (UPS/FedEx/DHL) are tracked by hand. A parcel-tracking API could be added later.
- TimeToCargo carrier codes come from `GET /v2/companies`. Yang Ming is `YMLU` and Maersk is `MAEI`; see `shared/carriers.ts`.
- Carrier data refreshes about twice a day, and some carriers (e.g. Evergreen) send no explicit departure/arrival events. The app infers departure from later events and uses the carrier's summary ETA.
- The spreadsheet's "ETA (Port)" column often holds the warehouse delivery date. Imported ETAs are replaced by carrier data on the first sync, and that first sync doesn't raise an ETA-change alert.
- Existing databases need `npm run db:migrate:local` / `db:migrate:remote` to apply `0002_timetocargo.sql`.
