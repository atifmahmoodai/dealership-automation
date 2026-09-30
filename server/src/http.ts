import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Role } from "../../shared/schemas";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
    public details?: Record<string, string>,
  ) {
    super(message);
  }
}

export const notFound = (what = "Not found") => new HttpError(404, what, "not_found");
export const conflict = (msg: string) => new HttpError(409, msg, "conflict");
export const badRequest = (msg: string, details?: Record<string, string>) => new HttpError(400, msg, "validation", details);

/** Parses input with a zod schema; failures become a 400 with a field → message map the UI can show. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const details: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join(".") || "_";
    details[key] ??= issue.message;
  }
  throw badRequest("Please check the highlighted fields.", details);
}

/** preHandler: the request must carry a valid session, optionally with one of `roles`. */
export function requireUser(...roles: Role[]) {
  return async (req: FastifyRequest) => {
    if (!req.session) throw new HttpError(401, "Please sign in.", "unauthenticated");
    if (roles.length && !roles.includes(req.session.user.role)) throw new HttpError(403, "You don't have permission to do that.", "forbidden");
  };
}

export const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store");
