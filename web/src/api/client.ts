/** Error from the API, with per-field messages when the server rejected the input. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public details: Record<string, string> = {},
  ) {
    super(message);
  }
}

let csrfToken = "";
export const setCsrfToken = (t: string) => {
  csrfToken = t;
};

let onUnauthorized: () => void = () => {};
/** Called when a signed-in request comes back 401 (session expired or revoked). */
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; form?: FormData } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body, signal: init.signal, credentials: "same-origin" });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.", "network");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error page from a proxy
  }
  if (!res.ok) {
    const d = (data ?? {}) as { message?: string; error?: string; details?: Record<string, string> };
    if (res.status === 401 && path !== "/auth/login" && path !== "/auth/me") onUnauthorized();
    const fallback = res.status === 429 ? "Too many requests. Please wait a minute and try again." : `Request failed (${res.status}).`;
    throw new ApiError(res.status, d.message ?? fallback, d.error ?? "error", d.details ?? {});
  }
  return data as T;
}

/** A readable message; for a rejected field, that field's own message is more useful than the summary. */
export const errorText = (e: unknown) => {
  if (e instanceof ApiError && e.code === "validation") {
    const first = Object.values(e.details)[0];
    if (first) return first;
  }
  return e instanceof Error ? e.message : "Something went wrong.";
};
