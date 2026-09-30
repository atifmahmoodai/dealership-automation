import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { applySettings } from "../lib/format";
import type { Role, SessionUser } from "../../../shared/schemas";
import type { Meta } from "../../../shared/types";
import { api, ApiError, setCsrfToken } from "./client";

interface MeResponse {
  user: SessionUser;
  csrfToken: string;
}

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const r = await api<MeResponse>("/auth/me");
        setCsrfToken(r.csrfToken);
        return r.user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => api<MeResponse>("/auth/login", { method: "POST", body: input }),
    onSuccess: (r) => {
      setCsrfToken(r.csrfToken);
      qc.setQueryData(["me"], r.user);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSettled: () => {
      setCsrfToken("");
      qc.clear();
      qc.setQueryData(["me"], null);
    },
  });
}

/** Settings, staff and channels: loaded once after sign-in, used by every screen. */
export function useMeta(enabled = true) {
  return useQuery({
    queryKey: ["meta"],
    enabled,
    queryFn: async () => {
      const m = await api<Meta>("/meta");
      applySettings(m.settings, m.timeZone);
      return m;
    },
    staleTime: 5 * 60_000,
  });
}

/** Meta that is known to be loaded (the layout waits for it before showing any page). */
export function useLoadedMeta(): Meta {
  const m = useMeta();
  if (!m.data) throw new Error("meta not loaded");
  return m.data;
}

export const can = {
  manage: (r?: Role) => r === "admin" || r === "manager",
  admin: (r?: Role) => r === "admin",
};

export const isAdmin = (u: SessionUser | null | undefined) => u?.role === "admin";
