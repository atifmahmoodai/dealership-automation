import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { can, useLoadedMeta, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Status } from "../components/ui";
import { fmtMoney0, fmtNum, STATE_LABEL } from "../lib/format";
import type { VehicleRow } from "../../../shared/types";

export function Stock() {
  const role = useMe().data!.role;
  const meta = useLoadedMeta();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const query = new URLSearchParams();
  for (const k of ["status", "q"]) if (params.get(k)) query.set(k, params.get(k)!);
  const cars = useQuery({ queryKey: ["vehicles", query.toString()], queryFn: () => api<{ items: VehicleRow[] }>(`/vehicles?${query}`) });
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  const channels = meta.channels;
  return (
    <div className="wrap stack">
      <div className="row">
        <h1>Stock</h1>
        <span className="spacer" />
        {can.manage(role) && <Link className="btn btn-primary" to="/stock/new">Add car</Link>}
      </div>
      <form className="row filters" onSubmit={(e) => { e.preventDefault(); set("q", q.trim()); }}>
        <select aria-label="Status" value={params.get("status") ?? ""} onChange={(e) => set("status", e.target.value)}>
          <option value="">For sale (available and reserved)</option>
          <option value="available">Available</option>
          <option value="reserved">Reserved</option>
          <option value="sold">Sold</option>
          <option value="withdrawn">Withdrawn</option>
        </select>
        <input aria-label="Search" placeholder="Stock no, make, model or VIN" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn">Search</button>
      </form>
      {cars.isError && <div className="notice">{errorText(cars.error)}</div>}
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Car</th><th className="num">Price</th><th className="num">Mileage</th><th>Status</th>
              {channels.map((c) => <th key={c.id} className="channel-col" title={c.name}>{c.name.replace(/ \(sandbox\)$/, "")}</th>)}
              <th className="num">Buyers</th>
            </tr>
          </thead>
          <tbody>
            {cars.data?.items.map((v) => (
              <tr key={v.id}>
                <td>
                  <Link to={`/stock/${v.id}`}><b>{v.stockNo}</b> {v.year} {v.make} {v.model}</Link>
                  <div className="muted small">{v.trim}</div>
                </td>
                <td className="num">{fmtMoney0(v.priceCents)}</td>
                <td className="num">{fmtNum(v.mileage)}</td>
                <td><Status value={v.status} /></td>
                {channels.map((c) => {
                  const state = v.listings.find((l) => l.channelId === c.id)?.state ?? "off";
                  return (
                    <td key={c.id} className="channel-col">
                      <span className={`dot dot-${state}`} title={`${c.name}: ${STATE_LABEL[state]}`} aria-label={`${c.name}: ${STATE_LABEL[state]}`} />
                    </td>
                  );
                })}
                <td className="num">{v.openConversations ? <Link to={`/inbox?vehicleId=${v.id}`}>{v.openConversations}</Link> : <span className="muted">0</span>}</td>
              </tr>
            ))}
            {cars.data && !cars.data.items.length && <tr><td colSpan={5 + channels.length} className="muted">No cars match.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted small legend">
        {["live", "pending", "blocked", "error", "removed", "off"].map((s) => (
          <span key={s}><span className={`dot dot-${s}`} /> {STATE_LABEL[s]}</span>
        ))}
      </p>
    </div>
  );
}
