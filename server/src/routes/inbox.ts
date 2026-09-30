import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { tx } from "../db";
import { conflict, notFound, parse, requireUser } from "../http";
import { renderTemplate } from "../../../shared/automation";
import { replySchema, ruleSchema } from "../../../shared/schemas";
import type { Conversation, Dashboard, Message, Rule } from "../../../shared/types";
import { audit, getSettings, moneyFormatter, newId } from "../repo/data";
import { queueReply } from "../sync/messages";

export async function inboxRoutes(app: FastifyInstance) {
  const anyone = requireUser();
  const managers = requireUser("admin", "manager");
  const uid = (req: FastifyRequest) => req.session!.user.id;

  const CONVS = `
    SELECT cv.*, b.name AS buyer_name, COALESCE(b.email, '') AS buyer_email, b.phone AS buyer_phone, b.opted_out,
           v.stock_no, v.status AS vehicle_status, v.year || ' ' || v.make || ' ' || v.model AS vehicle_title, ch.name AS channel_name,
           lm.body AS last_body, lm.created_at AS last_at
      FROM conversations cv
      JOIN buyers b ON b.id = cv.buyer_id JOIN vehicles v ON v.id = cv.vehicle_id JOIN channels ch ON ch.id = cv.channel_id
      LEFT JOIN LATERAL (SELECT body, COALESCE(sent_at, created_at) AS created_at FROM messages m WHERE m.conversation_id = cv.id AND m.status IN ('received', 'sent')
                          ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 1) lm ON true`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toConv = (r: any): Conversation => ({
    id: r.id,
    buyerName: r.buyer_name,
    buyerEmail: r.buyer_email,
    buyerPhone: r.buyer_phone,
    optedOut: r.opted_out,
    vehicleId: r.vehicle_id,
    vehicleTitle: r.vehicle_title,
    stockNo: r.stock_no,
    vehicleStatus: r.vehicle_status,
    channelName: r.channel_name,
    status: r.status,
    lastMessageAt: ((r.last_at ?? r.created_at) as Date).toISOString(),
    lastMessage: r.last_body ?? "",
    unread: r.last_inbound_at !== null && (r.read_at === null || r.read_at < r.last_inbound_at),
  });

  app.get<{ Querystring: { status?: string; filter?: string; vehicleId?: string } }>("/conversations", { preHandler: anyone }, async (req) => {
    const status = req.query.status === "closed" ? "closed" : req.query.status === "all" ? null : "open";
    const { rows } = await app.db.query(
      `${CONVS}
        WHERE ($1::text IS NULL OR cv.status = $1) AND ($2::text IS NULL OR cv.vehicle_id = $2)
          AND ($3 <> 'unanswered' OR (cv.last_inbound_at IS NOT NULL AND (cv.last_outbound_at IS NULL OR cv.last_outbound_at < cv.last_inbound_at)))
        ORDER BY COALESCE(lm.created_at, cv.created_at) DESC LIMIT 300`,
      [status, req.query.vehicleId || null, req.query.filter ?? ""],
    );
    return { items: rows.map(toConv) };
  });

  app.get<{ Params: { id: string } }>("/conversations/:id", { preHandler: anyone }, async (req) => {
    const { rows } = await app.db.query(`${CONVS} WHERE cv.id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound("Conversation not found");
    const msgs = await app.db.query(
      `SELECT m.*, r.name AS rule_name, u.name AS user_name FROM messages m LEFT JOIN rules r ON r.id = m.rule_id LEFT JOIN users u ON u.id = m.user_id
        WHERE m.conversation_id = $1 ORDER BY COALESCE(m.sent_at, m.send_after, m.created_at), m.created_at`,
      [req.params.id],
    );
    await app.db.query("UPDATE conversations SET read_at = now() WHERE id = $1", [req.params.id]);
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      conversation: { ...toConv(rows[0]), unread: false },
      messages: msgs.rows.map(
        (m): Message => ({
          id: m.id,
          direction: m.direction,
          body: m.body,
          author: m.direction === "in" ? rows[0].buyer_name : m.rule_name ? `Automatic: ${m.rule_name}` : (m.user_name ?? "Staff"),
          status: m.status,
          reason: m.reason,
          sendAfter: iso(m.send_after),
          sentAt: iso(m.sent_at),
          createdAt: iso(m.created_at)!,
          ruleName: m.rule_name,
        }),
      ),
    };
  });

  app.post<{ Params: { id: string } }>("/conversations/:id/reply", { preHandler: anyone }, async (req, reply) => {
    const { text } = parse(replySchema, req.body);
    const id = await tx(app.db, async (c) => {
      const { rows } = await c.query<{ opted_out: boolean }>("SELECT b.opted_out FROM conversations cv JOIN buyers b ON b.id = cv.buyer_id WHERE cv.id = $1 FOR UPDATE OF cv", [req.params.id]);
      if (!rows[0]) throw notFound("Conversation not found");
      if (rows[0].opted_out) throw conflict("This buyer asked not to be contacted. Their opt-out has to be cleared before anyone can message them.");
      await c.query("UPDATE conversations SET status = 'open' WHERE id = $1", [req.params.id]);
      return queueReply(c, req.params.id, uid(req), text);
    });
    return reply.status(201).send({ id });
  });

  app.post<{ Params: { id: string } }>("/conversations/:id/status", { preHandler: anyone }, async (req) => {
    const { status } = parse(z.object({ status: z.enum(["open", "closed"]) }), req.body);
    const r = await app.db.query("UPDATE conversations SET status = $2 WHERE id = $1", [req.params.id, status]);
    if (!r.rowCount) throw notFound("Conversation not found");
    if (status === "closed") {
      await app.db.query("UPDATE messages SET status = 'cancelled', reason = 'Conversation closed' WHERE conversation_id = $1 AND status = 'scheduled' AND rule_id IS NOT NULL", [req.params.id]);
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/messages/:id/cancel", { preHandler: anyone }, async (req) => {
    const r = await app.db.query("UPDATE messages SET status = 'cancelled', reason = 'Cancelled by ' || $2 WHERE id = $1 AND status = 'scheduled'", [req.params.id, req.session!.user.name]);
    if (!r.rowCount) throw conflict("That message has already been sent or cancelled.");
    return { ok: true };
  });

  /** Opting a buyer out (they asked by phone) or back in (they asked to hear from us again). */
  app.post<{ Params: { id: string } }>("/conversations/:id/opt-out", { preHandler: managers }, async (req) => {
    const { optedOut } = parse(z.object({ optedOut: z.boolean() }), req.body);
    await tx(app.db, async (c) => {
      const { rows } = await c.query<{ buyer_id: string }>("SELECT buyer_id FROM conversations WHERE id = $1", [req.params.id]);
      if (!rows[0]) throw notFound("Conversation not found");
      await c.query("UPDATE buyers SET opted_out = $2 WHERE id = $1", [rows[0].buyer_id, optedOut]);
      if (optedOut) {
        await c.query("UPDATE messages SET status = 'cancelled', reason = 'Buyer opted out' WHERE status = 'scheduled' AND conversation_id IN (SELECT id FROM conversations WHERE buyer_id = $1)", [rows[0].buyer_id]);
      }
      await audit(c, { userId: uid(req), action: optedOut ? "buyer.opt_out" : "buyer.opt_in", entity: "buyer", entityId: rows[0].buyer_id, ip: req.ip });
    });
    return { ok: true };
  });

  // ---- rules ----

  app.get("/rules", { preHandler: anyone }, async () => {
    const { rows } = await app.db.query(
      `SELECT r.*,
              (SELECT count(*) FROM messages m WHERE m.rule_id = r.id AND m.status = 'sent' AND m.sent_at > now() - interval '7 days')::int AS sent7d,
              (SELECT count(*) FROM messages m WHERE m.rule_id = r.id AND m.status IN ('suppressed', 'cancelled') AND m.created_at > now() - interval '7 days')::int AS suppressed7d
         FROM rules r ORDER BY r.created_at`,
    );
    return {
      items: rows.map((r): Rule => ({ id: r.id, name: r.name, trigger: r.trigger, delayMinutes: r.delay_minutes, template: r.template, enabled: r.enabled, sent7d: r.sent7d, suppressed7d: r.suppressed7d })),
    };
  });

  app.post("/rules", { preHandler: managers }, async (req, reply) => {
    const r = parse(ruleSchema, req.body);
    const id = newId("r");
    await app.db.query("INSERT INTO rules (id, name, trigger, delay_minutes, template, enabled) VALUES ($1, $2, $3, $4, $5, $6)", [id, r.name, r.trigger, r.delayMinutes, r.template, r.enabled]);
    await audit(app.db, { userId: uid(req), action: "rule.create", entity: "rule", entityId: id, details: r, ip: req.ip });
    return reply.status(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/rules/:id", { preHandler: managers }, async (req) => {
    const r = parse(ruleSchema, req.body);
    const u = await app.db.query("UPDATE rules SET name = $2, trigger = $3, delay_minutes = $4, template = $5, enabled = $6 WHERE id = $1", [req.params.id, r.name, r.trigger, r.delayMinutes, r.template, r.enabled]);
    if (!u.rowCount) throw notFound("Rule not found");
    // Switching a rule off stops what it had lined up, too.
    if (!r.enabled) await app.db.query("UPDATE messages SET status = 'cancelled', reason = 'Rule switched off' WHERE rule_id = $1 AND status = 'scheduled'", [req.params.id]);
    await audit(app.db, { userId: uid(req), action: "rule.update", entity: "rule", entityId: req.params.id, details: r, ip: req.ip });
    return { ok: true };
  });

  app.post("/rules/preview", { preHandler: anyone }, async (req) => {
    const { template } = parse(z.object({ template: z.string().max(1500) }), req.body);
    const s = await getSettings(app.db);
    const text = renderTemplate(
      template,
      { buyerName: "Sam Carter", vehicle: "2021 Toyota Corolla Design", priceCents: 1_649_500, oldPriceCents: 1_749_500, dealerName: s.dealerName, dealerPhone: s.dealerPhone, link: s.websiteUrl ? `${s.websiteUrl}/cars/A1234` : "" },
      moneyFormatter(s),
    );
    return { text };
  });

  // ---- dashboard ----

  app.get("/dashboard", { preHandler: anyone }, async (): Promise<Dashboard> => {
    const [stock, channels, inbox, auto, dead, blocked, waiting] = await Promise.all([
      app.db.query(
        `SELECT count(*) FILTER (WHERE status = 'available')::int AS available, count(*) FILTER (WHERE status = 'reserved')::int AS reserved,
                count(*) FILTER (WHERE status = 'sold' AND sold_at >= date_trunc('month', now()))::int AS sold FROM vehicles`,
      ),
      app.db.query(
        `SELECT ch.id, ch.name,
                count(*) FILTER (WHERE l.wanted AND l.state = 'live')::int AS live, count(*) FILTER (WHERE l.wanted AND l.state = 'error')::int AS error,
                count(*) FILTER (WHERE l.wanted AND l.state = 'blocked')::int AS blocked, count(*) FILTER (WHERE l.wanted AND l.state = 'pending')::int AS pending,
                (SELECT count(*) FROM sync_jobs j JOIN listings l2 ON l2.id = j.listing_id WHERE l2.channel_id = ch.id AND j.status = 'dead')::int AS dead
           FROM channels ch LEFT JOIN listings l ON l.channel_id = ch.id WHERE ch.enabled GROUP BY ch.id ORDER BY ch.name`,
      ),
      app.db.query(
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
                count(*) FILTER (WHERE status = 'open' AND last_inbound_at IS NOT NULL AND (last_outbound_at IS NULL OR last_outbound_at < last_inbound_at))::int AS unanswered,
                count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS new_today FROM conversations`,
      ),
      app.db.query(
        `SELECT count(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '1 day')::int AS sent,
                count(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
                count(*) FILTER (WHERE status = 'suppressed' AND created_at > now() - interval '1 day')::int AS suppressed,
                count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '1 day')::int AS failed
           FROM messages WHERE rule_id IS NOT NULL`,
      ),
      app.db.query(
        `SELECT DISTINCT ON (l.id) v.id, v.stock_no, ch.name, j.last_error FROM sync_jobs j JOIN listings l ON l.id = j.listing_id
           JOIN vehicles v ON v.id = l.vehicle_id JOIN channels ch ON ch.id = l.channel_id WHERE j.status = 'dead' ORDER BY l.id, j.id DESC LIMIT 10`,
      ),
      app.db.query(
        `SELECT v.id, v.stock_no, ch.name, l.problems FROM listings l JOIN vehicles v ON v.id = l.vehicle_id JOIN channels ch ON ch.id = l.channel_id
          WHERE l.wanted AND l.state = 'blocked' AND v.status IN ('available', 'reserved') LIMIT 10`,
      ),
      app.db.query(
        `SELECT cv.id, b.name, v.stock_no, cv.last_inbound_at FROM conversations cv JOIN buyers b ON b.id = cv.buyer_id JOIN vehicles v ON v.id = cv.vehicle_id
          WHERE cv.status = 'open' AND cv.last_inbound_at < now() - interval '2 hours' AND (cv.last_outbound_at IS NULL OR cv.last_outbound_at < cv.last_inbound_at)
          ORDER BY cv.last_inbound_at LIMIT 10`,
      ),
    ]);
    return {
      stock: { available: stock.rows[0].available, reserved: stock.rows[0].reserved, soldThisMonth: stock.rows[0].sold },
      channels: channels.rows,
      inbox: { open: inbox.rows[0].open, unanswered: inbox.rows[0].unanswered, newToday: inbox.rows[0].new_today },
      automation: { sent24h: auto.rows[0].sent, scheduled: auto.rows[0].scheduled, suppressed24h: auto.rows[0].suppressed, failed24h: auto.rows[0].failed },
      attention: [
        ...dead.rows.map((r) => ({ kind: "dead_job" as const, text: `${r.stock_no} couldn't be sent to ${r.name}: ${r.last_error ?? "gave up"}`, link: `/stock/${r.id}` })),
        ...blocked.rows.map((r) => ({ kind: "blocked" as const, text: `${r.stock_no} can't go on ${r.name}: ${(r.problems.errors as string[]).join(", ")}`, link: `/stock/${r.id}` })),
        ...waiting.rows.map((r) => ({ kind: "unanswered" as const, text: `${r.name} about ${r.stock_no} has waited over 2 hours for a reply`, link: `/inbox/${r.id}` })),
      ],
    };
  });
}
