import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { can, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Status } from "../components/ui";
import { ago, fmtDateTime } from "../lib/format";
import type { Conversation, Message } from "../../../shared/types";

export function Inbox() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "open";
  const filter = params.get("filter") ?? "";
  const vehicleId = params.get("vehicleId") ?? "";
  const query = new URLSearchParams({ status, ...(filter ? { filter } : {}), ...(vehicleId ? { vehicleId } : {}) });
  const list = useQuery({ queryKey: ["conversations", query.toString()], queryFn: () => api<{ items: Conversation[] }>(`/conversations?${query}`), refetchInterval: 15_000 });
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  return (
    <div className="wrap stack">
      <h1>Inbox</h1>
      <div className="inbox">
        <aside className={`card conv-list ${id ? "hide-narrow" : ""}`}>
          <div className="row filters">
            <select aria-label="Conversations" value={status} onChange={(e) => set("status", e.target.value)}>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
            <label className="check small"><input type="checkbox" checked={filter === "unanswered"} onChange={(e) => set("filter", e.target.checked ? "unanswered" : "")} /> Waiting for us</label>
            {vehicleId && <button className="btn btn-sm" onClick={() => set("vehicleId", "")}>All cars ✕</button>}
          </div>
          {list.isError && <div className="notice">{errorText(list.error)}</div>}
          <ul className="plain">
            {list.data?.items.map((c) => (
              <li key={c.id}>
                <Link to={`/inbox/${c.id}?${params}`} className={`conv ${c.id === id ? "on" : ""} ${c.unread ? "unread" : ""}`}>
                  <span className="row" style={{ marginBottom: 0 }}>
                    <b className="grow">{c.buyerName}</b>
                    <span className="muted small">{ago(c.lastMessageAt)}</span>
                  </span>
                  <span className="small">{c.stockNo} · {c.vehicleTitle} · {c.channelName.replace(/ \(sandbox\)$/, "")}</span>
                  <span className="muted small clip">{c.lastMessage}</span>
                </Link>
              </li>
            ))}
            {list.data && !list.data.items.length && <li className="muted">No conversations.</li>}
          </ul>
        </aside>
        {id ? <Thread id={id} /> : <div className="card muted hide-narrow">Choose a conversation.</div>}
      </div>
    </div>
  );
}

function Thread({ id }: { id: string }) {
  const role = useMe().data!.role;
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["conversation", id], queryFn: () => api<{ conversation: Conversation; messages: Message[] }>(`/conversations/${id}`), refetchInterval: 10_000 });
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (q.isError) return <div className="card"><div className="notice">{errorText(q.error)}</div></div>;
  if (!q.data) return <div className="card muted">Loading…</div>;
  const { conversation: c, messages } = q.data;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["conversation", id] });
    await qc.invalidateQueries({ queryKey: ["conversations"] });
  };
  const act = async (path: string, body?: unknown) => {
    setError(null);
    try {
      await api(path, { method: "POST", body });
      await refresh();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };
  return (
    <section className="card stack thread">
      <button className="btn btn-sm show-narrow" onClick={() => nav("/inbox")}>← All conversations</button>
      <div className="row">
        <div className="grow">
          <h2>{c.buyerName}</h2>
          <p className="muted small">
            {[c.buyerEmail, c.buyerPhone].filter(Boolean).join(" · ") || "No contact details"} · via {c.channelName}
          </p>
          <p className="small">
            About <Link to={`/stock/${c.vehicleId}`}>{c.stockNo} {c.vehicleTitle}</Link> <Status value={c.vehicleStatus} />
          </p>
        </div>
        <div className="stack-sm">
          {c.optedOut && <span className="badge badge-bad">Opted out</span>}
          <button className="btn btn-sm" onClick={() => act(`/conversations/${id}/status`, { status: c.status === "open" ? "closed" : "open" })}>{c.status === "open" ? "Close" : "Reopen"}</button>
          {can.manage(role) && (
            <button
              className="btn btn-sm"
              onClick={() => (c.optedOut ? window.confirm("Only do this if the buyer asked to hear from you again.") : true) && act(`/conversations/${id}/opt-out`, { optedOut: !c.optedOut })}
            >
              {c.optedOut ? "Clear opt-out" : "Opt out"}
            </button>
          )}
        </div>
      </div>
      <ol className="messages">
        {messages.map((m) => (
          <li key={m.id} className={`msg ${m.direction} ${m.status}`}>
            <div className="bubble">{m.body}</div>
            <div className="meta small">
              <span>{m.author}</span> · <span>{fmtDateTime(m.sentAt ?? m.sendAfter ?? m.createdAt)}</span>
              {m.direction === "out" && m.status !== "sent" && (
                <>
                  {" "}· <Status value={m.status} /> {m.reason && <span className="muted">{m.reason}</span>}
                  {m.status === "scheduled" && m.sendAfter && Date.parse(m.sendAfter) > Date.now() + 60_000 && <span className="muted"> (sends {fmtDateTime(m.sendAfter)})</span>}
                  {m.status === "scheduled" && (
                    <button className="btn btn-xs" onClick={() => act(`/messages/${m.id}/cancel`)}>Cancel</button>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      {error && <div className="notice notice-bad">{error}</div>}
      {c.optedOut ? (
        <p className="notice">This buyer asked not to be contacted, so nothing can be sent to them.</p>
      ) : (
        <form
          className="stack-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            if (text.trim() && (await act(`/conversations/${id}/reply`, { text }))) setText("");
          }}
        >
          <textarea aria-label="Reply" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Reply to ${c.buyerName.split(" ")[0]}…`} />
          <div className="row"><span className="muted small grow">Sent through {c.channelName}.</span><button className="btn btn-primary" disabled={!text.trim()}>Send</button></div>
        </form>
      )}
    </section>
  );
}
