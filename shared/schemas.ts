import { z } from "zod";

// Input rules shared by the API (enforced) and the web app (early feedback).

const text = (max: number) => z.string().trim().max(max);
const cents = z.number().int().min(0).max(1_000_000_000);

export const ROLES = ["admin", "manager", "sales"] as const;
export type Role = (typeof ROLES)[number];

export const loginSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });
export const passwordSchema = z
  .string()
  .min(10, "At least 10 characters")
  .max(200)
  .refine((p) => /[a-z]/i.test(p) && /\d/.test(p), "Use letters and at least one number");
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema });
export const userCreateSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: passwordSchema, name: text(120).min(2), role: z.enum(ROLES) });
export const userUpdateSchema = z.object({ name: text(120).min(2), role: z.enum(ROLES), active: z.boolean() });
export const resetPasswordSchema = z.object({ password: passwordSchema });

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
export const settingsSchema = z.object({
  dealerName: text(120).min(1),
  dealerPhone: text(40),
  websiteUrl: z.union([z.literal(""), z.string().url().max(300)]),
  currency: z.string().regex(/^[A-Z]{3}$/, "3-letter code like GBP"),
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "Like en-GB"),
  /** Automated messages wait until the end of quiet hours. */
  quietStart: hhmm,
  quietEnd: hhmm,
  /** At most this many automated messages to one buyer in 7 days. */
  maxAutoPerWeek: z.number().int().min(0).max(20),
});

// ---- stock ----
export const VEHICLE_STATUSES = ["available", "reserved", "sold", "withdrawn"] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

const photoUrl = z.string().trim().url().max(500).refine((u) => /^https:\/\//.test(u), "Photos must be https links");
export const vehicleSchema = z.object({
  stockNo: text(20).min(1, "Enter the stock number").transform((s) => s.toUpperCase()),
  vin: text(17)
    .transform((v) => v.toUpperCase())
    .refine((v) => v === "" || /^[A-HJ-NPR-Z0-9]{17}$/.test(v), "A VIN is 17 letters and numbers (no I, O or Q)"),
  year: z.number().int().min(1950).max(2100),
  make: text(40).min(1, "Enter the make"),
  model: text(60).min(1, "Enter the model"),
  trim: text(60),
  mileage: z.number().int().min(0).max(2_000_000),
  fuel: z.enum(["Petrol", "Diesel", "Hybrid", "Electric", "Other"]),
  transmission: z.enum(["Manual", "Automatic"]),
  body: text(40),
  colour: text(40),
  priceCents: cents,
  description: text(6000),
  photos: z.array(photoUrl).max(40),
  status: z.enum(VEHICLE_STATUSES),
});
export const vehicleUpdateSchema = z.intersection(vehicleSchema, z.object({ version: z.number().int() }));

// ---- channels ----
export const CHANNEL_KINDS = ["sandbox", "webhook", "feed"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const SANDBOX_RULESETS = ["autos", "classifieds"] as const;

export const channelConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sandbox"), ruleset: z.enum(SANDBOX_RULESETS), failRate: z.number().min(0).max(1) }),
  z.object({
    kind: z.literal("webhook"),
    url: z.string().url().max(500).refine((u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u), "Use https (http only for localhost)"),
  }),
  z.object({ kind: z.literal("feed"), format: z.enum(["csv", "xml"]) }),
]);
export const channelSchema = z.object({ name: text(80).min(2), enabled: z.boolean(), config: channelConfigSchema });

// ---- inbox ----
export const inboundSchema = z.object({
  messageId: z.string().trim().min(1).max(100),
  threadId: z.string().trim().min(1).max(100),
  /** Our stock number or the channel's listing id. */
  listingRef: z.string().trim().min(1).max(100),
  buyer: z.object({
    name: text(120).min(1),
    email: z.union([z.literal(""), z.string().trim().toLowerCase().email().max(200)]).default(""),
    phone: text(40).default(""),
  }),
  text: z.string().trim().min(1).max(4000),
  sentAt: z.string().datetime({ offset: true }).optional(),
});
export const replySchema = z.object({ text: z.string().trim().min(1).max(4000) });

// ---- follow-up rules ----
export const RULE_TRIGGERS = ["new_enquiry", "no_reply", "price_drop", "sold"] as const;
export type RuleTrigger = (typeof RULE_TRIGGERS)[number];
export const TEMPLATE_FIELDS = ["buyer_first_name", "vehicle", "price", "old_price", "dealer_name", "dealer_phone", "link"] as const;
export const ruleSchema = z.object({
  name: text(80).min(2),
  trigger: z.enum(RULE_TRIGGERS),
  /** new_enquiry: minutes after the enquiry; no_reply: minutes of silence after our last message. */
  delayMinutes: z.number().int().min(0).max(60 * 24 * 30),
  template: text(1500)
    .min(5)
    .refine((t) => [...t.matchAll(/\{(\w+)\}/g)].every((m) => (TEMPLATE_FIELDS as readonly string[]).includes(m[1])), {
      message: `Only these fields: ${TEMPLATE_FIELDS.map((f) => `{${f}}`).join(" ")}`,
    }),
  enabled: z.boolean(),
});
