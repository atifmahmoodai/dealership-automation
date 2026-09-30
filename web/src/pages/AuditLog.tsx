import { useInfiniteQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { isAdmin, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { fmtDateTime } from "../lib/format";

interface AuditEntry {
  id: number;
  at: string;
  action: string;
  entity: string;
  entityId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  userName: string | null;
}

const LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in",
  "auth.password_changed": "Changed password",
  "vehicle.create": "Added car",
  "vehicle.update": "Edited car",
  "listing.on": "Listed on a channel",
  "listing.off": "Taken off a channel",
  "channel.create": "Added channel",
  "channel.update": "Changed channel",
  "channel.rotate_secret": "New channel secret",
  "channel.retry": "Retried failed listings",
  "rule.create": "Added follow-up",
  "rule.update": "Changed follow-up",
  "buyer.opt_out": "Opted buyer out",
  "buyer.opt_in": "Cleared buyer opt-out",
  "settings.update": "Changed settings",
  "user.create": "Added user",
  "user.update": "Edited user",
  "user.password_reset": "Reset password",
};

function summary(e: AuditEntry): string {
  const d = e.details as Record<string, unknown>;
  const price = d.price as { from: number; to: number } | undefined;
  const status = d.status as { from: string; to: string } | undefined;
  if (e.action === "vehicle.update") {
    const parts = [String(d.stockNo ?? "")];
    if (price) parts.push(`price ${price.from / 100} → ${price.to / 100}`);
    if (status) parts.push(`${status.from} → ${status.to}`);
    return parts.join(" · ");
  }
  if (e.entity === "vehicle" && d.stockNo) return String(d.stockNo);
  if (e.entity === "channel" && d.name) return String(d.name);
  if (e.action === "channel.retry") return `${d.listings} listing(s)`;
  if (e.entity === "rule" && d.name) return String(d.name);
  if (e.action === "user.create") return `${d.email} (${d.role})`;
  return "";
}

/** Who did what, and when. */
export function AuditLog() {
  const me = useMe();
  const q = useInfiniteQuery({
    queryKey: ["audit"],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => api<{ items: AuditEntry[]; nextBefore: number | null }>(`/audit${pageParam ? `?before=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextBefore,
    enabled: isAdmin(me.data),
  });
  if (!isAdmin(me.data)) return <Navigate to="/" replace />;
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Activity</h1>
      </div>
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Details</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>{fmtDateTime(e.at)}</td>
                <td>{e.userName ?? <span className="muted">System</span>}</td>
                <td>{LABELS[e.action] ?? e.action}</td>
                <td className="muted">{summary(e)}</td>
                <td className="muted small">{e.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.hasNextPage && (
        <div>
          <button className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? "Loading…" : "Show older"}
          </button>
        </div>
      )}
    </div>
  );
}
