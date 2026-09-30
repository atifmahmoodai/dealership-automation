import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, errorText } from "../api/client";
import { Kpi } from "../components/ui";
import { fmtNum } from "../lib/format";
import type { Dashboard as D } from "../../../shared/types";

export function Dashboard() {
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => api<D>("/dashboard"), refetchInterval: 30_000 });
  if (q.isError) return <div className="wrap"><div className="notice">{errorText(q.error)}</div></div>;
  if (!q.data) return <div className="wrap muted">Loading…</div>;
  const d = q.data;
  return (
    <div className="wrap stack">
      <h1>Today</h1>
      <div className="kpis">
        <Kpi label="In stock" value={fmtNum(d.stock.available)} sub={`${d.stock.reserved} reserved · ${d.stock.soldThisMonth} sold this month`} />
        <Kpi label="Open conversations" value={fmtNum(d.inbox.open)} sub={<Link to="/inbox?filter=unanswered">{d.inbox.unanswered} waiting for a reply</Link>} tone={d.inbox.unanswered ? "warn" : undefined} />
        <Kpi label="New enquiries today" value={fmtNum(d.inbox.newToday)} />
        <Kpi
          label="Automatic messages (24 h)"
          value={fmtNum(d.automation.sent24h)}
          sub={`${d.automation.scheduled} scheduled · ${d.automation.suppressed24h} held back${d.automation.failed24h ? ` · ${d.automation.failed24h} failed` : ""}`}
          tone={d.automation.failed24h ? "warn" : undefined}
        />
      </div>
      <section className="card stack">
        <h2>Channels</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Channel</th><th className="num">Live</th><th className="num">Sending</th><th className="num">Can't list</th><th className="num">Failed</th><th className="num">Gave up</th></tr></thead>
            <tbody>
              {d.channels.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/channels#${c.id}`}>{c.name}</Link></td>
                  <td className="num">{c.live}</td>
                  <td className="num">{c.pending}</td>
                  <td className={`num ${c.blocked ? "warn" : ""}`}>{c.blocked}</td>
                  <td className={`num ${c.error ? "bad" : ""}`}>{c.error}</td>
                  <td className={`num ${c.dead ? "bad" : ""}`}>{c.dead}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card stack">
        <h2>Needs attention</h2>
        {d.attention.length ? (
          <ul className="plain attention">
            {d.attention.map((a, i) => (
              <li key={i} className={a.kind}>
                <Link to={a.link}>{a.text}</Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing — every car is where it should be and every buyer has an answer.</p>
        )}
      </section>
    </div>
  );
}
