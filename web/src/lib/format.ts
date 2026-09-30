import type { Settings } from "../../../shared/types";

// Money and dates follow the garage's currency and locale settings. Amounts are integer cents everywhere.
let money2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
let money0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
let locale = "en-US";
let tz = "UTC";
export function applySettings(s: Pick<Settings, "currency" | "locale">, timeZone: string) {
  try {
    money2 = new Intl.NumberFormat(s.locale, { style: "currency", currency: s.currency });
    money0 = new Intl.NumberFormat(s.locale, { style: "currency", currency: s.currency, maximumFractionDigits: 0 });
    locale = s.locale;
    tz = timeZone;
  } catch {
    // keep the previous format if the settings are somehow invalid
  }
}
const ok = (n: number | null | undefined): n is number => n !== null && n !== undefined && Number.isFinite(n);
/** 12,345.67 */
export const fmtMoney = (cents: number | null | undefined) => (ok(cents) ? money2.format(cents / 100) : "—");
/** 12,346 (for KPIs and lists). */
export const fmtMoney0 = (cents: number | null | undefined) => (ok(cents) ? money0.format(Math.round(cents / 100)) : "—");
export const fmtNum = (n: number | null | undefined) => (ok(n) ? Math.round(n).toLocaleString(locale) : "—");
export const fmtPct = (r: number | null | undefined, digits = 0) => (ok(r) ? `${(r * 100).toFixed(digits)}%` : "—");
export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric", timeZone: iso.length === 10 ? "UTC" : tz }) : "—";
export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz }) : "—";

/** "1,234.50" → 123450 cents; NaN for anything that isn't a plain amount. */
export function parseMoney(s: string): number {
  const t = s.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}
export const centsToInput = (cents: number) => (cents / 100).toFixed(2).replace(/\.00$/, "");

/** A datetime-local value ("2026-09-30T14:00") for an ISO time, in the garage's time zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** The reverse: a datetime-local value in the garage's time zone → ISO (UTC). */
export function fromLocalInput(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Find the offset the zone has at that moment (two passes settle DST edges).
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const shown = toLocalInput(new Date(guess).toISOString());
    const sm = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(shown)!;
    guess += asUtc - Date.UTC(+sm[1], +sm[2] - 1, +sm[3], +sm[4], +sm[5]);
  }
  return new Date(guess).toISOString();
}

export const STATE_LABEL: Record<string, string> = { off: "Off", blocked: "Can't list", pending: "Sending", live: "Live", error: "Failed", removed: "Removed" };
export const VEHICLE_STATUS_LABEL: Record<string, string> = { available: "Available", reserved: "Reserved", sold: "Sold", withdrawn: "Withdrawn" };
export const MESSAGE_STATUS_LABEL: Record<string, string> = { received: "Received", scheduled: "Scheduled", sent: "Sent", failed: "Failed", suppressed: "Held back", cancelled: "Cancelled" };

/** "5 min ago", "3 h ago", "2 d ago". */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = (Date.now() - Date.parse(iso)) / 60_000;
  if (m < 1) return "just now";
  if (m < 60) return `${Math.round(m)} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}
