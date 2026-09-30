// Creates (or resets) an admin login.
//   npm run create-admin -- --email owner@garage.com --name "Jane Owner"
// The password is read from ADMIN_PASSWORD, or typed at a hidden prompt.
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../config";
import { createPool } from "../db";
import { migrate } from "../migrate";
import { hashPassword } from "../security/password";
import { passwordSchema } from "../../../shared/schemas";

const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" } } });
if (!values.email || !values.name) {
  console.error('Usage: npm run create-admin -- --email you@example.com --name "Your Name"');
  process.exit(1);
}

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Set ADMIN_PASSWORD when not running in a terminal.");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let s = "";
  return new Promise((resolve) => {
    process.stdin.on("data", (b: Buffer) => {
      for (const ch of b.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write("\n");
          return resolve(s);
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") s = s.slice(0, -1);
        else s += ch;
      }
    });
  });
}

const password = process.env.ADMIN_PASSWORD ?? (await readHidden("Password (min 10 chars, letters + a number): "));
const check = passwordSchema.safeParse(password);
if (!check.success) {
  console.error(check.error.issues[0].message);
  process.exit(1);
}

const config = loadConfig();
const db = createPool(config.DATABASE_URL, 1);
try {
  await migrate(db);
  const hash = await hashPassword(password);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (id, email, name, role, password_hash) VALUES ($1, $2, $3, 'admin', $4)
     ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name, role = 'admin', password_hash = EXCLUDED.password_hash,
       active = true, failed_logins = 0, locked_until = NULL, updated_at = now()
     RETURNING id`,
    [`u-${randomUUID()}`, values.email.trim().toLowerCase(), values.name.trim(), hash],
  );
  console.log(`Admin ready: ${values.email} (${rows[0].id})`);
} finally {
  await db.end();
}
