import { loadConfig } from "../config";
import { createPool } from "../db";
import { migrate } from "../migrate";

const config = loadConfig();
const db = createPool(config.DATABASE_URL, 1);
try {
  const applied = await migrate(db, undefined, (m) => console.log(m));
  console.log(applied.length ? `${applied.length} migration(s) applied.` : "Database is up to date.");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
