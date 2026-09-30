import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type pg from "pg";
import type { Config } from "./config";
import { HttpError } from "./http";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { channelRoutes, feedRoutes } from "./routes/channels";
import { healthRoutes } from "./routes/health";
import { inboxRoutes } from "./routes/inbox";
import { vehicleRoutes } from "./routes/vehicles";
import { feedAdapter, sandboxAdapter, webhookAdapter, type Adapters } from "./sync/adapters";
import { readSession, SESSION_COOKIE, type Session } from "./security/sessions";

declare module "fastify" {
  interface FastifyInstance {
    db: pg.Pool;
    config: Config;
    adapters: Adapters;
  }
  interface FastifyRequest {
    session: Session | null;
  }
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function buildApp(config: Config, db: pg.Pool, adapters?: Adapters): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.LOG_LEVEL === "silent"
        ? false
        : {
            level: config.LOG_LEVEL,
            // Never log request bodies or credentials.
            redact: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-csrf-token']", "res.headers['set-cookie']"],
          },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    genReqId: (req) => (typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"].length <= 100 ? req.headers["x-request-id"] : randomUUID()),
    requestIdHeader: false,
  });

  app.decorate("db", db);
  app.decorate("config", config);
  app.decorate("adapters", adapters ?? defaultAdapters(db));
  // Keep the exact bytes of JSON bodies: webhook signatures are checked against them.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(400, "The request body isn't valid JSON.", "bad_json"), undefined);
    }
  });
  app.decorateRequest("session", null);

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "https:"],
        "connect-src": ["'self'"],
        "frame-ancestors": ["'none'"],
        "upgrade-insecure-requests": config.cookieSecure ? [] : null,
      },
    },
    hsts: config.cookieSecure ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });
    await app.register(compress, { threshold: 2048 });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MIN,
    timeWindow: "1 minute",
    allowList: (req) => req.url === "/healthz" || req.url === "/readyz",
    // The limiter's hook runs at route level, after the global onRequest hook below has checked the
    // session. So signed-in traffic is counted per verified session rather than per IP (a whole office
    // usually shares one address), while unknown or fake cookies count against the IP.
    keyGenerator: (req) => (req.session ? `s:${req.session.sessionId}` : `ip:${req.ip}`),
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    if (!req.url.startsWith("/api/")) return;
    reply.header("cache-control", "no-store");
    if (UNSAFE.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== new URL(config.PUBLIC_URL).origin) throw new HttpError(403, "Cross-origin request refused.", "bad_origin");
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.session = await readSession(db, token, config.SESSION_IDLE_HOURS);
    if (req.session && UNSAFE.has(req.method) && req.headers["x-csrf-token"] !== req.session.csrfToken) {
      throw new HttpError(403, "Your session token is missing or out of date. Reload the page and try again.", "csrf");
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.code === "23505") return reply.status(409).send({ error: "conflict", message: "That record already exists (duplicate value)." });
    if (e.code === "23503") return reply.status(400).send({ error: "validation", message: "A referenced record doesn't exist." });
    if (e.code === "23514") return reply.status(400).send({ error: "validation", message: "The values break a data rule." });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.code ?? "bad_request", message: e.message });
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: "internal", message: "Something went wrong. Please try again." });
  });

  await app.register(healthRoutes);
  await app.register(feedRoutes);
  await app.register(authRoutes, { prefix: "/api/auth" });
  for (const routes of [adminRoutes, vehicleRoutes, channelRoutes, inboxRoutes]) {
    await app.register(routes, { prefix: "/api" });
  }

  const webDir = config.WEB_DIST ? resolve(config.WEB_DIST) : "";
  const web = webDir && existsSync(resolve(webDir, "index.html")) ? webDir : "";
  if (web) {
    await app.register(fastifyStatic, {
      root: web,
      prefix: "/",
      wildcard: false,
      index: false,
      setHeaders: (reply, path) => reply.header("cache-control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache"),
    });
  }
  app.setNotFoundHandler((req, reply) => {
    // Page navigations get the app shell; a missing asset (e.g. /logo.png) stays a 404.
    const path = req.url.split("?")[0];
    if (req.method === "GET" && web && !req.url.startsWith("/api/") && ((req.headers.accept ?? "").includes("text/html") || !/\.[a-z0-9]+$/i.test(path))) {
      return reply.header("cache-control", "no-cache").sendFile("index.html", web);
    }
    return reply.status(404).send({ error: "not_found", message: "Not found" });
  });

  return app;
}

export function defaultAdapters(db: pg.Pool): Adapters {
  return { sandbox: sandboxAdapter(db), webhook: webhookAdapter(), feed: feedAdapter };
}
