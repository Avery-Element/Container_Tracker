export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // vars
  ALERT_FROM: string;
  ALERT_TO: string; // comma-separated
  APP_URL: string;
  ACCESS_TEAM_DOMAIN?: string; // e.g. "yourteam.cloudflareaccess.com"
  ACCESS_AUD?: string; // Access application audience tag
  // secrets
  TIMETOCARGO_API_KEY?: string;
  TIMETOCARGO_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
}
