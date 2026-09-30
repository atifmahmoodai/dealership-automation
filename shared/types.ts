// Shapes the API returns. Money is integer cents; timestamps are ISO strings.
import type { ChannelKind, Role, RuleTrigger, VehicleStatus } from "./schemas";

export interface Settings {
  dealerName: string;
  dealerPhone: string;
  websiteUrl: string;
  currency: string;
  locale: string;
  quietStart: string;
  quietEnd: string;
  maxAutoPerWeek: number;
}

export interface Meta {
  settings: Settings;
  users: { id: string; name: string; role: Role }[];
  channels: { id: string; name: string; kind: ChannelKind; enabled: boolean }[];
  today: string;
  timeZone: string;
}

export interface Vehicle {
  id: string;
  stockNo: string;
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  mileage: number;
  fuel: "Petrol" | "Diesel" | "Hybrid" | "Electric" | "Other";
  transmission: "Manual" | "Automatic";
  body: string;
  colour: string;
  priceCents: number;
  description: string;
  photos: string[];
  status: VehicleStatus;
  version: number;
  createdAt: string;
}

export type ListingState = "off" | "blocked" | "pending" | "live" | "error" | "removed";

export interface Listing {
  channelId: string;
  channelName: string;
  channelKind: ChannelKind;
  channelEnabled: boolean;
  wanted: boolean;
  state: ListingState;
  externalId: string | null;
  lastError: string | null;
  errors: string[];
  warnings: string[];
  publishedAt: string | null;
  queued: boolean;
}

export interface VehicleRow extends Vehicle {
  listings: { channelId: string; state: ListingState }[];
  openConversations: number;
}

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  config: Record<string, unknown>;
  /** Shown once to admins: signs webhooks both ways and is the feed's secret URL part. */
  secret?: string;
  feedUrl?: string;
  counts: { live: number; pending: number; error: number; blocked: number };
  queue: { queued: number; failed: number; dead: number };
}

export interface ChannelLogEntry {
  id: number;
  at: string;
  action: string;
  ok: boolean;
  status: number | null;
  durationMs: number;
  detail: string;
  stockNo: string | null;
}

export interface Conversation {
  id: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
  optedOut: boolean;
  vehicleId: string;
  vehicleTitle: string;
  stockNo: string;
  vehicleStatus: VehicleStatus;
  channelName: string;
  status: "open" | "closed";
  lastMessageAt: string;
  lastMessage: string;
  unread: boolean;
}

export interface Message {
  id: string;
  direction: "in" | "out";
  body: string;
  author: string;
  status: "received" | "scheduled" | "sent" | "failed" | "suppressed" | "cancelled";
  reason: string | null;
  sendAfter: string | null;
  sentAt: string | null;
  createdAt: string;
  ruleName: string | null;
}

export interface Rule {
  id: string;
  name: string;
  trigger: RuleTrigger;
  delayMinutes: number;
  template: string;
  enabled: boolean;
  sent7d: number;
  suppressed7d: number;
}

export interface Dashboard {
  stock: { available: number; reserved: number; soldThisMonth: number };
  channels: { id: string; name: string; live: number; error: number; blocked: number; pending: number; dead: number }[];
  inbox: { open: number; unanswered: number; newToday: number };
  automation: { sent24h: number; scheduled: number; suppressed24h: number; failed24h: number };
  attention: { kind: "dead_job" | "blocked" | "unanswered"; text: string; link: string }[];
}
