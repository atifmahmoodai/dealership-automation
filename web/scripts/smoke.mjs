// End-to-end smoke test of the whole stack: a fresh PostgreSQL database with demo data, the built
// server with its real background worker, and the day's work driven in Chromium: price changes
// flowing to the channels, an enquiry answered automatically, a manual reply, a sale, the feed.
//   npm run build && npm run smoke        (from the project root)
// Uses SMOKE_DATABASE_URL (default postgres://postgres:postgres@localhost:5432/auto_smoke).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { chromium } from "playwright-core";

const PORT = 4189;
const BASE = `http://localhost:${PORT}/`;
const SHOTS = "test-results/screenshots";
const DB_URL = process.env.SMOKE_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/auto_smoke";
const executablePath = process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
mkdirSync(SHOTS, { recursive: true });
if (!existsSync("../server/dist/server.js") || !existsSync("dist/index.html")) throw new Error("Build first: npm run build (from the project root)");

{
  const name = new URL(DB_URL).pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name) || !name.includes("smoke")) throw new Error("SMOKE_DATABASE_URL must name a database containing 'smoke'");
  const adminUrl = new URL(DB_URL);
  adminUrl.pathname = "/postgres";
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
}
const env = { ...process.env, NODE_ENV: "production", DATABASE_URL: DB_URL, PORT: String(PORT), PUBLIC_URL: BASE, COOKIE_SECURE: "false", WEB_DIST: join(process.cwd(), "dist"), LOG_LEVEL: "warn", ALLOW_DEMO_SEED: "1", WORKER_INTERVAL_MS: "700", RATE_LIMIT_PER_MIN: "2000" }; // the test polls far faster than a person
const seeded = spawnSync("node", ["../server/dist/cli/seed-demo.js"], { env, encoding: "utf8" });
if (seeded.status !== 0) throw new Error(`demo seed failed: ${seeded.stderr}`);
const server = spawn("node", ["../server/dist/server.js"], { env, stdio: ["ignore", "inherit", "inherit"] });

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) failures++;
};
const money = (s) => Number(s.replace(/[^\d.-]/g, ""));
const signIn = async (p, email) => {
  await p.goto(`${BASE}login`);
  await p.fill("input[type=email]", email);
  await p.fill("input[type=password]", "demo-password-1");
  await p.click("button:has-text('Sign in')");
  await p.waitForSelector(".appbar");
};
const signOut = async (p) => {
  await p.click("button:has-text('Sign out')");
  await p.waitForURL(/\/login/);
};
const pickCustomer = async (p, scope, name) => {
  await p.fill(`${scope} input[aria-label='Search customers']`, name.slice(0, 5));
  await p.locator(`${scope} .pick-list button:has-text('${name}')`).first().click();
};

let page;
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}readyz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch({ executablePath });
  const errors = [];
  const watch = (p) => {
    p.on("pageerror", (e) => {
      errors.push(e.stack || e.message);
      console.log(`  ! ${e.stack || e.message}`);
    });
    // 4xx answers are expected here (refused actions, validation); any 5xx or script error is a failure.
    p.on("console", (m) => m.type() === "error" && !/status of 4\d\d|ERR_INTERNET_DISCONNECTED/.test(m.text()) && errors.push(`${p.url()}: ${m.text()}`));
    p.on("dialog", (d) => d.accept());
  };
  // Demo photos are external links; answer them locally so the test doesn't depend on the internet.
  const PIXEL = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="#9ca3af"/></svg>';
  const offline = (c) => c.route(/^https:\/\/picsum\.photos\//, (r) => r.fulfill({ status: 200, contentType: "image/svg+xml", body: PIXEL }));
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await offline(ctx);
  page = await ctx.newPage();
  watch(page);

  const api = async (p, path, method = "GET", body) =>
    p.evaluate(async ([u, m, b]) => {
      const me = await (await fetch("/api/auth/me")).json();
      const r = await fetch(u, { method: m, headers: { "content-type": "application/json", "x-csrf-token": me.csrfToken }, body: b ? JSON.stringify(b) : undefined });
      return r.json();
    }, [`/api${path}`, method, body]);
  const until = async (p, fn, what, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await p.waitForTimeout(300);
    }
    throw new Error(`timed out waiting for: ${what}`);
  };

  console.log("Setup");
  await signIn(page, "admin@demo.local");
  check((await page.title()) === "Dealer Automation", "browser tab title");
  const meta = await api(page, "/meta");
  // Quiet hours off so the run doesn't depend on the time of day.
  await api(page, "/settings", "PUT", { ...meta.settings, quietStart: "00:00", quietEnd: "00:00" });
  await signOut(page);

  console.log("Dashboard and stock");
  await signIn(page, "manager@demo.local");
  await page.waitForSelector("h1:has-text('Today')");
  check((await page.locator("section:has(h2:text-is('Channels')) tbody tr").count()) === 3, "three channels on the dashboard");
  check(await page.locator(".attention li.blocked").first().isVisible(), "cars that can't be listed are flagged");
  await page.goto(`${BASE}stock`);
  await page.waitForSelector("tbody tr");
  check((await page.locator("tbody tr").count()) === 13, "13 cars for sale");
  check((await page.locator("tbody tr:has-text('A1001') .dot-live").count()) === 3, "a complete car is live on all three channels");
  check((await page.locator("tbody tr:has-text('A1005') .dot-blocked").count()) === 2, "a car without a VIN is blocked where a VIN is required");

  console.log("A price change flows to every channel");
  await page.click("a:has-text('A1006')");
  await page.waitForSelector("h2:has-text(\"Where it's listed\")");
  await page.fill("label:has-text('Price') input", "11995");
  await page.click("button:has-text('Save')");
  await page.waitForSelector("text=Saved. Channels are being updated.");
  await until(page, async () => (await page.locator(".badge:has-text('Sending…')").count()) === 0 && (await page.locator(".listings .badge:has-text('Live')").count()) === 3, "price change sent");
  const car = await api(page, "/vehicles/v-a1006");
  const log = await api(page, "/channels/ch-automart/log");
  check(log.items.some((e) => e.stockNo === "A1006" && e.action === "update" && e.detail.includes("11995")), "AutoMart received the new price");
  check(car.listings.every((l) => !l.lastError), "no errors on any channel");

  console.log("Switching a channel off takes the car down there");
  await page.locator(".listings li:has-text('QuickClassifieds') .switch span").click();
  await until(page, async () => (await api(page, "/channels/ch-quick/log")).items.some((e) => e.stockNo === "A1006" && e.action === "remove" && e.ok), "removal sent to QuickClassifieds");
  check((await api(page, "/vehicles/v-a1006")).listings.find((l) => l.channelId === "ch-quick").state === "off", "car taken off QuickClassifieds and shown as off");

  console.log("Adding a car");
  await page.goto(`${BASE}stock/new`);
  await page.fill("label:has-text('Stock number') input", "S9001");
  await page.fill("label:has-text('VIN') input", "WVWZZZ1KZ8W123456");
  await page.fill("label:has-text('Make') input", "Volkswagen");
  await page.fill("label:has-text('Model') input", "Polo");
  await page.fill("label:has-text('Mileage') input", "21000");
  await page.fill("label:has-text('Price') input", "10495");
  await page.fill("label:has-text('Description') textarea", "One owner, full history.");
  await page.fill("label:has-text('Photos') textarea", "https://picsum.photos/seed/S9001-1/800/600\nhttps://picsum.photos/seed/S9001-2/800/600");
  await page.click("button:has-text('Add car')");
  await page.waitForURL(/\/stock\/v-/);
  await until(page, async () => (await page.locator(".listings .badge:has-text('Live')").count()) === 3, "new car live everywhere");
  check(true, "new car published to all three channels");

  console.log("An enquiry is answered automatically");
  await page.goto(`${BASE}channels`);
  await page.waitForSelector("section#ch-automart");
  await page.click("section#ch-automart button:has-text('Simulate an enquiry')");
  await page.waitForURL(/\/inbox\/cv-/);
  await until(page, async () => (await page.locator(".msg.out.sent").count()) >= 1, "instant reply sent", 20_000);
  const reply = await page.locator(".msg.out .bubble").first().innerText();
  check(reply.startsWith("Hi ") && reply.includes("thanks for asking about the"), `instant reply went out: "${reply.slice(0, 60)}…"`);
  await page.fill("textarea[aria-label='Reply']", "Saturday at 10 works — see you then!");
  await page.click("button:has-text('Send')");
  await until(page, async () => (await page.locator(".msg.out.sent").count()) >= 2, "manual reply sent");
  check(true, "a person's reply is sent through the channel");
  const convUrl = page.url();
  const conv = await api(page, `/conversations/${convUrl.split("/inbox/")[1].split("?")[0]}`);

  console.log("A sale");
  const soldId = conv.conversation.vehicleId;
  const v = (await api(page, `/vehicles/${soldId}`)).vehicle;
  await api(page, `/vehicles/${soldId}`, "PUT", { ...v, status: "sold" });
  await until(page, async () => (await api(page, `/vehicles/${soldId}`)).listings.filter((l) => l.wanted).every((l) => l.state === "removed"), "sold car taken down");
  check(true, "sold car taken down from every channel");
  await page.goto(convUrl);
  await until(page, async () => (await page.locator(".msg.out.sent .bubble:has-text('has now been sold')").count()) === 1, "buyer told about the sale", 20_000);
  check(await page.locator("button:has-text('Reopen')").isVisible(), "the conversation was closed");

  console.log("Opted-out buyer");
  await page.goto(`${BASE}inbox?status=all`);
  await page.waitForSelector(".conv:has-text('Sam Carter')");
  await page.click(".conv:has-text('Sam Carter')");
  await page.waitForURL(/\/inbox\/cv-/);
  await page.waitForSelector("text=This buyer asked not to be contacted");
  check(!(await page.locator("textarea[aria-label='Reply']").count()), "no reply box for a buyer who said STOP");

  console.log("Feed");
  await signOut(page);
  await signIn(page, "admin@demo.local");
  const feed = (await api(page, "/channels")).items.find((c) => c.kind === "feed").feedUrl;
  const csv = await (await fetch(feed)).text();
  check(csv.startsWith("ref,title,vin") && csv.includes("S9001,") && !csv.includes(`${v.stockNo},`), "feed lists the new car and not the sold one");
  check((await fetch(feed.replace(/\/[^/]+\.csv$/, "/wrong.csv"))).status === 404, "feed needs its secret");
  await page.goto(`${BASE}rules`);
  await page.waitForSelector("text=Instant reply");
  await page.screenshot({ path: `${SHOTS}/rules.png`, fullPage: true });
  await page.goto(`${BASE}channels`);
  await page.waitForSelector("section#ch-feed");
  await page.screenshot({ path: `${SHOTS}/channels.png`, fullPage: true });
  await page.goto(`${BASE}audit`);
  await page.waitForSelector("td:has-text('price 12995 → 11995')");
  check(true, "activity log shows the price change in plain words");
  await signOut(page);

  console.log("Sales role");
  await signIn(page, "sales@demo.local");
  await page.goto(`${BASE}stock`);
  await page.waitForSelector("tbody tr");
  check(!(await page.locator("a:has-text('Add car')").count()), "sales can't add cars");
  await page.goto(`${BASE}stock/v-a1001`);
  await page.waitForSelector("h2:has-text(\"Where it's listed\")");
  check(!(await page.locator("button:has-text('Save')").count()) && !(await page.locator(".switch").count()), "sales see listings read-only");
  await page.goto(BASE);
  await page.waitForSelector("h1:has-text('Today')");
  await page.screenshot({ path: `${SHOTS}/dashboard.png`, fullPage: true });
  await page.goto(`${BASE}stock`);
  await page.waitForSelector("tbody tr");
  await page.screenshot({ path: `${SHOTS}/stock.png`, fullPage: true });
  await page.goto(`${BASE}stock/v-a1005`);
  await page.waitForSelector(".listings");
  await page.screenshot({ path: `${SHOTS}/car.png`, fullPage: true });
  await page.goto(convUrl);
  await page.waitForSelector(".messages");
  await page.screenshot({ path: `${SHOTS}/inbox.png`, fullPage: true });

  console.log("Phone layout");
  const mctx = await browser.newContext({ viewport: { width: 375, height: 800 }, colorScheme: "dark" });
  await offline(mctx);
  const m = await mctx.newPage();
  watch(m);
  await signIn(m, "manager@demo.local");
  for (const r of ["", "stock", "stock/v-a1001", "inbox", convUrl.replace(BASE, ""), "channels", "rules"]) {
    await m.goto(`${BASE}${r}`);
    await m.waitForSelector("main h1, main h2");
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `no page-level horizontal scroll on phone at "/${r.split("?")[0]}" (${overflow}px)`);
  }
  await m.goto(convUrl);
  await m.waitForSelector(".messages");
  await m.screenshot({ path: `${SHOTS}/inbox-phone.png`, fullPage: true });

  console.log("Server");
  const res = await fetch(`${BASE}stock/abc`);
  check(res.ok && (await res.text()).includes('id="root"'), "deep links serve the app");
  check(!!res.headers.get("content-security-policy"), "security headers set");
  const unsigned = await fetch(`${BASE}api/inbound/ch-automart`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check(unsigned.status === 401, "unsigned inbound enquiries are refused");

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await browser.close();
} catch (e) {
  failures++;
  console.error(e);
  if (page) {
    console.error("URL at failure:", page.url());
    await page.screenshot({ path: `${SHOTS}/failure.png`, fullPage: true }).catch(() => {});
  }
} finally {
  server.kill("SIGTERM");
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
