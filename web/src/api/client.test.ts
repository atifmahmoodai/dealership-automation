import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, errorText, setCsrfToken, setUnauthorizedHandler } from "./client";

const reply = (status: number, body: unknown) => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken("");
  setUnauthorizedHandler(() => {});
});

describe("api client", () => {
  it("sends the CSRF token on writes only", async () => {
    const fetch = vi.fn(async () => reply(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    setCsrfToken("tok");
    await api("/x");
    await api("/x", { method: "POST", body: { a: 1 } });
    const headers = (i: number) => (fetch.mock.calls[i] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers(0)["x-csrf-token"]).toBeUndefined();
    expect(headers(1)["x-csrf-token"]).toBe("tok");
    expect(headers(1)["content-type"]).toBe("application/json");
  });

  it("turns validation errors into field messages", async () => {
    vi.stubGlobal("fetch", async () => reply(400, { error: "validation", message: "Please check the highlighted fields.", details: { email: "Enter a valid email" } }));
    const e = (await api("/customers", { method: "POST", body: {} }).catch((x) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.details).toEqual({ email: "Enter a valid email" });
    expect(errorText(e)).toBe("Enter a valid email");
  });

  it("reports an expired session, except for the sign-in check itself", async () => {
    vi.stubGlobal("fetch", async () => reply(401, { error: "unauthorized", message: "Sign in" }));
    const onExpired = vi.fn();
    setUnauthorizedHandler(onExpired);
    await api("/auth/me").catch(() => {});
    expect(onExpired).not.toHaveBeenCalled();
    await api("/vehicles").catch(() => {});
    expect(onExpired).toHaveBeenCalledOnce();
  });

  it("explains network failures and rate limits", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(errorText(await api("/x").catch((x) => x))).toMatch(/Can't reach the server/);
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 429 }));
    expect(errorText(await api("/x").catch((x) => x))).toMatch(/Too many requests/);
  });
});
