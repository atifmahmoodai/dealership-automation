import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { feedAdapter, sandboxAdapter, sign, verifySignature, webhookAdapter, type Adapters } from "../src/sync/adapters";
import { runJobs } from "../src/sync/engine";
import { scanNoReply, sendDue } from "../src/sync/messages";
import { login, makeApp, type Agent, type TestCtx } from "./helpers";
import type { Listing, Message, Vehicle } from "../../shared/types";

let ctx: TestCtx;
let admin: Agent;
let manager: Agent;
let sales: Agent;
// The sandbox fails when this says so; tests flip it.
let failing = false;
let webhookCalls: { url: string; body: string; headers: Record<string, string> }[] = [];
let webhookStatus = 200;

const fakeFetch = (async (url: string, init: RequestInit) => {
  webhookCalls.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
  return new Response(JSON.stringify({ externalId: "HOOK-1" }), { status: webhookStatus });
}) as unknown as typeof fetch;

beforeAll(async () => {
  // Filled in once the app's database pool exists; the app keeps this same object.
  const adapters = { webhook: webhookAdapter(fakeFetch), feed: feedAdapter } as Adapters;
  ctx = await makeApp({}, adapters);
  adapters.sandbox = sandboxAdapter(ctx.db, () => (failing ? -1 : 1)); // -1 is below any failure rate, so it always fails
  [admin, manager, sales] = await Promise.all(["admin", "manager", "sales"].map((u) => login(ctx.app, `${u}@demo.local`)));
  // No quiet hours in tests unless a test sets them.
  const meta = (await admin.get("/api/meta")).json();
  await admin.send("PUT", "/api/settings", { ...meta.settings, quietStart: "00:00", quietEnd: "00:00", maxAutoPerWeek: 5 });
});
afterAll(() => ctx.close());
beforeEach(() => {
  failing = false;
  webhookCalls = [];
  webhookStatus = 200;
});

const work = async () => {
  let n = 0;
  while ((await runJobs(ctx.db, ctx.app.adapters)) > 0 && n++ < 20);
};
const send = (now = new Date()) => sendDue(ctx.db, ctx.app.adapters, "UTC", now);
async function car(stock: string) {
  const id = `v-${stock.toLowerCase()}`;
  const r = (await manager.get(`/api/vehicles/${id}`)).json() as { vehicle: Vehicle; listings: Listing[] };
  const on = (name: string) => r.listings.find((l) => l.channelName.startsWith(name))!;
  return { ...r, id, on };
}
const sandboxRow = async (externalId: string) => (await ctx.db.query("SELECT payload, removed FROM sandbox_listings WHERE external_id = $1", [externalId])).rows[0];
const save = (v: Vehicle, patch: Partial<Vehicle>) => manager.send("PUT", `/api/vehicles/${v.id}`, { ...v, ...patch });

async function inbound(channelId: string, body: Record<string, unknown>, opts: { secret?: string; ts?: string } = {}) {
  const { rows } = await ctx.db.query("SELECT secret FROM channels WHERE id = $1", [channelId]);
  const raw = JSON.stringify(body);
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  return ctx.app.inject({
    method: "POST",
    url: `/api/inbound/${channelId}`,
    headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sign(opts.secret ?? rows[0].secret, ts, raw) },
    payload: raw,
  });
}
const thread = async (convId: string) => (await manager.get(`/api/conversations/${convId}`)).json() as { messages: Message[]; conversation: { status: string; optedOut: boolean } };

describe("publishing", () => {
  it("puts each car on the channels whose rules it meets", async () => {
    const good = await car("A1001");
    expect(["AutoMart", "QuickClassifieds", "Dealer"].map((n) => good.on(n).state)).toEqual(["live", "live", "live"]);
    const noVin = await car("A1005");
    expect(noVin.on("AutoMart")).toMatchObject({ state: "blocked", errors: ["Needs the VIN"] });
    expect(noVin.on("QuickClassifieds").state).toBe("live");
    const noPhotos = await car("A1011");
    expect(noPhotos.on("AutoMart").errors).toContain("Needs at least 1 photo");
    expect(noPhotos.on("QuickClassifieds").state).toBe("live");
  });

  it("adapts to each site: shortened titles, photo limits, reserved handling", async () => {
    const bmw = await car("A1009");
    expect(bmw.on("QuickClassifieds").warnings).toContain("Title shortened to 40 characters");
    const onQuick = await sandboxRow(bmw.on("QuickClassifieds").externalId!);
    expect(onQuick.payload.title.length).toBeLessThanOrEqual(40);
    expect(onQuick.payload.title.endsWith("…")).toBe(true);
    expect(onQuick.payload.photos.length).toBeLessThanOrEqual(10);
    const reserved = await car("A1013");
    expect(reserved.on("AutoMart").state).toBe("live");
    expect((await sandboxRow(reserved.on("AutoMart").externalId!)).payload.reserved).toBe(true);
    expect(reserved.on("QuickClassifieds").state).not.toBe("live");
  });

  it("three quick price edits while waiting go out once, with the last price", async () => {
    let { vehicle: v } = await car("A1006");
    for (const price of [12_795_00, 12_595_00, 12_495_00]) {
      await save(v, { priceCents: price });
      v = (await car("A1006")).vehicle;
    }
    const jobs = await ctx.db.query("SELECT count(*)::int AS n FROM sync_jobs j JOIN listings l ON l.id = j.listing_id WHERE l.vehicle_id = $1 AND j.status = 'queued'", ["v-a1006"]);
    expect(jobs.rows[0].n).toBe(3); // one per channel, not one per edit
    await work();
    const c = await car("A1006");
    expect((await sandboxRow(c.on("AutoMart").externalId!)).payload.price).toBe(12_495);
    const updates = await ctx.db.query("SELECT channel_id, count(*)::int AS n FROM channel_log WHERE action = 'update' AND listing_id IN (SELECT id FROM listings WHERE vehicle_id = 'v-a1006') GROUP BY channel_id");
    expect(updates.rows.map((r) => r.n)).toEqual([1, 1, 1]); // one update per channel, not one per edit
  });

  it("an unchanged save sends nothing", async () => {
    const { vehicle } = await car("A1010");
    await save(vehicle, {});
    const q = await ctx.db.query("SELECT count(*)::int AS n FROM sync_jobs j JOIN listings l ON l.id = j.listing_id WHERE l.vehicle_id = 'v-a1010' AND j.status = 'queued'");
    expect(q.rows[0].n).toBe(0);
  });

  it("adding the missing VIN unblocks the car", async () => {
    const { vehicle } = await car("A1005");
    await save(vehicle, { vin: "SJNFAAJ11U2123999" });
    await work();
    expect((await car("A1005")).on("AutoMart").state).toBe("live");
  });
});

describe("when a channel is down", () => {
  it("retries with backoff, keeps the live listing up, and gives up into a retryable dead state", async () => {
    const { vehicle } = await car("A1012");
    failing = true;
    await save(vehicle, { priceCents: vehicle.priceCents - 50_000 });
    await work();
    let c = await car("A1012");
    expect(c.on("AutoMart").state).toBe("live"); // the site still shows the last good version
    expect(c.on("AutoMart").lastError).toContain("503");
    const job = (await ctx.db.query("SELECT attempts, status, run_at > now() AS later FROM sync_jobs j JOIN listings l ON l.id = j.listing_id WHERE l.vehicle_id = 'v-a1012' AND l.channel_id = 'ch-automart' ORDER BY j.id DESC LIMIT 1")).rows[0];
    expect(job).toMatchObject({ attempts: 1, status: "queued", later: true });

    // Keep failing until it gives up.
    for (let i = 0; i < 6; i++) {
      await ctx.db.query("UPDATE sync_jobs SET run_at = now() WHERE status = 'queued'");
      await work();
    }
    const dead = (await ctx.db.query("SELECT status FROM sync_jobs j JOIN listings l ON l.id = j.listing_id WHERE l.vehicle_id = 'v-a1012' AND l.channel_id = 'ch-automart' ORDER BY j.id DESC LIMIT 1")).rows[0];
    expect(dead.status).toBe("dead");
    const dash = (await manager.get("/api/dashboard")).json();
    expect(dash.attention.some((a: { kind: string; text: string }) => a.kind === "dead_job" && a.text.includes("A1012"))).toBe(true);

    failing = false;
    const r = await manager.send("POST", "/api/channels/ch-automart/retry");
    expect(r.json().retried).toBeGreaterThan(0);
    await work();
    c = await car("A1012");
    expect(c.on("AutoMart").lastError).toBeNull();
    expect((await sandboxRow(c.on("AutoMart").externalId!)).payload.price).toBe((vehicle.priceCents - 50_000) / 100);
  });
});

describe("buyer enquiries", () => {
  it("need a valid, fresh signature", async () => {
    const body = { messageId: "m-x", threadId: "t-x", listingRef: "A1003", buyer: { name: "Eve" }, text: "Hi" };
    expect((await inbound("ch-automart", body, { secret: "wrong-secret" })).statusCode).toBe(401);
    expect((await inbound("ch-automart", body, { ts: String(Math.floor(Date.now() / 1000) - 3600) })).statusCode).toBe(401);
    const noSig = await ctx.app.inject({ method: "POST", url: "/api/inbound/ch-automart", headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });
    expect(noSig.statusCode).toBe(401);
  });

  it("are stored once, get an instant reply, and unknown cars are refused", async () => {
    const body = { messageId: "m-1", threadId: "t-1", listingRef: "A1003", buyer: { name: "Nina Scott", email: "nina@example.com" }, text: "Is the XE still for sale?" };
    const first = await inbound("ch-automart", body);
    expect(first.statusCode).toBe(201);
    const again = await inbound("ch-automart", body);
    expect(again.json()).toMatchObject({ duplicate: true });
    expect((await inbound("ch-automart", { ...body, messageId: "m-2", threadId: "t-2", listingRef: "NOPE" })).statusCode).toBe(422);
    await send();
    const t = await thread(first.json().conversationId);
    expect(t.messages.filter((m) => m.direction === "in")).toHaveLength(1);
    const reply = t.messages.find((m) => m.direction === "out")!;
    expect(reply).toMatchObject({ status: "sent", ruleName: "Instant reply" });
    expect(reply.body).toContain("Hi Nina, thanks for asking about the 2019 Jaguar XE R-Sport (£16,995)");
  });

  it("STOP opts the buyer out: nothing more is sent, even by staff", async () => {
    const r = await inbound("ch-quick", { messageId: "m-s1", threadId: "t-s1", listingRef: "A1006", buyer: { name: "Rob", email: "rob@example.com" }, text: "Any service history?" });
    const conv = r.json().conversationId;
    await inbound("ch-quick", { messageId: "m-s2", threadId: "t-s1", listingRef: "A1006", buyer: { name: "Rob", email: "rob@example.com" }, text: "stop" });
    await send();
    const t = await thread(conv);
    expect(t.conversation.optedOut).toBe(true);
    expect(t.messages.find((m) => m.ruleName === "Instant reply")).toMatchObject({ status: "cancelled", reason: "Buyer opted out" });
    expect((await sales.send("POST", `/api/conversations/${conv}/reply`, { text: "Hello?" })).statusCode).toBe(409);
  });

  it("price drops reach buyers still talking about the car, once per new price", async () => {
    const r = await inbound("ch-automart", { messageId: "m-p1", threadId: "t-p1", listingRef: "A1010", buyer: { name: "Gail", email: "gail@example.com" }, text: "Hi" });
    const { vehicle } = await car("A1010");
    await save(vehicle, { priceCents: vehicle.priceCents - 100_000 });
    const v2 = (await car("A1010")).vehicle;
    await save(v2, { description: `${v2.description} New tyres.` }); // not a price change: nothing more
    await send();
    const drops = (await thread(r.json().conversationId)).messages.filter((m) => m.ruleName === "Price drop");
    expect(drops).toHaveLength(1);
    expect(drops[0].body).toContain("now £15,495 (was £16,495)");
  });

  it("a sale takes the car down everywhere, tells open enquirers and cancels other follow-ups", async () => {
    const r = await inbound("ch-automart", { messageId: "m-q1", threadId: "t-q1", listingRef: "A1002", buyer: { name: "Hugo", email: "hugo@example.com" }, text: "Hi" });
    const { vehicle } = await car("A1002");
    await save(vehicle, { status: "sold" });
    await work();
    const c = await car("A1002");
    expect(c.listings.filter((l) => l.wanted).every((l) => l.state === "removed")).toBe(true);
    expect((await sandboxRow(c.on("AutoMart").externalId!)).removed).toBe(true);
    await send();
    const t = await thread(r.json().conversationId);
    expect(t.conversation.status).toBe("closed");
    const instant = t.messages.find((m) => m.ruleName === "Instant reply")!;
    expect(instant).toMatchObject({ status: "cancelled", reason: "Car sold" });
    expect(t.messages.find((m) => m.ruleName === "Sold — sorry")).toMatchObject({ status: "sent" });
  });

  it("nudges a buyer who went quiet, once, and a reply cancels a waiting nudge", async () => {
    const r = await inbound("ch-automart", { messageId: "m-n1", threadId: "t-n1", listingRef: "A1004", buyer: { name: "Ivy", email: "ivy@example.com" }, text: "Hello" });
    const conv = r.json().conversationId;
    await send();
    await ctx.db.query("UPDATE conversations SET last_outbound_at = now() - interval '3 days', last_inbound_at = now() - interval '4 days' WHERE id = $1", [conv]);
    await scanNoReply(ctx.db);
    await scanNoReply(ctx.db);
    let t = await thread(conv);
    expect(t.messages.filter((m) => m.ruleName === "Nudge after 2 days")).toHaveLength(1);
    await inbound("ch-automart", { messageId: "m-n2", threadId: "t-n1", listingRef: "A1004", buyer: { name: "Ivy", email: "ivy@example.com" }, text: "Sorry, been busy!" });
    t = await thread(conv);
    expect(t.messages.find((m) => m.ruleName === "Nudge after 2 days")).toMatchObject({ status: "cancelled", reason: "Buyer replied" });
  });

  it("respects quiet hours and the weekly limit per buyer", async () => {
    const meta = (await admin.get("/api/meta")).json();
    const h = new Date().getUTCHours();
    const quietStart = `${String((h + 23) % 24).padStart(2, "0")}:00`;
    const quietEnd = `${String((h + 2) % 24).padStart(2, "0")}:00`;
    await admin.send("PUT", "/api/settings", { ...meta.settings, quietStart, quietEnd, maxAutoPerWeek: 1 });
    const r = await inbound("ch-automart", { messageId: "m-q9", threadId: "t-q9", listingRef: "A1007", buyer: { name: "Zed", email: "zed@example.com" }, text: "Hi" });
    await send();
    let msg = (await thread(r.json().conversationId)).messages.find((m) => m.direction === "out")!;
    expect(msg.status).toBe("scheduled");
    expect(new Date(msg.sendAfter!).getUTCHours()).toBe((h + 2) % 24);
    // After quiet hours: sent. A second automated message the same week: held back.
    await admin.send("PUT", "/api/settings", { ...meta.settings, quietStart: "00:00", quietEnd: "00:00", maxAutoPerWeek: 1 });
    // A second in the past: Postgres times have microseconds and JavaScript's only milliseconds.
    await ctx.db.query("UPDATE messages SET send_after = now() - interval '1 second' WHERE id = $1", [msg.id]);
    await send();
    msg = (await thread(r.json().conversationId)).messages.find((m) => m.id === msg.id)!;
    expect(msg.status).toBe("sent");
    const r2 = await inbound("ch-quick", { messageId: "m-q10", threadId: "t-q10", listingRef: "A1012", buyer: { name: "Zed", email: "zed@example.com" }, text: "And this one?" });
    await send();
    const second = (await thread(r2.json().conversationId)).messages.find((m) => m.direction === "out")!;
    expect(second).toMatchObject({ status: "suppressed" });
    expect(second.reason).toContain("Weekly limit");
    await admin.send("PUT", "/api/settings", { ...meta.settings, quietStart: "00:00", quietEnd: "00:00", maxAutoPerWeek: 5 });
  });
});

describe("feed and webhook channels", () => {
  it("serves a CSV feed of live cars behind a secret URL, safe to open in a spreadsheet", async () => {
    const ch = ((await admin.get("/api/channels")).json().items as { id: string; feedUrl?: string }[]).find((c) => c.id === "ch-feed")!;
    const path = new URL(ch.feedUrl!).pathname;
    const res = await ctx.app.inject({ method: "GET", url: path });
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\r\n");
    expect(lines[0].startsWith("ref,title,vin")).toBe(true);
    expect(lines.some((l) => l.startsWith("A1001,"))).toBe(true);
    expect(lines.some((l) => l.startsWith("A1011,"))).toBe(false); // no photos: blocked
    expect((await ctx.app.inject({ method: "GET", url: path.replace(/\/[^/]+\.csv$/, "/guess.csv") })).statusCode).toBe(404);
    expect((await manager.get("/api/channels")).json().items.every((c: { secret?: string }) => c.secret === undefined)).toBe(true);
  });

  it("webhooks are signed, 5xx is retried and 4xx is not", async () => {
    const created = await admin.send("POST", "/api/channels", { name: "Partner API", enabled: true, config: { kind: "webhook", url: "https://partner.example.com/hooks" } });
    const chId = created.json().id;
    await manager.send("POST", `/api/vehicles/v-a1003/channels/${chId}`, { wanted: true });
    webhookStatus = 503;
    await work();
    expect(webhookCalls).toHaveLength(1);
    const call = webhookCalls[0];
    const secret = (await ctx.db.query("SELECT secret FROM channels WHERE id = $1", [chId])).rows[0].secret;
    expect(verifySignature(secret, call.headers["x-timestamp"], call.body, call.headers["x-signature"])).toBe(true);
    expect(JSON.parse(call.body)).toMatchObject({ event: "listing.created", data: { listing: { ref: "A1003" } } });
    let job = (await ctx.db.query("SELECT status FROM sync_jobs j JOIN listings l ON l.id = j.listing_id WHERE l.channel_id = $1", [chId])).rows[0];
    expect(job.status).toBe("queued");
    webhookStatus = 422;
    await ctx.db.query("UPDATE sync_jobs SET run_at = now()");
    await work();
    job = (await ctx.db.query("SELECT status FROM sync_jobs j JOIN listings l ON l.id = j.listing_id WHERE l.channel_id = $1", [chId])).rows[0];
    expect(job.status).toBe("dead");
    webhookStatus = 200;
    await manager.send("POST", `/api/channels/${chId}/retry`);
    await work();
    const l = (await car("A1003")).listings.find((x) => x.channelId === chId)!;
    expect(l).toMatchObject({ state: "live", externalId: "HOOK-1" });
  });
});

describe("permissions", () => {
  it("sales can read stock and answer buyers but not change cars, channels or rules", async () => {
    const { vehicle } = await car("A1001");
    expect((await sales.send("PUT", `/api/vehicles/${vehicle.id}`, vehicle)).statusCode).toBe(403);
    expect((await sales.send("POST", "/api/channels", {})).statusCode).toBe(403);
    expect((await sales.send("POST", "/api/rules", {})).statusCode).toBe(403);
    expect((await sales.get("/api/conversations")).statusCode).toBe(200);
  });
  it("rule templates only accept known fields", async () => {
    const r = await manager.send("POST", "/api/rules", { name: "Bad", trigger: "new_enquiry", delayMinutes: 0, template: "Hi {name}", enabled: true });
    expect(r.statusCode).toBe(400);
  });
});

describe("rate limits", () => {
  it("count each signed-in person separately, and fake cookies don't buy a fresh allowance", async () => {
    const small = await makeApp({ RATE_LIMIT_PER_MIN: "10" });
    try {
      const [a, b] = await Promise.all([login(small.app, "manager@demo.local"), login(small.app, "sales@demo.local")]);
      const codes = async (agent: Agent, n: number) => {
        const out: number[] = [];
        for (let i = 0; i < n; i++) out.push((await agent.get("/api/rules")).statusCode);
        return out;
      };
      // Same IP (both injected from 127.0.0.1), separate allowances.
      expect((await codes(a, 11)).at(-1)).toBe(429);
      expect((await codes(b, 3)).every((c) => c === 200)).toBe(true);
      // Anonymous requests with made-up session cookies all count against the IP.
      const anon: number[] = [];
      for (let i = 0; i < 11; i++) {
        anon.push((await small.app.inject({ method: "GET", url: "/api/rules", remoteAddress: "10.9.9.9", headers: { cookie: `sid=fake${i}` } })).statusCode);
      }
      expect(anon.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(anon[10]).toBe(429);
      // Login attempts stay limited per IP whatever cookie is sent.
      const logins: number[] = [];
      for (let i = 0; i < 11; i++) {
        logins.push(
          (await small.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "10.8.8.8", headers: { cookie: `sid=x${i}` }, payload: { email: "nobody@demo.local", password: "wrong-password-1" } })).statusCode,
        );
      }
      expect(logins.at(-1)).toBe(429);
    } finally {
      await small.close();
    }
  });
});
