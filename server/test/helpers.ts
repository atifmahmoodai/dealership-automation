import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createPool } from "../src/db";
import type { Adapters } from "../src/sync/adapters";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/auto_test";
export const PASSWORD = "demo-password-1";

export interface TestCtx {
  app: FastifyInstance;
  db: ReturnType<typeof createPool>;
  close(): Promise<void>;
}

export async function makeApp(env: Record<string, string> = {}, adapters?: Adapters): Promise<TestCtx> {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DB_URL,
    LOG_LEVEL: "silent",
    PUBLIC_URL: "https://dealer.example.com",
    WEB_DIST: "",
    ...env,
  });
  const db = createPool(config.DATABASE_URL, 5);
  const app = await buildApp(config, db, adapters);
  return {
    app,
    db,
    async close() {
      await app.close();
      await db.end();
    },
  };
}

export interface Agent {
  cookie: string;
  csrf: string;
  get(url: string): Promise<LightMyRequestResponse>;
  send(method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<LightMyRequestResponse>;
}

/** Logs in and returns a client that sends the session cookie and CSRF token like the browser does. */
export async function login(app: FastifyInstance, email: string, password = PASSWORD): Promise<Agent> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password }, remoteAddress: `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === "sid")!;
  const csrf = res.json().csrfToken as string;
  const headers = { cookie: `sid=${cookie.value}` };
  return {
    cookie: cookie.value,
    csrf,
    get: (url) => app.inject({ method: "GET", url, headers }),
    send: (method, url, body) => app.inject({ method, url, headers: { ...headers, "x-csrf-token": csrf }, ...(body === undefined ? {} : { payload: body as object }) }),
  };
}
