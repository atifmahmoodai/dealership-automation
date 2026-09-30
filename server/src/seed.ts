// Demo data: a dealer with 14 cars on two sandbox marketplaces and an inventory feed, four follow-up
// rules, and buyer conversations at different stages. Some cars are deliberately imperfect (no VIN, no
// photos, a long title) so the per-channel checks have something to show.
import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Queryable } from "./db";
import { tx } from "./db";
import { DEFAULT_SETTINGS } from "../../shared/automation";
import { hashPassword } from "./security/password";
import { saveSettings } from "./repo/data";
import { sandboxAdapter, feedAdapter, webhookAdapter, type Adapters } from "./sync/adapters";
import { runJobs, setWanted } from "./sync/engine";
import { recordInbound, sendDue } from "./sync/messages";

const CARS: [string, string, number, string, string, string, number, string, string, number, string][] = [
  // stock, vin, year, make, model, trim, mileage, fuel, transmission, price £, colour
  ["A1001", "JTDBR32E520123456", 2021, "Toyota", "Corolla", "Design Hybrid", 24_300, "Hybrid", "Automatic", 17_495, "Silver"],
  ["A1002", "WVWZZZAUZLW123457", 2020, "Volkswagen", "Golf", "Life 1.5 TSI", 31_900, "Petrol", "Manual", 15_250, "Blue"],
  ["A1003", "SAJAA06F9GBL23458", 2019, "Jaguar", "XE", "R-Sport", 42_100, "Diesel", "Automatic", 16_995, "Black"],
  ["A1004", "WF0XXXGCDXLY23459", 2022, "Ford", "Puma", "ST-Line X EcoBoost mHEV", 12_800, "Hybrid", "Manual", 19_750, "Red"],
  ["A1005", "", 2018, "Nissan", "Qashqai", "N-Connecta", 51_200, "Petrol", "Manual", 11_495, "Grey"],
  ["A1006", "VF1RJA00X6523460X", 2021, "Renault", "Clio", "Iconic", 19_600, "Petrol", "Manual", 12_995, "White"],
  ["A1007", "KNAJ3811AL7123461", 2020, "Kia", "Sportage", "3 CRDi", 37_400, "Diesel", "Automatic", 18_250, "Grey"],
  ["A1008", "5YJ3E7EA1LF123462", 2020, "Tesla", "Model 3", "Standard Range Plus", 33_000, "Electric", "Automatic", 22_995, "White"],
  ["A1009", "WBA8E9C59KA123463", 2019, "BMW", "3 Series", "320d M Sport Plus Edition Touring", 45_700, "Diesel", "Automatic", 19_995, "Black"],
  ["A1010", "TMBJG7NE0L0123464", 2020, "Skoda", "Octavia", "SE L Estate", 28_800, "Petrol", "Automatic", 16_495, "Green"],
  ["A1011", "ZFA31200000123465", 2019, "Fiat", "500", "Lounge", 22_100, "Petrol", "Manual", 8_495, "Cream"],
  ["A1012", "SJNFBAF15U1123466", 2021, "Nissan", "Leaf", "N-Connecta 40kWh", 18_900, "Electric", "Automatic", 16_750, "Blue"],
  ["A1013", "WAUZZZF41KA123467", 2019, "Audi", "A4", "Sport 35 TFSI", 39_500, "Petrol", "Automatic", 17_995, "Grey"],
  ["A1014", "U5YPC81ADKL123468", 2019, "Kia", "Ceed", "2 ISG", 34_200, "Petrol", "Manual", 10_995, "White"],
];

const RULES = [
  {
    name: "Instant reply",
    trigger: "new_enquiry",
    delay: 0,
    template:
      "Hi {buyer_first_name}, thanks for asking about the {vehicle} ({price}). It's available and you're welcome to view or test drive it — just reply with a day that suits, or call us on {dealer_phone}. {dealer_name}",
  },
  {
    name: "Nudge after 2 days",
    trigger: "no_reply",
    delay: 2 * 24 * 60,
    template: "Hi {buyer_first_name}, just checking you got our message about the {vehicle}. Happy to answer any questions or hold it for a viewing. {dealer_name}",
  },
  { name: "Price drop", trigger: "price_drop", delay: 0, template: "Good news {buyer_first_name}: the {vehicle} you asked about is now {price} (was {old_price}). {link}" },
  {
    name: "Sold — sorry",
    trigger: "sold",
    delay: 0,
    template: "Hi {buyer_first_name}, the {vehicle} has now been sold, sorry. We get new cars in every week — reply and tell us what you're after and we'll keep an eye out. {dealer_name}",
  },
];

export const photosFor = (stock: string, n: number) => Array.from({ length: n }, (_, i) => `https://picsum.photos/seed/${stock}-${i + 1}/800/600`);

export async function seedDemo(c: Queryable, opts: { force: boolean; password: string }) {
  const existing = await c.query("SELECT 1 FROM vehicles LIMIT 1");
  if (existing.rowCount && !opts.force) throw new Error("The database already has cars. Run with --force to replace all business data.");
  await c.query(
    `TRUNCATE messages, conversations, buyers, rules, channel_log, sync_jobs, sandbox_listings, listings, channels, vehicles, sessions, users, settings, audit_log RESTART IDENTITY CASCADE`,
  );
  await saveSettings(c, { ...DEFAULT_SETTINGS, dealerName: "Northside Motors", dealerPhone: "0161 496 0123", websiteUrl: "https://northside-motors.example" });
  const hash = await hashPassword(opts.password);
  for (const [id, email, name, role] of [
    ["u-admin", "admin@demo.local", "Alex Morgan", "admin"],
    ["u-manager", "manager@demo.local", "Sam Patel", "manager"],
    ["u-sales", "sales@demo.local", "Jordan Lee", "sales"],
  ]) {
    await c.query("INSERT INTO users (id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)", [id, email, name, role, hash]);
  }
  const channels = [
    { id: "ch-automart", name: "AutoMart (sandbox)", kind: "sandbox", config: { kind: "sandbox", ruleset: "autos", failRate: 0 } },
    { id: "ch-quick", name: "QuickClassifieds (sandbox)", kind: "sandbox", config: { kind: "sandbox", ruleset: "classifieds", failRate: 0 } },
    { id: "ch-feed", name: "Dealer inventory feed", kind: "feed", config: { kind: "feed", format: "csv" } },
  ];
  for (const ch of channels) {
    await c.query("INSERT INTO channels (id, name, kind, config, secret) VALUES ($1, $2, $3, $4, $5)", [ch.id, ch.name, ch.kind, JSON.stringify(ch.config), randomBytes(24).toString("base64url")]);
  }
  for (const r of RULES) {
    await c.query("INSERT INTO rules (id, name, trigger, delay_minutes, template) VALUES ($1, $2, $3, $4, $5)", [`r-${r.trigger}`, r.name, r.trigger, r.delay, r.template]);
  }
  for (const [i, [stock, vin, year, make, model, trim, mileage, fuel, gearbox, price, colour]] of CARS.entries()) {
    // A1011 has no photos yet; A1014 is sold and A1013 reserved.
    const photos = stock === "A1011" ? [] : photosFor(stock, 6 + (i % 4) * 5);
    const status = stock === "A1014" ? "sold" : stock === "A1013" ? "reserved" : "available";
    await c.query(
      `INSERT INTO vehicles (id, stock_no, vin, year, make, model, trim, mileage, fuel, transmission, body, colour, price_cents, description, photos, status, sold_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now() - make_interval(days => $18))`,
      [
        `v-${stock.toLowerCase()}`, stock, vin, year, make, model, trim, mileage, fuel, gearbox, i % 3 ? "Hatchback" : "SUV", colour, price * 100,
        `${year} ${make} ${model} ${trim} in ${colour.toLowerCase()}, ${mileage.toLocaleString("en-GB")} miles. Full service history, two keys, MOT until next year. HPI clear. Part exchange welcome and finance available.`,
        JSON.stringify(photos), status, status === "sold" ? new Date() : null, 40 - i * 2,
      ],
    );
    if (status !== "sold") for (const ch of channels) await setWanted(c, `v-${stock.toLowerCase()}`, ch.id, true);
  }
}

/** Publishes the demo stock and replays some buyer conversations. Runs after seedDemo has committed. */
export async function seedActivity(db: pg.Pool, timeZone: string) {
  const reliable: Adapters = { sandbox: sandboxAdapter(db, () => 1), webhook: webhookAdapter(), feed: feedAdapter };
  while ((await runJobs(db, reliable)) > 0);
  const { rows } = await db.query("SELECT * FROM channels WHERE id = 'ch-automart'");
  const ch = rows[0];
  const quick = (await db.query("SELECT * FROM channels WHERE id = 'ch-quick'")).rows[0];
  const hour = 3600_000;
  const now = Date.now();
  const convs: [typeof ch, string, string, string, string, number][] = [
    [ch, "A1001", "Sam Carter", "sam.carter@example.com", "Is the Corolla still available? Could I see it Saturday?", 50],
    [quick, "A1002", "Priya Patel", "priya.patel@example.com", "What's the lowest you'd take for the Golf?", 30],
    [ch, "A1008", "Tom Hughes", "tom.hughes@example.com", "Does the Tesla come with a charging cable?", 70],
    [ch, "A1004", "Aisha Khan", "aisha.khan@example.com", "Any finance deals on the Puma?", 5],
    [quick, "A1007", "Liam O'Brien", "", "Hi, has the Sportage had its cambelt done?", 3],
  ];
  for (const [i, [channel, stock, name, email, text, hoursAgo]] of convs.entries()) {
    const at = new Date(now - hoursAgo * hour);
    await tx(db, (c) => recordInbound(c, channel, { messageId: `seed-${i}`, threadId: `seed-thread-${i}`, listingRef: stock, buyer: { name, email, phone: "" }, text, sentAt: at.toISOString() }, at));
    // Replies go out at the time they were due (quiet hours apply at that moment).
    await sendDue(db, reliable, timeZone, new Date(at.getTime() + 60_000));
  }
  // Priya wrote back; Sam asked us to stop.
  await tx(db, (c) => recordInbound(c, quick, { messageId: "seed-1b", threadId: "seed-thread-1", listingRef: "A1002", buyer: { name: "Priya Patel", email: "priya.patel@example.com", phone: "" }, text: "Thanks — would you do £14,500 with my part exchange?" }, new Date(now - 26 * hour)));
  await tx(db, (c) => recordInbound(c, ch, { messageId: "seed-0b", threadId: "seed-thread-0", listingRef: "A1001", buyer: { name: "Sam Carter", email: "sam.carter@example.com", phone: "" }, text: "STOP" }, new Date(now - 20 * hour)));
  return convs.length;
}
