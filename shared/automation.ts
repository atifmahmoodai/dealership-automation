// Rules shared by the API, the worker and the web app. Pure functions, tested in automation.test.ts.
import type { ChannelKind, RuleTrigger } from "./schemas";
import type { Settings, Vehicle } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  dealerName: "Your Dealership",
  dealerPhone: "",
  websiteUrl: "",
  currency: "GBP",
  locale: "en-GB",
  quietStart: "20:00",
  quietEnd: "08:00",
  maxAutoPerWeek: 3,
};

// ---- what each marketplace accepts ----

export interface ChannelRules {
  label: string;
  titleMax: number;
  descriptionMax: number;
  photosMin: number;
  photosMax: number;
  minPriceCents: number;
  needsVin: boolean;
  /** Reserved cars stay listed (marked reserved) on channels that support it, else they come down. */
  showsReserved: boolean;
  messaging: boolean;
}

export const RULES: Record<string, ChannelRules> = {
  "sandbox:autos": { label: "Sandbox Autos", titleMax: 60, descriptionMax: 4000, photosMin: 1, photosMax: 20, minPriceCents: 100_000, needsVin: true, showsReserved: true, messaging: true },
  "sandbox:classifieds": { label: "Sandbox Classifieds", titleMax: 40, descriptionMax: 1000, photosMin: 0, photosMax: 10, minPriceCents: 50_000, needsVin: false, showsReserved: false, messaging: true },
  webhook: { label: "Webhook", titleMax: 200, descriptionMax: 6000, photosMin: 0, photosMax: 40, minPriceCents: 1, needsVin: false, showsReserved: true, messaging: true },
  feed: { label: "Inventory feed", titleMax: 200, descriptionMax: 6000, photosMin: 1, photosMax: 40, minPriceCents: 1, needsVin: true, showsReserved: false, messaging: false },
};

export function rulesFor(kind: ChannelKind, config: { ruleset?: string }): ChannelRules {
  return kind === "sandbox" ? RULES[`sandbox:${config.ruleset ?? "autos"}`] : RULES[kind];
}

export const vehicleTitle = (v: Pick<Vehicle, "year" | "make" | "model" | "trim">) => [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");

export interface Check {
  errors: string[];
  warnings: string[];
}

/** Whether a car can go on a channel as it stands. Errors block publishing; warnings are fixed automatically. */
export function checkVehicle(v: Vehicle, r: ChannelRules): Check {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (v.priceCents < r.minPriceCents) errors.push(v.priceCents === 0 ? "Needs a price" : `Price is below this site's minimum`);
  if (r.needsVin && !v.vin) errors.push("Needs the VIN");
  if (v.photos.length < r.photosMin) errors.push(`Needs at least ${r.photosMin} photo${r.photosMin === 1 ? "" : "s"}`);
  if (v.photos.length > r.photosMax) warnings.push(`Only the first ${r.photosMax} of ${v.photos.length} photos will be sent`);
  if (vehicleTitle(v).length > r.titleMax) warnings.push(`Title shortened to ${r.titleMax} characters`);
  if (v.description.length > r.descriptionMax) warnings.push(`Description cut to ${r.descriptionMax} characters`);
  if (!v.description.trim()) warnings.push("No description");
  return { errors, warnings };
}

export function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface ListingPayload {
  ref: string;
  title: string;
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  mileage: number;
  fuel: string;
  transmission: string;
  body: string;
  colour: string;
  price: number;
  currency: string;
  description: string;
  photos: string[];
  reserved: boolean;
}

/** The listing exactly as a channel receives it. */
export function renderListing(v: Vehicle, r: ChannelRules, currency: string): ListingPayload {
  return {
    ref: v.stockNo,
    title: shorten(vehicleTitle(v), r.titleMax),
    vin: v.vin,
    year: v.year,
    make: v.make,
    model: v.model,
    trim: v.trim,
    mileage: v.mileage,
    fuel: v.fuel,
    transmission: v.transmission,
    body: v.body,
    colour: v.colour,
    price: v.priceCents / 100,
    currency,
    description: shorten(v.description, r.descriptionMax),
    photos: v.photos.slice(0, r.photosMax),
    reserved: v.status === "reserved",
  };
}

/** Should the car be on this channel at all, given its status? */
export function shouldBeListed(status: Vehicle["status"], r: ChannelRules): boolean {
  return status === "available" || (status === "reserved" && r.showsReserved);
}

/** Stable text for hashing: key order fixed, so the same listing always hashes the same. */
export function canonical(p: ListingPayload): string {
  return JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k as keyof ListingPayload]]));
}

// ---- follow-up messages ----

export interface TemplateData {
  buyerName: string;
  vehicle: string;
  priceCents: number;
  oldPriceCents?: number;
  dealerName: string;
  dealerPhone: string;
  link: string;
}

export function renderTemplate(t: string, d: TemplateData, money: (cents: number) => string): string {
  const first = d.buyerName.trim().split(/\s+/)[0] || "there";
  const values: Record<string, string> = {
    buyer_first_name: first,
    vehicle: d.vehicle,
    price: money(d.priceCents),
    old_price: d.oldPriceCents === undefined ? "" : money(d.oldPriceCents),
    dealer_name: d.dealerName,
    dealer_phone: d.dealerPhone,
    link: d.link,
  };
  return t.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m).replace(/[ \t]+\n/g, "\n").trim();
}

export const TRIGGER_LABEL: Record<RuleTrigger, string> = {
  new_enquiry: "New enquiry",
  no_reply: "Buyer went quiet",
  price_drop: "Price dropped",
  sold: "Car sold",
};

/** Words that mean "stop messaging me". */
export const isOptOut = (text: string) => /^\s*(stop|unsubscribe|opt[\s-]?out|remove me|no more messages)\s*[.!]*\s*$/i.test(text);

// ---- quiet hours ----

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Local wall-clock minutes-of-day for an instant in a time zone. */
export function localMinutes(at: Date, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  return Number(p.hour) * 60 + Number(p.minute);
}

/** The first moment at or after `at` that is outside quiet hours. Quiet hours may wrap midnight. */
export function nextSendTime(at: Date, quietStart: string, quietEnd: string, timeZone: string): Date {
  const start = minutes(quietStart);
  const end = minutes(quietEnd);
  if (start === end) return at;
  const now = localMinutes(at, timeZone);
  const quiet = start < end ? now >= start && now < end : now >= start || now < end;
  if (!quiet) return at;
  let wait = end - now;
  if (wait <= 0) wait += 24 * 60;
  const t = new Date(at.getTime() + wait * 60_000);
  t.setUTCSeconds(0, 0);
  // Across a daylight-saving change the wall clock can land an hour off: nudge until we're outside.
  for (let i = 0; i < 3 && localMinutes(t, timeZone) !== end && isQuiet(t, start, end, timeZone); i++) t.setTime(t.getTime() + 30 * 60_000);
  return t;
}

function isQuiet(at: Date, start: number, end: number, tz: string) {
  const now = localMinutes(at, tz);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

// ---- retries ----

/** Wait before retry n (1-based): 30s, 2m, 8m, 32m, ~2h, capped at 6h. */
export const retryDelayMs = (attempt: number) => Math.min(30_000 * 4 ** (attempt - 1), 6 * 3600_000);
export const MAX_ATTEMPTS = 6;
