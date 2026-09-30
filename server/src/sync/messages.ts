// Buyer conversations and automated follow-ups.
// Every outgoing message, automated or typed by a person, goes through the same queue and the same
// checks at the moment of sending: opted-out buyers get nothing, automated messages respect quiet hours
// and a weekly limit per buyer, and follow-ups about a car that has gone are cancelled.
import type pg from "pg";
import { tx, type Queryable } from "../db";
import { isOptOut, nextSendTime, renderTemplate, vehicleTitle } from "../../../shared/automation";
import type { RuleTrigger } from "../../../shared/schemas";
import type { Settings } from "../../../shared/types";
import { getSettings, moneyFormatter, newId, toVehicle } from "../repo/data";
import { adapterFor, PermanentError, RetryableError, type Adapters, type ChannelRow } from "./adapters";

const MAX_SEND_ATTEMPTS = 5;

export interface InboundInput {
  messageId: string;
  threadId: string;
  listingRef: string;
  buyer: { name: string; email: string; phone: string };
  text: string;
  sentAt?: string;
}

async function rulesFor(c: Queryable, trigger: RuleTrigger) {
  const { rows } = await c.query<{ id: string; template: string; delay_minutes: number }>("SELECT id, template, delay_minutes FROM rules WHERE enabled AND trigger = $1", [trigger]);
  return rows;
}

/** Queues an automated message for a conversation. A rule fires at most once per conversation and key. */
async function scheduleRule(c: Queryable, convId: string, rule: { id: string; template: string; delay_minutes: number }, key: string, now: Date, extra: { oldPriceCents?: number } = {}) {
  const { rows } = await c.query(
    `SELECT b.name AS buyer_name, v.* FROM conversations cv JOIN buyers b ON b.id = cv.buyer_id JOIN vehicles v ON v.id = cv.vehicle_id WHERE cv.id = $1`,
    [convId],
  );
  const r = rows[0];
  const s = await getSettings(c);
  const v = toVehicle(r);
  const body = renderTemplate(
    rule.template,
    {
      buyerName: r.buyer_name,
      vehicle: vehicleTitle(v),
      priceCents: v.priceCents,
      oldPriceCents: extra.oldPriceCents,
      dealerName: s.dealerName,
      dealerPhone: s.dealerPhone,
      link: s.websiteUrl ? `${s.websiteUrl.replace(/\/$/, "")}/cars/${encodeURIComponent(v.stockNo)}` : "",
    },
    moneyFormatter(s),
  );
  await c.query(
    `INSERT INTO messages (id, conversation_id, direction, body, rule_id, rule_key, status, send_after, created_at)
     VALUES ($1, $2, 'out', $3, $4, $5, 'scheduled', $6, $7)
     ON CONFLICT (conversation_id, rule_id, rule_key) WHERE rule_id IS NOT NULL DO NOTHING`,
    [newId("m"), convId, body, rule.id, key, new Date(now.getTime() + rule.delay_minutes * 60_000), now],
  );
}

/**
 * Stores a buyer's message from a channel. Idempotent: the same channel message id is stored once.
 * The first message in a thread starts a conversation and fires "new enquiry" rules.
 */
export async function recordInbound(c: Queryable, ch: ChannelRow, input: InboundInput, now = new Date()): Promise<{ conversationId: string; duplicate: boolean; optedOut: boolean }> {
  const { rows: vr } = await c.query<{ id: string }>(
    `SELECT v.id FROM vehicles v WHERE upper(v.stock_no) = upper($1)
     UNION ALL
     SELECT l.vehicle_id FROM listings l WHERE l.channel_id = $2 AND l.external_id = $1
     LIMIT 1`,
    [input.listingRef, ch.id],
  );
  if (!vr[0]) throw new PermanentError(`No car matches "${input.listingRef}"`);

  // A buyer is recognised by email; without one, each new thread is a new buyer.
  let buyerId: string;
  if (input.buyer.email) {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO buyers (id, name, email, phone) VALUES ($1, $2, $3, $4)
       ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO UPDATE SET phone = CASE WHEN EXCLUDED.phone <> '' THEN EXCLUDED.phone ELSE buyers.phone END
       RETURNING id`,
      [newId("b"), input.buyer.name, input.buyer.email, input.buyer.phone],
    );
    buyerId = rows[0].id;
  } else {
    const existing = await c.query<{ buyer_id: string }>("SELECT buyer_id FROM conversations WHERE channel_id = $1 AND thread_id = $2", [ch.id, input.threadId]);
    buyerId = existing.rows[0]?.buyer_id ?? newId("b");
    if (!existing.rows[0]) await c.query("INSERT INTO buyers (id, name, email, phone) VALUES ($1, $2, NULL, $3)", [buyerId, input.buyer.name, input.buyer.phone]);
  }

  const conv = await c.query<{ id: string; created: boolean }>(
    `INSERT INTO conversations (id, buyer_id, vehicle_id, channel_id, thread_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_id, thread_id) DO UPDATE SET status = 'open'
     RETURNING id, (xmax = 0) AS created`,
    [newId("cv"), buyerId, vr[0].id, ch.id, input.threadId],
  );
  const { id: convId, created } = conv.rows[0];
  const at = input.sentAt ? new Date(Math.min(Date.parse(input.sentAt), now.getTime())) : now;
  const ins = await c.query(
    `INSERT INTO messages (id, conversation_id, direction, body, status, external_id, created_at) VALUES ($1, $2, 'in', $3, 'received', $4, $5)
     ON CONFLICT (conversation_id, external_id) WHERE direction = 'in' DO NOTHING`,
    [newId("m"), convId, input.text, input.messageId, at],
  );
  if (!ins.rowCount) return { conversationId: convId, duplicate: true, optedOut: false };

  await c.query("UPDATE conversations SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, $2), $2), read_at = NULL WHERE id = $1", [convId, at]);
  // A reply means the buyer is talking to us: nudges waiting for them are no longer needed.
  await c.query(
    `UPDATE messages m SET status = 'cancelled', reason = 'Buyer replied'
       FROM rules r WHERE m.rule_id = r.id AND r.trigger = 'no_reply' AND m.conversation_id = $1 AND m.status = 'scheduled'`,
    [convId],
  );
  const optOut = isOptOut(input.text);
  if (optOut) {
    await c.query("UPDATE buyers SET opted_out = true WHERE id = $1", [buyerId]);
    await c.query(
      `UPDATE messages SET status = 'cancelled', reason = 'Buyer opted out'
        WHERE status = 'scheduled' AND conversation_id IN (SELECT id FROM conversations WHERE buyer_id = $1)`,
      [buyerId],
    );
  } else if (created) {
    for (const rule of await rulesFor(c, "new_enquiry")) await scheduleRule(c, convId, rule, "first", now);
  }
  return { conversationId: convId, duplicate: false, optedOut: optOut };
}

/** A price cut: tell buyers still talking about this car. Once per conversation per new price. */
export async function onPriceChange(c: Queryable, vehicleId: string, oldCents: number, newCents: number, now = new Date()) {
  if (newCents >= oldCents) return;
  const rules = await rulesFor(c, "price_drop");
  if (!rules.length) return;
  const { rows } = await c.query<{ id: string }>("SELECT id FROM conversations WHERE vehicle_id = $1 AND status = 'open'", [vehicleId]);
  for (const conv of rows) for (const rule of rules) await scheduleRule(c, conv.id, rule, `price:${newCents}`, now, { oldPriceCents: oldCents });
}

/** A sale: let other buyers know, cancel pending follow-ups about the car, and close the conversations. */
export async function onSold(c: Queryable, vehicleId: string, now = new Date()) {
  const { rows } = await c.query<{ id: string }>("SELECT id FROM conversations WHERE vehicle_id = $1 AND status = 'open'", [vehicleId]);
  const ids = rows.map((r) => r.id);
  if (!ids.length) return;
  await c.query(
    `UPDATE messages m SET status = 'cancelled', reason = 'Car sold'
       FROM rules r WHERE m.rule_id = r.id AND r.trigger <> 'sold' AND m.conversation_id = ANY($1) AND m.status = 'scheduled'`,
    [ids],
  );
  const rules = await rulesFor(c, "sold");
  for (const id of ids) for (const rule of rules) await scheduleRule(c, id, rule, "sold", now);
  await c.query("UPDATE conversations SET status = 'closed' WHERE id = ANY($1)", [ids]);
}

/** Buyers who went quiet after our last message get one nudge per conversation. */
export async function scanNoReply(db: pg.Pool, now = new Date()) {
  const rules = await rulesFor(db, "no_reply");
  for (const rule of rules) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT cv.id FROM conversations cv JOIN vehicles v ON v.id = cv.vehicle_id JOIN buyers b ON b.id = cv.buyer_id
        WHERE cv.status = 'open' AND v.status = 'available' AND NOT b.opted_out
          AND cv.last_outbound_at IS NOT NULL AND cv.last_outbound_at <= $1::timestamptz - make_interval(mins => $2)
          AND (cv.last_inbound_at IS NULL OR cv.last_inbound_at < cv.last_outbound_at)
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = cv.id AND m.rule_id = $3)
        LIMIT 200`,
      [now, rule.delay_minutes, rule.id],
    );
    for (const r of rows) await tx(db, (c) => scheduleRule(c, r.id, { ...rule, delay_minutes: 0 }, "once", now));
  }
}

/** A person's reply goes through the same queue, so a channel that is down doesn't lose it. */
export async function queueReply(c: Queryable, convId: string, userId: string, text: string) {
  const id = newId("m");
  await c.query("INSERT INTO messages (id, conversation_id, direction, body, user_id, status, send_after) VALUES ($1, $2, 'out', $3, $4, 'scheduled', now())", [id, convId, text, userId]);
  await c.query("UPDATE conversations SET read_at = now() WHERE id = $1", [convId]);
  return id;
}

interface Due {
  id: string;
  conversation_id: string;
  body: string;
  rule_id: string | null;
  attempts: number;
  trigger: RuleTrigger | null;
  thread_id: string;
  conv_status: string;
  buyer_id: string;
  opted_out: boolean;
  vehicle_status: string;
  ch: ChannelRow;
}

/** Sends messages that are due, applying every check at the moment of sending. */
export async function sendDue(db: pg.Pool, adapters: Adapters, timeZone: string, now = new Date(), limit = 50): Promise<number> {
  const settings = await getSettings(db);
  let n = 0;
  for (; n < limit; n++) {
    const sent = await tx(db, async (c) => {
      const { rows } = await c.query<Due>(
        `SELECT m.id, m.conversation_id, m.body, m.rule_id, m.attempts, r.trigger, cv.thread_id, cv.status AS conv_status, cv.buyer_id,
                b.opted_out, v.status AS vehicle_status, row_to_json(ch.*) AS ch
           FROM messages m
           JOIN conversations cv ON cv.id = m.conversation_id
           JOIN buyers b ON b.id = cv.buyer_id
           JOIN vehicles v ON v.id = cv.vehicle_id
           JOIN channels ch ON ch.id = cv.channel_id
           LEFT JOIN rules r ON r.id = m.rule_id
          WHERE m.status = 'scheduled' AND m.send_after <= $1
          ORDER BY m.send_after, m.id
          LIMIT 1
          FOR UPDATE OF m SKIP LOCKED`,
        [now],
      );
      const m = rows[0];
      if (!m) return false;
      const settle = (status: string, reason: string | null, extra = "") =>
        c.query(`UPDATE messages SET status = $2, reason = $3 ${extra} WHERE id = $1`, [m.id, status, reason]);
      const reason = await blockReason(c, m, settings, now);
      if (reason) {
        await settle(reason.status, reason.text);
        return true;
      }
      if (m.rule_id) {
        const next = nextSendTime(now, settings.quietStart, settings.quietEnd, timeZone);
        if (next > now) {
          await c.query("UPDATE messages SET send_after = $2 WHERE id = $1", [m.id, next]);
          return true;
        }
      }
      if (!m.ch.enabled) {
        await c.query("UPDATE messages SET send_after = now() + interval '15 minutes' WHERE id = $1", [m.id]);
        return true;
      }
      try {
        const out = await adapterFor(adapters, m.ch).sendMessage(m.ch, m.thread_id, m.body);
        await c.query("UPDATE messages SET status = 'sent', sent_at = $2, external_id = $3, attempts = attempts + 1 WHERE id = $1", [m.id, now, out.externalId ?? null]);
        await c.query("UPDATE conversations SET last_outbound_at = $2 WHERE id = $1", [m.conversation_id, now]);
      } catch (e) {
        if (!(e instanceof RetryableError) && !(e instanceof PermanentError)) throw e;
        const give = e instanceof PermanentError || m.attempts + 1 >= MAX_SEND_ATTEMPTS;
        await c.query(
          `UPDATE messages SET attempts = attempts + 1, status = $2, reason = $3, send_after = now() + make_interval(secs => $4) WHERE id = $1`,
          [m.id, give ? "failed" : "scheduled", e.message.slice(0, 300), 60 * 2 ** m.attempts],
        );
      }
      return true;
    });
    if (!sent) break;
  }
  return n;
}

async function blockReason(c: Queryable, m: Due, s: Settings, now: Date): Promise<{ status: "suppressed" | "cancelled"; text: string } | null> {
  if (m.opted_out) return { status: "suppressed", text: "Buyer opted out" };
  if (!m.rule_id) return null; // a person chose to send this
  if (m.trigger !== "sold" && m.conv_status !== "open") return { status: "cancelled", text: "Conversation closed" };
  if (m.trigger !== "sold" && (m.vehicle_status === "sold" || m.vehicle_status === "withdrawn")) return { status: "cancelled", text: "Car no longer for sale" };
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
      WHERE cv.buyer_id = $1 AND m.rule_id IS NOT NULL AND m.status = 'sent' AND m.sent_at > $2::timestamptz - interval '7 days'`,
    [m.buyer_id, now],
  );
  if (rows[0].n >= s.maxAutoPerWeek) return { status: "suppressed", text: `Weekly limit of ${s.maxAutoPerWeek} automated messages reached` };
  return null;
}
