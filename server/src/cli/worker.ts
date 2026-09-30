// Runs the worker as its own process: set WORKER=off on the web processes and run one of these.
import { defaultAdapters } from "../app";
import { loadConfig } from "../config";
import { createPool } from "../db";
import { migrate } from "../migrate";
import { startWorker } from "../worker";

const config = loadConfig();
const db = createPool(config.DATABASE_URL, 4);
await migrate(db);
const w = startWorker(db, defaultAdapters(db), { intervalMs: config.WORKER_INTERVAL_MS, timeZone: config.TIMEZONE, log: (m, e) => console.error(m, e) });
console.log(`worker running every ${config.WORKER_INTERVAL_MS} ms`);
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    await w.stop();
    await db.end();
    process.exit(0);
  });
}
