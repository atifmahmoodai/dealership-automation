import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  /** Liveness: the process is up. */
  app.get("/healthz", async () => ({ ok: true }));

  /** Readiness: the database answers. Load balancers should route traffic only when this is 200. */
  app.get("/readyz", async (_req, reply) => {
    try {
      await app.db.query("SELECT 1");
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false, error: "database unavailable" });
    }
  });
}
