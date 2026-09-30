import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { tx } from "../db";
import { badRequest, HttpError, notFound, parse, requireUser } from "../http";
import { csvCell } from "../../../shared/csv";
import { renderListing, rulesFor } from "../../../shared/automation";
import { channelSchema, inboundSchema } from "../../../shared/schemas";
import type { Channel, ChannelLogEntry } from "../../../shared/types";
import { audit, getSettings, newId, toVehicle } from "../repo/data";
import { PermanentError, verifySignature, type ChannelRow } from "../sync/adapters";
import { planVehicle, retryDead } from "../sync/engine";
import { recordInbound } from "../sync/messages";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

const newSecret = () => randomBytes(24).toString("base64url");

export async function channelRoutes(app: FastifyInstance) {
  const anyone = requireUser();
  const managers = requireUser("admin", "manager");
  const admin = requireUser("admin");
  const uid = (req: FastifyRequest) => req.session!.user.id;
  const feedUrl = (ch: { id: string; secret: string; config: { format?: string } }) =>
    `${app.config.PUBLIC_URL.replace(/\/$/, "")}/feeds/${ch.id}/${ch.secret}.${ch.config.format ?? "csv"}`;

  app.get("/channels", { preHandler: anyone }, async (req) => {
    const isAdmin = req.session!.user.role === "admin";
    const { rows } = await app.db.query(
      `SELECT ch.*,
              (SELECT count(*) FILTER (WHERE l.wanted AND l.state = 'live') FROM listings l WHERE l.channel_id = ch.id)::int AS live,
              (SELECT count(*) FILTER (WHERE l.wanted AND l.state = 'pending') FROM listings l WHERE l.channel_id = ch.id)::int AS pending,
              (SELECT count(*) FILTER (WHERE l.wanted AND l.state = 'error') FROM listings l WHERE l.channel_id = ch.id)::int AS error,
              (SELECT count(*) FILTER (WHERE l.wanted AND l.state = 'blocked') FROM listings l WHERE l.channel_id = ch.id)::int AS blocked,
              (SELECT count(*) FILTER (WHERE j.status = 'queued') FROM sync_jobs j JOIN listings l ON l.id = j.listing_id WHERE l.channel_id = ch.id)::int AS queued,
              (SELECT count(*) FILTER (WHERE j.status = 'queued' AND j.attempts > 0) FROM sync_jobs j JOIN listings l ON l.id = j.listing_id WHERE l.channel_id = ch.id)::int AS failing,
              (SELECT count(*) FILTER (WHERE j.status = 'dead') FROM sync_jobs j JOIN listings l ON l.id = j.listing_id WHERE l.channel_id = ch.id)::int AS dead
         FROM channels ch ORDER BY ch.name`,
    );
    return {
      items: rows.map(
        (ch): Channel => ({
          id: ch.id,
          name: ch.name,
          kind: ch.kind,
          enabled: ch.enabled,
          config: ch.config,
          ...(isAdmin ? { secret: ch.secret, ...(ch.kind === "feed" ? { feedUrl: feedUrl(ch) } : {}) } : {}),
          counts: { live: ch.live, pending: ch.pending, error: ch.error, blocked: ch.blocked },
          queue: { queued: ch.queued, failed: ch.failing, dead: ch.dead },
        }),
      ),
    };
  });

  app.post("/channels", { preHandler: admin }, async (req, reply) => {
    const ch = parse(channelSchema, req.body);
    const id = newId("ch");
    try {
      await app.db.query("INSERT INTO channels (id, name, kind, enabled, config, secret) VALUES ($1, $2, $3, $4, $5, $6)", [id, ch.name, ch.config.kind, ch.enabled, JSON.stringify(ch.config), newSecret()]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "A channel with that name already exists.", "conflict", { name: "Already used" });
      throw e;
    }
    await audit(app.db, { userId: uid(req), action: "channel.create", entity: "channel", entityId: id, details: { name: ch.name, kind: ch.config.kind }, ip: req.ip });
    return reply.status(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/channels/:id", { preHandler: admin }, async (req) => {
    const ch = parse(channelSchema, req.body);
    await tx(app.db, async (c) => {
      const { rows } = await c.query<{ kind: string; enabled: boolean }>("SELECT kind, enabled FROM channels WHERE id = $1 FOR UPDATE", [req.params.id]);
      if (!rows[0]) throw notFound("Channel not found");
      if (rows[0].kind !== ch.config.kind) throw badRequest("A channel's kind can't change. Add a new channel instead.");
      await c.query("UPDATE channels SET name = $2, enabled = $3, config = $4 WHERE id = $1", [req.params.id, ch.name, ch.enabled, JSON.stringify(ch.config)]);
      // New rules (say a smaller photo limit) or switching back on: bring every car on this channel up to date.
      const cars = await c.query<{ vehicle_id: string }>("SELECT vehicle_id FROM listings WHERE channel_id = $1", [req.params.id]);
      const s = await getSettings(c);
      for (const r of cars.rows) await planVehicle(c, r.vehicle_id, s);
      await audit(c, { userId: uid(req), action: "channel.update", entity: "channel", entityId: req.params.id, details: { name: ch.name, enabled: ch.enabled, config: ch.config }, ip: req.ip });
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/channels/:id/rotate-secret", { preHandler: admin }, async (req) => {
    const r = await app.db.query("UPDATE channels SET secret = $2 WHERE id = $1 RETURNING id", [req.params.id, newSecret()]);
    if (!r.rowCount) throw notFound("Channel not found");
    await audit(app.db, { userId: uid(req), action: "channel.rotate_secret", entity: "channel", entityId: req.params.id, ip: req.ip });
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { failures?: string } }>("/channels/:id/log", { preHandler: managers }, async (req) => {
    const { rows } = await app.db.query(
      `SELECT g.id, g.at, g.action, g.ok, g.status, g.duration_ms, g.detail, v.stock_no
         FROM channel_log g LEFT JOIN listings l ON l.id = g.listing_id LEFT JOIN vehicles v ON v.id = l.vehicle_id
        WHERE g.channel_id = $1 AND ($2 = false OR NOT g.ok) ORDER BY g.id DESC LIMIT 200`,
      [req.params.id, req.query.failures === "1"],
    );
    return {
      items: rows.map((r): ChannelLogEntry => ({ id: r.id, at: (r.at as Date).toISOString(), action: r.action, ok: r.ok, status: r.status, durationMs: r.duration_ms, detail: r.detail, stockNo: r.stock_no })),
    };
  });

  app.post<{ Params: { id: string } }>("/channels/:id/retry", { preHandler: managers }, async (req) => {
    const n = await tx(app.db, (c) => retryDead(c, { channelId: req.params.id }));
    await audit(app.db, { userId: uid(req), action: "channel.retry", entity: "channel", entityId: req.params.id, details: { listings: n }, ip: req.ip });
    return { retried: n };
  });

  /** Sandbox only: a pretend buyer asks about a car, so the inbox and rules can be tried out. */
  app.post<{ Params: { id: string } }>("/channels/:id/simulate-enquiry", { preHandler: managers }, async (req) => {
    const { vehicleId, text } = parse(z.object({ vehicleId: z.string().max(64).optional(), text: z.string().trim().max(1000).optional() }), req.body ?? {});
    const { rows } = await app.db.query<ChannelRow>("SELECT * FROM channels WHERE id = $1", [req.params.id]);
    const ch = rows[0];
    if (!ch) throw notFound("Channel not found");
    if (ch.kind !== "sandbox") throw badRequest("Only sandbox channels can make up enquiries.");
    const car = await app.db.query<{ stock_no: string }>(
      `SELECT v.stock_no FROM listings l JOIN vehicles v ON v.id = l.vehicle_id
        WHERE l.channel_id = $1 AND l.state = 'live' AND ($2::text IS NULL OR v.id = $2) ORDER BY random() LIMIT 1`,
      [ch.id, vehicleId ?? null],
    );
    if (!car.rows[0]) throw badRequest("None of your cars is live on this channel yet.");
    const names = ["Sam Carter", "Priya Patel", "Tom Hughes", "Aisha Khan", "Liam O'Brien", "Mei Chen", "Oliver Grant", "Zara Ahmed"];
    const name = names[Math.floor(Math.random() * names.length)];
    const n = Math.floor(Math.random() * 1e6);
    const result = await tx(app.db, (c) =>
      recordInbound(c, ch, {
        messageId: `sim-${n}`,
        threadId: `sim-thread-${n}`,
        listingRef: car.rows[0].stock_no,
        buyer: { name, email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}.${n}@example.com`, phone: "" },
        text: text || "Hi, is this car still available? Could I come and see it this week?",
      }),
    );
    return result;
  });

  // ---- public endpoints used by the channels themselves ----

  /** Enquiries pushed to us by a channel, signed with the channel's secret. */
  app.post<{ Params: { channelId: string } }>("/inbound/:channelId", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { rows } = await app.db.query<ChannelRow>("SELECT * FROM channels WHERE id = $1", [req.params.channelId]);
    const ch = rows[0];
    const ts = req.headers["x-timestamp"];
    const sig = req.headers["x-signature"];
    if (!ch || !verifySignature(ch.secret, typeof ts === "string" ? ts : undefined, req.rawBody ?? "", typeof sig === "string" ? sig : undefined)) {
      throw new HttpError(401, "Bad or missing signature.", "bad_signature");
    }
    if (!ch.enabled) throw new HttpError(503, "This channel is paused.", "paused");
    const input = parse(inboundSchema, req.body);
    try {
      const r = await tx(app.db, (c) => recordInbound(c, ch, input));
      return reply.status(r.duplicate ? 200 : 201).send(r);
    } catch (e) {
      if (e instanceof PermanentError) throw new HttpError(422, e.message, "unknown_listing");
      throw e;
    }
  });
}

/** The inventory feed a marketplace downloads: registered outside /api, no session, secret in the URL. */
export async function feedRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string; file: string } }>("/feeds/:id/:file", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const m = /^([\w-]+)\.(csv|xml)$/.exec(req.params.file);
    const { rows } = await app.db.query<ChannelRow>("SELECT * FROM channels WHERE id = $1 AND kind = 'feed'", [req.params.id]);
    const ch = rows[0];
    const given = Buffer.from(m?.[1] ?? "");
    const want = Buffer.from(ch?.secret ?? "");
    if (!ch || !m || given.length !== want.length || !timingSafeEqual(given, want) || m[2] !== (ch.config.format ?? "csv")) {
      return reply.status(404).send({ error: "not_found", message: "Not found" });
    }
    if (!ch.enabled) return reply.status(503).send({ error: "paused", message: "This feed is paused." });
    const s = await getSettings(app.db);
    const cars = await app.db.query(
      `SELECT v.*, l.external_id FROM listings l JOIN vehicles v ON v.id = l.vehicle_id
        WHERE l.channel_id = $1 AND l.wanted AND l.state = 'live' ORDER BY v.stock_no`,
      [ch.id],
    );
    const rules = rulesFor("feed", {});
    const items = cars.rows.map((r) => renderListing(toVehicle(r), rules, s.currency));
    reply.header("cache-control", "no-cache");
    if (m[2] === "csv") {
      const cols = ["ref", "title", "vin", "year", "make", "model", "trim", "mileage", "fuel", "transmission", "body", "colour", "price", "currency", "description", "photos"] as const;
      const lines = [cols.join(","), ...items.map((p) => cols.map((k) => csvCell(k === "photos" ? p.photos.join("|") : (p[k] as string | number))).join(","))];
      return reply.header("content-type", "text/csv; charset=utf-8").send(lines.join("\r\n") + "\r\n");
    }
    const esc = (v: unknown) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<inventory dealer="${esc(s.dealerName)}" generated="${new Date().toISOString()}">`,
      ...items.map(
        (p) =>
          `  <vehicle ref="${esc(p.ref)}">` +
          (["title", "vin", "year", "make", "model", "trim", "mileage", "fuel", "transmission", "body", "colour", "price", "currency", "description"] as const)
            .map((k) => `<${k}>${esc(p[k])}</${k}>`)
            .join("") +
          `<photos>${p.photos.map((u) => `<photo>${esc(u)}</photo>`).join("")}</photos></vehicle>`,
      ),
      "</inventory>",
    ];
    return reply.header("content-type", "application/xml; charset=utf-8").send(xml.join("\n") + "\n");
  });
}
