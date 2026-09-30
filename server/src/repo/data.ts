import { randomUUID } from "node:crypto";
import type { Queryable } from "../db";
import { DEFAULT_SETTINGS } from "../../../shared/automation";
import type { Settings, Vehicle } from "../../../shared/types";

export const newId = (prefix: string) => `${prefix}-${randomUUID()}`;

export async function getSettings(c: Queryable): Promise<Settings> {
  const { rows } = await c.query<{ value: Partial<Settings> }>("SELECT value FROM settings WHERE key = 'app'");
  return { ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}) };
}

export async function saveSettings(c: Queryable, s: Settings) {
  await c.query("INSERT INTO settings (key, value) VALUES ('app', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [JSON.stringify(s)]);
}

export async function audit(
  c: Queryable,
  e: { userId: string | null; action: string; entity: string; entityId?: string | null; details?: Record<string, unknown>; ip?: string | null },
) {
  await c.query("INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip) VALUES ($1, $2, $3, $4, $5, $6)", [
    e.userId,
    e.action,
    e.entity,
    e.entityId ?? null,
    JSON.stringify(e.details ?? {}),
    e.ip ?? null,
  ]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toVehicle(r: any): Vehicle {
  return {
    id: r.id,
    stockNo: r.stock_no,
    vin: r.vin,
    year: r.year,
    make: r.make,
    model: r.model,
    trim: r.trim,
    mileage: r.mileage,
    fuel: r.fuel,
    transmission: r.transmission,
    body: r.body,
    colour: r.colour,
    priceCents: r.price_cents,
    description: r.description,
    photos: r.photos,
    status: r.status,
    version: r.version,
    createdAt: (r.created_at as Date).toISOString(),
  };
}

/** Formats money in the dealer's currency for message templates. */
export function moneyFormatter(s: Settings) {
  let f: Intl.NumberFormat;
  try {
    f = new Intl.NumberFormat(s.locale, { style: "currency", currency: s.currency, maximumFractionDigits: 0 });
  } catch {
    f = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
  }
  return (cents: number) => f.format(Math.round(cents / 100));
}
