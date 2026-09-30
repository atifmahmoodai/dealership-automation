import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createPool } from "./db";
import { migrate } from "./migrate";
import { purgeExpiredSessions } from "./security/sessions";
import { startWorker } from "./worker";

async function main() {
  const config = loadConfig();
  const db = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  // Schema is brought up to date on start; the advisory lock makes this safe with several replicas.
  await migrate(db, undefined, (m) => console.log(`[migrate] ${m}`));

  const app = await buildApp(config, db);
  const purge = setInterval(() => Promise.all([
          purgeExpiredSessions(db),
          db.query("DELETE FROM channel_log WHERE at < now() - interval '90 days'"),
          db.query("DELETE FROM sync_jobs WHERE status = 'done' AND updated_at < now() - interval '30 days'"),
        ]).catch((err) => app.log.warn({ err }, "session purge failed")), 60 * 60 * 1000);
  purge.unref();
  const worker = config.WORKER === "inline" ? startWorker(db, app.adapters, { intervalMs: config.WORKER_INTERVAL_MS, timeZone: config.TIMEZONE, log: (msg, err) => app.log.error({ err }, msg) }) : null;

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
    // Stop accepting connections, let in-flight requests finish, then close the pool.
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await app.close();
      await worker?.stop();
      await db.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => app.log.error({ err }, "unhandled rejection"));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
