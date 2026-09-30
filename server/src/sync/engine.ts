// Keeps each channel's listing in line with the car.
//   plan(vehicle)   works out, per channel, whether the car should be there and whether it can be,
//                   stores the problems, and queues a sync job when the channel needs telling
//   runJobs()       the worker: claims due jobs, decides what to send from the car as it is now,
//                   calls the channel, and retries with backoff or gives up into the dead-letter state
import { createHash } from "node:crypto";
import type pg from "pg";
import { tx, type Queryable } from "../db";
import { canonical, checkVehicle, MAX_ATTEMPTS, renderListing, retryDelayMs, rulesFor, shouldBeListed, type ListingPayload } from "../../../shared/automation";
import type { Settings, Vehicle } from "../../../shared/types";
import { getSettings, newId, toVehicle } from "../repo/data";
import { adapterFor, PermanentError, RetryableError, type Adapters, type ChannelRow } from "./adapters";

const hash = (p: ListingPayload) => createHash("sha256").update(canonical(p)).digest("hex");

interface ListingRow {
  id: string;
  vehicle_id: string;
  channel_id: string;
  wanted: boolean;
  state: string;
  external_id: string | null;
  published_hash: string | null;
}

type Desired = { action: "upsert"; payload: ListingPayload; hash: string } | { action: "remove" } | { action: "none"; blocked: boolean };

/** What the channel should show for this car right now. */
function desired(v: Vehicle, ch: ChannelRow, l: ListingRow, s: Settings): { want: Desired; errors: string[]; warnings: string[] } {
  const rules = rulesFor(ch.kind, ch.config);
  const check = checkVehicle(v, rules);
  const listable = l.wanted && shouldBeListed(v.status, rules);
  if (listable && !check.errors.length) {
    const payload = renderListing(v, rules, s.currency);
    return { want: { action: "upsert", payload, hash: hash(payload) }, ...check };
  }
  const isUp = !!l.external_id && l.state !== "removed";
  return { want: isUp ? { action: "remove" } : { action: "none", blocked: listable && check.errors.length > 0 }, ...check };
}

export async function enqueue(c: Queryable, listingId: string, delayMs = 0) {
  await c.query(
    `INSERT INTO sync_jobs (listing_id, run_at) VALUES ($1, now() + make_interval(secs => $2))
     ON CONFLICT (listing_id) WHERE status IN ('queued', 'running')
     DO UPDATE SET rerun = sync_jobs.status = 'running',
                   run_at = CASE WHEN sync_jobs.status = 'queued' THEN LEAST(sync_jobs.run_at, EXCLUDED.run_at) ELSE sync_jobs.run_at END,
                   updated_at = now()`,
    [listingId, delayMs / 1000],
  );
}

/** Re-evaluates every channel for a car after it changes. Call inside the transaction that changed it. */
export async function planVehicle(c: Queryable, vehicleId: string, settings?: Settings) {
  const s = settings ?? (await getSettings(c));
  const { rows: vr } = await c.query("SELECT * FROM vehicles WHERE id = $1", [vehicleId]);
  if (!vr[0]) return;
  const v = toVehicle(vr[0]);
  const { rows } = await c.query<ListingRow & { ch: ChannelRow }>(
    `SELECT l.*, row_to_json(ch.*) AS ch FROM listings l JOIN channels ch ON ch.id = l.channel_id WHERE l.vehicle_id = $1`,
    [vehicleId],
  );
  for (const l of rows) {
    const { want, errors, warnings } = desired(v, l.ch, l, s);
    let state = l.state;
    if (want.action === "none") state = want.blocked ? "blocked" : l.external_id ? l.state : "removed";
    else if (want.action === "upsert" && (l.state === "blocked" || l.state === "removed")) state = "pending";
    await c.query("UPDATE listings SET problems = $2, state = $3, updated_at = now() WHERE id = $1", [l.id, JSON.stringify({ errors, warnings }), state]);
    const changed = want.action === "remove" || (want.action === "upsert" && (want.hash !== l.published_hash || l.state !== "live"));
    if (changed && l.ch.enabled) await enqueue(c, l.id);
  }
}

/** Turns a channel on or off for a car. */
export async function setWanted(c: Queryable, vehicleId: string, channelId: string, wanted: boolean) {
  await c.query(
    `INSERT INTO listings (id, vehicle_id, channel_id, wanted, state) VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (vehicle_id, channel_id) DO UPDATE SET wanted = EXCLUDED.wanted, updated_at = now()`,
    [newId("ls"), vehicleId, channelId, wanted],
  );
  await planVehicle(c, vehicleId);
}

async function log(c: Queryable, e: { channelId: string; listingId: string | null; action: string; ok: boolean; status: number | null; ms: number; detail: string }) {
  await c.query("INSERT INTO channel_log (channel_id, listing_id, action, ok, status, duration_ms, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
    e.channelId,
    e.listingId,
    e.action,
    e.ok,
    e.status,
    Math.round(e.ms),
    e.detail.slice(0, 1000),
  ]);
}

/**
 * Runs due sync jobs, one at a time, until none are due or `limit` is reached. The channel call happens
 * between two short transactions, so a slow site never holds database locks. A worker that dies mid-job
 * leaves it "running"; after ten minutes it is picked up again (creates are idempotent by design).
 */
export async function runJobs(db: pg.Pool, adapters: Adapters, limit = 25): Promise<number> {
  await db.query("UPDATE sync_jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < now() - interval '10 minutes'");
  let done = 0;
  for (; done < limit; done++) {
    const { rows } = await db.query<{ id: number; listing_id: string; attempts: number }>(
      `UPDATE sync_jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, rerun = false, updated_at = now()
        WHERE id = (SELECT id FROM sync_jobs WHERE status = 'queued' AND run_at <= now() ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, listing_id, attempts`,
    );
    const job = rows[0];
    if (!job) break;
    await runJob(db, adapters, job);
  }
  return done;
}

async function runJob(db: pg.Pool, adapters: Adapters, job: { id: number; listing_id: string; attempts: number }) {
  const settings = await getSettings(db);
  const { rows } = await db.query<ListingRow & { ch: ChannelRow; v: Record<string, unknown> }>(
    `SELECT l.*, row_to_json(ch.*) AS ch, row_to_json(v.*) AS v
       FROM listings l JOIN channels ch ON ch.id = l.channel_id JOIN vehicles v ON v.id = l.vehicle_id WHERE l.id = $1`,
    [job.listing_id],
  );
  const l = rows[0];
  const finish = async (c: Queryable) => {
    // A change that arrived while we were busy gets its own run straight away.
    await c.query(
      `UPDATE sync_jobs SET status = CASE WHEN rerun THEN 'queued' ELSE 'done' END, rerun = false, attempts = CASE WHEN rerun THEN 0 ELSE attempts END,
              run_at = now(), locked_at = NULL, last_error = NULL, updated_at = now() WHERE id = $1`,
      [job.id],
    );
  };
  if (!l || !l.ch.enabled) {
    if (l) await log(db, { channelId: l.channel_id, listingId: l.id, action: "skip", ok: true, status: null, ms: 0, detail: "Channel is paused" });
    await tx(db, finish);
    return;
  }
  // row_to_json gives dates as strings; toVehicle wants a Date for created_at.
  const v = toVehicle({ ...l.v, created_at: new Date(String(l.v.created_at)) });
  const { want } = desired(v, l.ch, l, settings);
  const adapter = adapterFor(adapters, l.ch);
  const started = performance.now();
  try {
    if (want.action === "upsert") {
      if (want.hash === l.published_hash && l.state === "live") return await tx(db, finish);
      const out = await adapter.upsert(l.ch, l.external_id, want.payload);
      await tx(db, async (c) => {
        await c.query(
          `UPDATE listings SET state = 'live', external_id = $2, published_hash = $3, published_at = COALESCE(published_at, now()), last_error = NULL, updated_at = now() WHERE id = $1`,
          [l.id, out.externalId ?? l.external_id, want.hash],
        );
        await log(c, { channelId: l.channel_id, listingId: l.id, action: l.external_id ? "update" : "create", ok: true, status: out.status, ms: performance.now() - started, detail: out.detail });
        await finish(c);
      });
    } else if (want.action === "remove") {
      const out = await adapter.remove(l.ch, l.external_id!);
      await tx(db, async (c) => {
        await c.query("UPDATE listings SET state = 'removed', published_hash = NULL, last_error = NULL, updated_at = now() WHERE id = $1", [l.id]);
        await log(c, { channelId: l.channel_id, listingId: l.id, action: "remove", ok: true, status: out.status, ms: performance.now() - started, detail: out.detail });
        await finish(c);
      });
    } else {
      await tx(db, finish);
    }
  } catch (e) {
    if (!(e instanceof RetryableError) && !(e instanceof PermanentError)) throw e;
    const dead = e instanceof PermanentError || job.attempts >= MAX_ATTEMPTS;
    await tx(db, async (c) => {
      await c.query(
        `UPDATE sync_jobs SET status = $2, run_at = now() + make_interval(secs => $3), locked_at = NULL, last_error = $4, updated_at = now() WHERE id = $1`,
        [job.id, dead ? "dead" : "queued", retryDelayMs(job.attempts) / 1000, e.message.slice(0, 500)],
      );
      // A car that was already live stays live (the site still shows the last good version); a first publish shows as failed.
      await c.query("UPDATE listings SET last_error = $2, state = CASE WHEN state = 'live' THEN 'live' ELSE 'error' END, updated_at = now() WHERE id = $1", [l.id, e.message.slice(0, 500)]);
      await log(c, { channelId: l.channel_id, listingId: l.id, action: want.action, ok: false, status: null, ms: performance.now() - started, detail: `${dead ? "Gave up" : `Attempt ${job.attempts} failed, will retry`}: ${e.message}` });
    });
  }
}

/** Tries again for listings whose jobs gave up, after someone has fixed the cause. Returns how many. */
export async function retryDead(c: Queryable, where: { channelId?: string; listingId?: string }) {
  const { rows } = await c.query<{ listing_id: string }>(
    `UPDATE sync_jobs j SET status = 'done', last_error = 'Retried: ' || COALESCE(j.last_error, ''), updated_at = now()
       FROM listings l
      WHERE j.listing_id = l.id AND j.status = 'dead' AND ($1::text IS NULL OR l.channel_id = $1) AND ($2::text IS NULL OR l.id = $2)
      RETURNING j.listing_id`,
    [where.channelId ?? null, where.listingId ?? null],
  );
  const listings = [...new Set(rows.map((r) => r.listing_id))];
  for (const id of listings) await enqueue(c, id);
  return listings.length;
}
