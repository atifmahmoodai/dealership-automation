import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db";
import type { Role, SessionUser } from "../../../shared/schemas";

export const SESSION_COOKIE = "sid";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export interface Session {
  user: SessionUser;
  csrfToken: string;
  sessionId: string;
}

export async function createSession(db: Queryable, userId: string, ttlHours: number, meta: { ip?: string; userAgent?: string }) {
  const token = newToken();
  const csrfToken = newToken();
  await db.query(
    `INSERT INTO sessions (id, user_id, csrf_token, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5, $6)`,
    [sha256(token), userId, csrfToken, ttlHours * 3600, meta.ip ?? null, (meta.userAgent ?? "").slice(0, 300)],
  );
  return { token, csrfToken };
}

/** Looks up a live session; expired or idle ones (and disabled users) are rejected. */
export async function readSession(db: Queryable, token: string, idleHours: number): Promise<Session | null> {
  const id = sha256(token);
  const { rows } = await db.query<{
    csrf_token: string;
    idle: boolean;
    last_seen_old: boolean;
    id: string;
    email: string;
    name: string;
    role: Role;
  }>(
    `SELECT s.csrf_token,
            s.last_seen_at < now() - make_interval(secs => $2) AS idle,
            s.last_seen_at < now() - interval '5 minutes' AS last_seen_old,
            u.id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.active`,
    [id, idleHours * 3600],
  );
  const r = rows[0];
  if (!r) return null;
  if (r.idle) {
    await db.query("DELETE FROM sessions WHERE id = $1", [id]);
    return null;
  }
  // Throttled so every request doesn't write to the database.
  if (r.last_seen_old) await db.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [id]);
  return { sessionId: id, csrfToken: r.csrf_token, user: { id: r.id, email: r.email, name: r.name, role: r.role } };
}

export async function deleteSession(db: Queryable, token: string) {
  await db.query("DELETE FROM sessions WHERE id = $1", [sha256(token)]);
}

export async function deleteUserSessions(db: Queryable, userId: string, exceptSessionId?: string) {
  await db.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [userId, exceptSessionId ?? ""]);
}

export async function purgeExpiredSessions(db: Queryable) {
  await db.query("DELETE FROM sessions WHERE expires_at < now()");
}
