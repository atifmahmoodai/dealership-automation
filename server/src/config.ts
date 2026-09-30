import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Public origin, e.g. https://dealer.example.com. Used for links in emails and the CSRF origin check. */
  PUBLIC_URL: z.string().url().default("http://localhost:8080"),
  /** Set when running behind a reverse proxy / load balancer so client IPs and https are detected. */
  TRUST_PROXY: bool.default(false),
  /** Secure cookies need https. Defaults to on in production. */
  COOKIE_SECURE: bool.optional(),
  SESSION_TTL_HOURS: z.coerce.number().min(1).max(24 * 90).default(24 * 7),
  SESSION_IDLE_HOURS: z.coerce.number().min(0.25).max(24 * 30).default(12),
  /** IANA zone of the dealership: quiet hours for automated messages follow it. */
  TIMEZONE: z.string().default("UTC"),
  /** Built web app to serve; empty disables static serving (e.g. when a CDN serves it). */
  WEB_DIST: z.string().default("../web/dist"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(10).default(300),
  /** "inline" runs the sync/messaging worker inside the web process; "off" when a separate worker runs (npm run worker). */
  WORKER: z.enum(["inline", "off"]).default("inline"),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(500).max(600_000).default(5000),
});

export type Config = z.infer<typeof schema> & { cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  const c = parsed.data;
  if (!isValidTimeZone(c.TIMEZONE)) throw new Error(`Invalid configuration:\n  TIMEZONE: unknown time zone "${c.TIMEZONE}"`);
  return { ...c, cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === "production" };
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Today's date (YYYY-MM-DD) in the given time zone. */
/** "HH:MM" wall-clock time in the given time zone. */
export function clockIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
}

export function todayIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
