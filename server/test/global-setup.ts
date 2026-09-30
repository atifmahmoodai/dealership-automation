import pg from "pg";
import { createPool, tx } from "../src/db";
import { migrate } from "../src/migrate";
import { seedActivity, seedDemo } from "../src/seed";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/auto_test";

/** Recreates the test database, migrates it and loads the demo data once per run. */
export default async function setup() {
  const url = new URL(TEST_DB_URL);
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name) || !name.includes("test")) throw new Error(`Refusing to reset "${name}": test database names must contain "test".`);
  const admin = new URL(TEST_DB_URL);
  admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();

  const pool = createPool(TEST_DB_URL, 2);
  await migrate(pool);
  await tx(pool, (client) => seedDemo(client, { force: false, password: "demo-password-1" }));
  await seedActivity(pool, "UTC");
  await pool.end();
}
