import pg from "pg";

// DATE columns come back as "YYYY-MM-DD" strings (the app never needs a time zone for them),
// and BIGINT/NUMERIC counts as numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(url: string, max = 10): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // A runaway query must not hold a connection forever.
    statement_timeout: 15_000,
    application_name: "fleet-garage",
  });
  // An idle client losing its connection (DB restart) must not crash the process.
  pool.on("error", (err) => console.error("postgres pool error", err.message));
  return pool;
}

/** Runs `fn` in a transaction, rolling back on any error. */
export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
