import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { tx } from "../db";
import { conflict, HttpError, notFound, parse, requireUser } from "../http";
import { audit, getSettings, newId, toVehicle } from "../repo/data";
import { planVehicle, retryDead, setWanted } from "../sync/engine";
import { onPriceChange, onSold } from "../sync/messages";
import { vehicleSchema, vehicleUpdateSchema, VEHICLE_STATUSES } from "../../../shared/schemas";
import type { Listing, VehicleRow } from "../../../shared/types";

const DUP = "Another car in stock already has that stock number or VIN.";
const dupError = (e: unknown) => {
  if ((e as { code?: string }).code === "23505") return new HttpError(409, DUP, "conflict", { stockNo: "Already used" });
  return e;
};

export async function vehicleRoutes(app: FastifyInstance) {
  const anyone = requireUser();
  const managers = requireUser("admin", "manager");
  const uid = (req: FastifyRequest) => req.session!.user.id;

  app.get<{ Querystring: { status?: string; q?: string } }>("/vehicles", { preHandler: anyone }, async (req) => {
    const status = VEHICLE_STATUSES.includes(req.query.status as never) ? req.query.status! : null;
    const q = (req.query.q ?? "").trim().toLowerCase().replace(/[%_\\]/g, "").slice(0, 60);
    const { rows } = await app.db.query(
      `SELECT v.*,
              COALESCE((SELECT json_agg(json_build_object('channelId', l.channel_id, 'state', CASE WHEN l.wanted THEN l.state ELSE 'off' END))
                          FROM listings l WHERE l.vehicle_id = v.id), '[]') AS listings,
              (SELECT count(*) FROM conversations cv WHERE cv.vehicle_id = v.id AND cv.status = 'open')::int AS open_conversations
         FROM vehicles v
        WHERE ($1::text IS NULL AND v.status IN ('available', 'reserved') OR v.status = $1)
          AND ($2 = '' OR lower(v.stock_no || ' ' || v.make || ' ' || v.model || ' ' || v.vin) LIKE '%' || $2 || '%')
        ORDER BY v.created_at DESC LIMIT 500`,
      [status, q],
    );
    return { items: rows.map((r): VehicleRow => ({ ...toVehicle(r), listings: r.listings, openConversations: r.open_conversations })) };
  });

  app.get<{ Params: { id: string } }>("/vehicles/:id", { preHandler: anyone }, async (req) => {
    const { rows } = await app.db.query("SELECT * FROM vehicles WHERE id = $1", [req.params.id]);
    if (!rows[0]) throw notFound("Car not found");
    const listings = await app.db.query(
      `SELECT ch.id AS channel_id, ch.name, ch.kind, ch.enabled, l.wanted, l.state, l.external_id, l.last_error, l.problems, l.published_at,
              EXISTS (SELECT 1 FROM sync_jobs j WHERE j.listing_id = l.id AND j.status IN ('queued', 'running')) AS queued
         FROM channels ch LEFT JOIN listings l ON l.channel_id = ch.id AND l.vehicle_id = $1
        ORDER BY ch.name`,
      [req.params.id],
    );
    return {
      vehicle: toVehicle(rows[0]),
      listings: listings.rows.map(
        (l): Listing => ({
          channelId: l.channel_id,
          channelName: l.name,
          channelKind: l.kind,
          channelEnabled: l.enabled,
          wanted: !!l.wanted,
          state: l.wanted ? l.state : "off",
          externalId: l.external_id,
          lastError: l.last_error,
          errors: l.problems?.errors ?? [],
          warnings: l.problems?.warnings ?? [],
          publishedAt: l.published_at ? (l.published_at as Date).toISOString() : null,
          queued: l.queued,
        }),
      ),
    };
  });

  app.post("/vehicles", { preHandler: managers }, async (req, reply) => {
    const body = parse(vehicleSchema.and(z.object({ channels: z.array(z.string().max(64)).max(20).default([]) })), req.body);
    const id = newId("v");
    await tx(app.db, async (c) => {
      try {
        await c.query(
          `INSERT INTO vehicles (id, stock_no, vin, year, make, model, trim, mileage, fuel, transmission, body, colour, price_cents, description, photos, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [id, body.stockNo, body.vin, body.year, body.make, body.model, body.trim, body.mileage, body.fuel, body.transmission, body.body, body.colour, body.priceCents, body.description, JSON.stringify(body.photos), body.status],
        );
      } catch (e) {
        throw dupError(e);
      }
      for (const ch of body.channels) await setWanted(c, id, ch, true);
      await audit(c, { userId: uid(req), action: "vehicle.create", entity: "vehicle", entityId: id, details: { stockNo: body.stockNo, channels: body.channels }, ip: req.ip });
    });
    return reply.status(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/vehicles/:id", { preHandler: managers }, async (req) => {
    const v = parse(vehicleUpdateSchema, req.body);
    await tx(app.db, async (c) => {
      const { rows } = await c.query<{ version: number; price_cents: number; status: string }>("SELECT version, price_cents, status FROM vehicles WHERE id = $1 FOR UPDATE", [req.params.id]);
      const old = rows[0];
      if (!old) throw notFound("Car not found");
      if (old.version !== v.version) throw conflict("Someone else changed this car. Reload to see their changes.");
      try {
        await c.query(
          `UPDATE vehicles SET stock_no = $2, vin = $3, year = $4, make = $5, model = $6, trim = $7, mileage = $8, fuel = $9, transmission = $10, body = $11,
                  colour = $12, price_cents = $13, description = $14, photos = $15, status = $16,
                  sold_at = CASE WHEN $16 = 'sold' THEN COALESCE(sold_at, now()) ELSE NULL END,
                  version = version + 1, updated_at = now()
            WHERE id = $1`,
          [req.params.id, v.stockNo, v.vin, v.year, v.make, v.model, v.trim, v.mileage, v.fuel, v.transmission, v.body, v.colour, v.priceCents, v.description, JSON.stringify(v.photos), v.status],
        );
      } catch (e) {
        throw dupError(e);
      }
      // One save fans out: every channel is brought in line, and buyers hear about price cuts or a sale.
      await planVehicle(c, req.params.id);
      if (v.priceCents !== old.price_cents) await onPriceChange(c, req.params.id, old.price_cents, v.priceCents);
      if (v.status === "sold" && old.status !== "sold") await onSold(c, req.params.id);
      const details: Record<string, unknown> = { stockNo: v.stockNo };
      if (v.priceCents !== old.price_cents) details.price = { from: old.price_cents, to: v.priceCents };
      if (v.status !== old.status) details.status = { from: old.status, to: v.status };
      await audit(c, { userId: uid(req), action: "vehicle.update", entity: "vehicle", entityId: req.params.id, details, ip: req.ip });
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string; channelId: string } }>("/vehicles/:id/channels/:channelId", { preHandler: managers }, async (req) => {
    const { wanted } = parse(z.object({ wanted: z.boolean() }), req.body);
    await tx(app.db, async (c) => {
      const ok = await c.query("SELECT 1 FROM vehicles v, channels ch WHERE v.id = $1 AND ch.id = $2", [req.params.id, req.params.channelId]);
      if (!ok.rowCount) throw notFound("Car or channel not found");
      await setWanted(c, req.params.id, req.params.channelId, wanted);
      await audit(c, { userId: uid(req), action: wanted ? "listing.on" : "listing.off", entity: "vehicle", entityId: req.params.id, details: { channelId: req.params.channelId }, ip: req.ip });
    });
    return { ok: true };
  });

  /** "Send again": re-sends the listing even if nothing changed (say the site lost it), and retries failures. */
  app.post<{ Params: { id: string } }>("/vehicles/:id/resync", { preHandler: managers }, async (req) => {
    await tx(app.db, async (c) => {
      const { rows } = await c.query<{ id: string }>("UPDATE listings SET published_hash = NULL WHERE vehicle_id = $1 RETURNING id", [req.params.id]);
      for (const l of rows) await retryDead(c, { listingId: l.id });
      await planVehicle(c, req.params.id, await getSettings(c));
    });
    return { ok: true };
  });
}
