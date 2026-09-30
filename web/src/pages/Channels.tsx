import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { can, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Modal } from "../components/ui";
import { fmtDateTime } from "../lib/format";
import { RULES, rulesFor } from "../../../shared/automation";
import type { ChannelKind } from "../../../shared/schemas";
import type { Channel, ChannelLogEntry } from "../../../shared/types";

export function Channels() {
  const role = useMe().data!.role;
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["channels"], queryFn: () => api<{ items: Channel[] }>("/channels"), refetchInterval: 10_000 });
  const [editing, setEditing] = useState<Channel | "new" | null>(null);
  const [logFor, setLogFor] = useState<Channel | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const call = async (path: string, done: (r: Record<string, unknown>) => string) => {
    try {
      const r = await api<Record<string, unknown>>(path, { method: "POST", body: {} });
      setMsg(done(r));
      await qc.invalidateQueries({ queryKey: ["channels"] });
      return r;
    } catch (e) {
      setMsg(errorText(e));
      return null;
    }
  };
  return (
    <div className="wrap stack">
      <div className="row">
        <h1>Channels</h1>
        <span className="spacer" />
        {can.admin(role) && <button className="btn btn-primary" onClick={() => setEditing("new")}>Add channel</button>}
      </div>
      <p className="muted">
        Every car is sent to the channels it's switched on for, in each site's own format. Changes go out automatically; a site that is down is retried
        with growing gaps (30 s, 2 min, 8 min … up to 6 h), and after six tries the job waits here for you to retry.
      </p>
      {msg && <div className="notice">{msg}</div>}
      <div className="channel-grid">
        {q.data?.items.map((ch) => {
          const r = rulesFor(ch.kind, ch.config as { ruleset?: string });
          return (
            <section key={ch.id} id={ch.id} className="card stack">
              <div className="row">
                <h2 className="grow">{ch.name}</h2>
                {ch.enabled ? <span className="badge badge-good">On</span> : <span className="badge">Paused</span>}
              </div>
              <p className="muted small">
                {ch.kind === "sandbox" ? `Sandbox marketplace (${r.label}) — a built-in stand-in for a real site, for trying things out.` : ch.kind === "webhook" ? `Signed JSON to ${String(ch.config.url)}` : "Inventory feed that a marketplace downloads"}
              </p>
              <div className="counts">
                <span><b>{ch.counts.live}</b> live</span>
                <span><b>{ch.counts.pending}</b> sending</span>
                <span className={ch.counts.blocked ? "warn" : ""}><b>{ch.counts.blocked}</b> can't list</span>
                <span className={ch.counts.error ? "bad" : ""}><b>{ch.counts.error}</b> failed</span>
              </div>
              <p className="small">
                Queue: {ch.queue.queued} waiting{ch.queue.failed ? `, ${ch.queue.failed} retrying` : ""}
                {ch.queue.dead ? <b className="bad">, {ch.queue.dead} gave up</b> : ""}
              </p>
              <p className="muted small">
                Rules: title up to {r.titleMax} characters, {r.photosMin ? `at least ${r.photosMin} and ` : ""}up to {r.photosMax} photos{r.needsVin ? ", VIN required" : ""}
                {r.showsReserved ? ", shows reserved cars" : ", reserved cars come down"}.
              </p>
              {ch.feedUrl && (
                <label className="small">
                  Feed address (give this to the marketplace; keep it private)
                  <input readOnly value={ch.feedUrl} onFocus={(e) => e.target.select()} className="mono" />
                </label>
              )}
              <div className="row">
                <button className="btn btn-sm" onClick={() => setLogFor(ch)}>Activity</button>
                {can.manage(role) && ch.queue.dead > 0 && (
                  <button className="btn btn-sm btn-primary" onClick={() => call(`/channels/${ch.id}/retry`, (r) => `${r.retried} listing(s) queued again for ${ch.name}.`)}>Retry failed</button>
                )}
                {can.manage(role) && ch.kind === "sandbox" && ch.enabled && (
                  <button
                    className="btn btn-sm"
                    onClick={async () => {
                      const r = await call(`/channels/${ch.id}/simulate-enquiry`, () => `A pretend buyer sent an enquiry through ${ch.name}.`);
                      if (r?.conversationId) nav(`/inbox/${r.conversationId}`);
                    }}
                  >
                    Simulate an enquiry
                  </button>
                )}
                {can.admin(role) && <button className="btn btn-sm" onClick={() => setEditing(ch)}>Settings</button>}
              </div>
            </section>
          );
        })}
      </div>
      {editing && <ChannelForm channel={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {logFor && <ChannelLog channel={logFor} onClose={() => setLogFor(null)} />}
    </div>
  );
}

function ChannelForm({ channel, onClose }: { channel: Channel | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(channel?.name ?? "");
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? "webhook");
  const c = (channel?.config ?? {}) as Record<string, string | number>;
  const [url, setUrl] = useState(String(c.url ?? "https://"));
  const [ruleset, setRuleset] = useState(String(c.ruleset ?? "autos"));
  const [failRate, setFailRate] = useState(String(Math.round(Number(c.failRate ?? 0) * 100)));
  const [format, setFormat] = useState(String(c.format ?? "csv"));
  const [error, setError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const config = kind === "sandbox" ? { kind, ruleset, failRate: Number(failRate) / 100 } : kind === "webhook" ? { kind, url } : { kind, format };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(channel ? `/channels/${channel.id}` : "/channels", { method: channel ? "PUT" : "POST", body: { name, enabled, config } });
      await qc.invalidateQueries({ queryKey: ["channels"] });
      await qc.invalidateQueries({ queryKey: ["meta"] });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const rotate = async () => {
    if (!channel || !window.confirm("Make a new secret? The old one stops working at once: update the other side straight away.")) return;
    await api(`/channels/${channel.id}/rotate-secret`, { method: "POST" });
    await qc.invalidateQueries({ queryKey: ["channels"] });
    onClose();
  };
  return (
    <Modal title={channel ? `${channel.name} settings` : "Add a channel"} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>
          Kind
          <select value={kind} disabled={!!channel} onChange={(e) => setKind(e.target.value as ChannelKind)}>
            <option value="webhook">Webhook (a partner API, n8n, Zapier…)</option>
            <option value="feed">Inventory feed (CSV or XML the site downloads)</option>
            <option value="sandbox">Sandbox marketplace (for testing)</option>
          </select>
        </label>
        {kind === "webhook" && <label>Endpoint URL<input required value={url} onChange={(e) => setUrl(e.target.value)} /></label>}
        {kind === "feed" && <label>Format<select value={format} onChange={(e) => setFormat(e.target.value)}><option value="csv">CSV</option><option value="xml">XML</option></select></label>}
        {kind === "sandbox" && (
          <div className="grid-2">
            <label>Behaves like<select value={ruleset} onChange={(e) => setRuleset(e.target.value)}><option value="autos">{RULES["sandbox:autos"].label}</option><option value="classifieds">{RULES["sandbox:classifieds"].label}</option></select></label>
            <label>Simulated failures (%)<input inputMode="numeric" value={failRate} onChange={(e) => setFailRate(e.target.value.replace(/\D/g, "").slice(0, 3))} /></label>
          </div>
        )}
        <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> On (paused channels keep their listings but nothing is sent)</label>
        {channel?.secret && kind !== "sandbox" && (
          <div className="stack-sm small">
            <b>Signing secret</b>
            <span className="muted">We sign every request with HMAC-SHA256 over "timestamp.body" (headers x-timestamp and x-signature); enquiries sent to us must be signed the same way.</span>
            <div className="row">
              <input readOnly className="mono grow" value={showSecret ? channel.secret : "•".repeat(24)} />
              <button type="button" className="btn btn-sm" onClick={() => setShowSecret(!showSecret)}>{showSecret ? "Hide" : "Show"}</button>
              <button type="button" className="btn btn-sm" onClick={rotate}>New secret</button>
            </div>
            <span className="muted">Enquiries in: POST {location.origin}/api/inbound/{channel.id}</span>
          </div>
        )}
        {error && <div className="notice notice-bad">{error}</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save</button></div>
      </form>
    </Modal>
  );
}

function ChannelLog({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const [failures, setFailures] = useState(false);
  const q = useQuery({ queryKey: ["channel-log", channel.id, failures], queryFn: () => api<{ items: ChannelLogEntry[] }>(`/channels/${channel.id}/log${failures ? "?failures=1" : ""}`) });
  return (
    <Modal title={`${channel.name}: activity`} onClose={onClose} wide>
      <label className="check"><input type="checkbox" checked={failures} onChange={(e) => setFailures(e.target.checked)} /> Failures only</label>
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      <div className="table-wrap" style={{ maxHeight: 420, overflow: "auto" }}>
        <table>
          <thead><tr><th>When</th><th>Car</th><th>What</th><th>Result</th></tr></thead>
          <tbody>
            {q.data?.items.map((e) => (
              <tr key={e.id} className={e.ok ? "" : "row-bad"}>
                <td className="small">{fmtDateTime(e.at)}</td>
                <td>{e.stockNo ?? "—"}</td>
                <td>{e.action}</td>
                <td className="small">{e.status ? `${e.status} · ` : ""}{e.detail} <span className="muted">({e.durationMs} ms)</span></td>
              </tr>
            ))}
            {q.data && !q.data.items.length && <tr><td colSpan={4} className="muted">Nothing yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
