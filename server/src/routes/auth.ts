import type { FastifyInstance, FastifyReply } from "fastify";
import { HttpError, parse, requireUser } from "../http";
import { audit } from "../repo/data";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../security/password";
import { createSession, deleteSession, deleteUserSessions, SESSION_COOKIE } from "../security/sessions";
import { changePasswordSchema, loginSchema, type Role } from "../../../shared/schemas";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export async function authRoutes(app: FastifyInstance) {
  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: app.config.cookieSecure,
      sameSite: "lax",
      path: "/",
      maxAge: app.config.SESSION_TTL_HOURS * 3600,
    });

  app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { email, password } = parse(loginSchema, req.body);
    const { rows } = await app.db.query<{
      id: string;
      email: string;
      name: string;
      role: Role;
      password_hash: string;
      active: boolean;
      locked: boolean;
    }>("SELECT *, locked_until IS NOT NULL AND locked_until > now() AS locked FROM users WHERE lower(email) = $1", [email]);
    const u = rows[0];
    // Always run the hash so response time doesn't reveal whether the email exists.
    const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);
    const denied = new HttpError(401, "Email or password is incorrect.", "bad_credentials");

    if (!u || !u.active) throw denied;
    if (u.locked) throw new HttpError(423, `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes or ask an admin to reset your password.`, "locked");
    if (!ok) {
      await app.db.query(
        `UPDATE users SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) END
         WHERE id = $1`,
        [u.id, MAX_FAILED, LOCK_MINUTES],
      );
      await audit(app.db, { userId: u.id, action: "auth.login_failed", entity: "user", entityId: u.id, ip: req.ip });
      throw denied;
    }
    await app.db.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [u.id]);
    const { token, csrfToken } = await createSession(app.db, u.id, app.config.SESSION_TTL_HOURS, { ip: req.ip, userAgent: req.headers["user-agent"] });
    await audit(app.db, { userId: u.id, action: "auth.login", entity: "user", entityId: u.id, ip: req.ip });
    setCookie(reply, token);
    return { user: { id: u.id, email: u.email, name: u.name, role: u.role }, csrfToken };
  });

  app.get("/me", { preHandler: requireUser() }, async (req) => ({ user: req.session!.user, csrfToken: req.session!.csrfToken }));

  app.post("/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteSession(app.db, token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/password", { preHandler: requireUser(), config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req) => {
    const { currentPassword, newPassword } = parse(changePasswordSchema, req.body);
    const s = req.session!;
    const { rows } = await app.db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [s.user.id]);
    if (!(await verifyPassword(currentPassword, rows[0].password_hash))) {
      throw new HttpError(400, "Your current password is incorrect.", "validation", { currentPassword: "Incorrect password" });
    }
    await app.db.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [s.user.id, await hashPassword(newPassword)]);
    // Signs out every other device that had the old password.
    await deleteUserSessions(app.db, s.user.id, s.sessionId);
    await audit(app.db, { userId: s.user.id, action: "auth.password_changed", entity: "user", entityId: s.user.id, ip: req.ip });
    return { ok: true };
  });
}
