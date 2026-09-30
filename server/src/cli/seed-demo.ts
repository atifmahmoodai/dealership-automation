// Loads demo data: stock, three channels (two sandbox marketplaces and a feed), follow-up rules and buyer conversations.
//   npm run seed:demo            refuses if the database already has cars
//   npm run seed:demo -- --force replaces all business data
// Demo users log in with DEMO_PASSWORD (default: demo-password-1).
import { parseArgs } from "node:util";
import { loadConfig } from "../config";
import { createPool, tx } from "../db";
import { migrate } from "../migrate";
import { seedActivity, seedDemo } from "../seed";

const { values } = parseArgs({ options: { force: { type: "boolean", default: false } } });
const config = loadConfig();
if (config.NODE_ENV === "production" && !process.env.ALLOW_DEMO_SEED) {
  console.error("Refusing to load demo data with NODE_ENV=production. Set ALLOW_DEMO_SEED=1 if you really mean it.");
  process.exit(1);
}
const db = createPool(config.DATABASE_URL, 2);
try {
  await migrate(db);
  await tx(db, (c) => seedDemo(c, { force: values.force!, password: process.env.DEMO_PASSWORD ?? "demo-password-1" }));
  await seedActivity(db, config.TIMEZONE);
  console.log("Demo data loaded. Log in as admin@demo.local, manager@demo.local or sales@demo.local with the demo password.");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
