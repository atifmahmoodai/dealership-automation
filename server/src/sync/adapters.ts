// How each kind of channel receives listings and messages.
//   sandbox  a built-in pretend marketplace, stored in sandbox_listings, with optional random failures
//   webhook  signed JSON POSTs to any HTTPS endpoint (a partner API, n8n, Zapier, your own service)
//   feed     nothing is pushed; the channel reads a CSV/XML feed from its secret URL
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Queryable } from "../db";
import type { ListingPayload } from "../../../shared/automation";

export interface ChannelRow {
  id: string;
  name: string;
  kind: "sandbox" | "webhook" | "feed";
  enabled: boolean;
  config: { ruleset?: string; failRate?: number; url?: string; format?: string };
  secret: string;
}

/** A refusal the channel won't change its mind about (bad data, unknown listing): don't retry. */
export class PermanentError extends Error {}
/** Worth trying again later (timeouts, 5xx, rate limits). */
export class RetryableError extends Error {}

export interface Outcome {
  externalId?: string;
  status: number | null;
  detail: string;
}

export interface Adapter {
  upsert(ch: ChannelRow, externalId: string | null, p: ListingPayload): Promise<Outcome>;
  remove(ch: ChannelRow, externalId: string): Promise<Outcome>;
  sendMessage(ch: ChannelRow, threadId: string, text: string): Promise<Outcome>;
}

// ---- webhook signing ----

/** Signature over "timestamp.body": the receiver checks it and rejects stale timestamps (replays). */
export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifySignature(secret: string, timestamp: string | undefined, body: string, signature: string | undefined, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > 5 * 60_000) return false;
  const want = Buffer.from(sign(secret, timestamp, body), "hex");
  return timingSafeEqual(want, Buffer.from(signature, "hex"));
}

// ---- adapters ----

export function sandboxAdapter(db: Queryable, random: () => number = Math.random): Adapter {
  const maybeFail = (ch: ChannelRow) => {
    if (random() < (ch.config.failRate ?? 0)) throw new RetryableError("Sandbox: 503 Service Unavailable (simulated)");
  };
  return {
    async upsert(ch, externalId, p) {
      maybeFail(ch);
      // Derived from the car, so a create retried after a crash updates the same listing instead of duplicating it.
      const id = externalId ?? `SBX-${createHash("sha256").update(`${ch.id}:${p.ref}`).digest("hex").slice(0, 10).toUpperCase()}`;
      await db.query(
        `INSERT INTO sandbox_listings (channel_id, external_id, payload) VALUES ($1, $2, $3)
         ON CONFLICT (channel_id, external_id) DO UPDATE SET payload = EXCLUDED.payload, removed = false, updated_at = now()`,
        [ch.id, id, JSON.stringify(p)],
      );
      return { externalId: id, status: externalId ? 200 : 201, detail: `${externalId ? "Updated" : "Created"} ${id}: ${p.title}, ${p.price} ${p.currency}` };
    },
    async remove(ch, externalId) {
      maybeFail(ch);
      await db.query("UPDATE sandbox_listings SET removed = true, updated_at = now() WHERE channel_id = $1 AND external_id = $2", [ch.id, externalId]);
      return { status: 200, detail: `Removed ${externalId}` };
    },
    async sendMessage(ch, threadId, text) {
      maybeFail(ch);
      return { externalId: `MSG-${randomUUID().slice(0, 8)}`, status: 201, detail: `Message on thread ${threadId}: ${text.slice(0, 60)}` };
    },
  };
}

export function webhookAdapter(fetchImpl: typeof fetch = fetch): Adapter {
  async function post(ch: ChannelRow, event: string, data: unknown): Promise<Outcome & { json: Record<string, unknown> }> {
    const body = JSON.stringify({ event, id: randomUUID(), data });
    const ts = String(Math.floor(Date.now() / 1000));
    let res: Response;
    try {
      res = await fetchImpl(ch.config.url!, {
        method: "POST",
        headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sign(ch.secret, ts, body), "user-agent": "dealership-automation/1" },
        body,
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch (e) {
      throw new RetryableError(`Could not reach ${new URL(ch.config.url!).host}: ${(e as Error).message}`);
    }
    const text = (await res.text()).slice(0, 2000);
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`${res.status} from ${new URL(ch.config.url!).host}: ${text.slice(0, 200)}`);
    if (!res.ok) throw new PermanentError(`${res.status} from ${new URL(ch.config.url!).host}: ${text.slice(0, 200)}`);
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // a 2xx with a non-JSON body is still success
    }
    return { status: res.status, detail: text.slice(0, 300), json };
  }
  return {
    async upsert(ch, externalId, p) {
      const r = await post(ch, externalId ? "listing.updated" : "listing.created", { externalId, listing: p });
      const id = typeof r.json.externalId === "string" && r.json.externalId ? r.json.externalId : (externalId ?? p.ref);
      return { externalId: id, status: r.status, detail: r.detail };
    },
    async remove(ch, externalId) {
      return post(ch, "listing.removed", { externalId });
    },
    async sendMessage(ch, threadId, text) {
      const r = await post(ch, "message.send", { threadId, text });
      return { ...r, externalId: typeof r.json.messageId === "string" ? r.json.messageId : undefined };
    },
  };
}

/** Feeds are pulled by the channel, so "publishing" just marks the car as in the feed. */
export const feedAdapter: Adapter = {
  async upsert(_ch, externalId, p) {
    return { externalId: externalId ?? p.ref, status: null, detail: `In the feed: ${p.title}` };
  },
  async remove(_ch, externalId) {
    return { status: null, detail: `Out of the feed: ${externalId}` };
  },
  async sendMessage() {
    throw new PermanentError("Feed channels can't carry messages");
  },
};

export interface Adapters {
  sandbox: Adapter;
  webhook: Adapter;
  feed: Adapter;
}

export const adapterFor = (a: Adapters, ch: ChannelRow) => a[ch.kind];
