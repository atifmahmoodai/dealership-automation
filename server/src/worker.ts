// The background worker: pushes listing changes to channels, lines up "buyer went quiet" nudges and
// sends due messages. Runs inside the web process by default (WORKER=inline) or on its own (npm run worker).
import type pg from "pg";
import type { Adapters } from "./sync/adapters";
import { runJobs } from "./sync/engine";
import { scanNoReply, sendDue } from "./sync/messages";

export function startWorker(db: pg.Pool, adapters: Adapters, opts: { intervalMs: number; timeZone: string; log: (msg: string, err?: unknown) => void }) {
  let busy = false;
  let lastScan = 0;
  const tick = async () => {
    if (busy) return; // a slow channel mustn't stack up overlapping runs
    busy = true;
    try {
      await runJobs(db, adapters);
      if (Date.now() - lastScan > 60_000) {
        await scanNoReply(db);
        lastScan = Date.now();
      }
      await sendDue(db, adapters, opts.timeZone);
    } catch (err) {
      opts.log("worker tick failed", err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs);
  void tick();
  return {
    async stop() {
      clearInterval(timer);
      // Let a run that is in progress finish, so no job is left half-done.
      for (let i = 0; busy && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
    },
  };
}
