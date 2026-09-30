import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { can, useLoadedMeta, useMe } from "../api/auth";
import { api, ApiError, errorText } from "../api/client";
import { MoneyInput, Status } from "../components/ui";
import { ago } from "../lib/format";
import type { Listing, Vehicle } from "../../../shared/types";

const EMPTY = {
  stockNo: "", vin: "", year: new Date().getFullYear() - 3, make: "", model: "", trim: "", mileage: 0, fuel: "Petrol" as Vehicle["fuel"],
  transmission: "Manual" as Vehicle["transmission"], body: "", colour: "", priceCents: 0, description: "", photos: [] as string[], status: "available" as Vehicle["status"],
};

export function CarPage() {
  const { id } = useParams();
  const isNew = !id;
  const role = useMe().data!.role;
  const edit = can.manage(role);
  const meta = useLoadedMeta();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["vehicle", id], queryFn: () => api<{ vehicle: Vehicle; listings: Listing[] }>(`/vehicles/${id}`), enabled: !isNew, refetchInterval: (d) => (d.state.data?.listings.some((l) => l.queued) ? 2000 : false) });
  const [f, setF] = useState(EMPTY);
  const [photos, setPhotos] = useState("");
  const [channels, setChannels] = useState<string[]>(meta.channels.filter((c) => c.enabled).map((c) => c.id));
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [saved, setSaved] = useState(false);
  const v = q.data?.vehicle;

  useEffect(() => {
    if (v) {
      setF({ ...v });
      setPhotos(v.photos.join("\n"));
    }
  }, [v]);

  if (!isNew && q.isError) return <div className="wrap"><div className="notice">{errorText(q.error)}</div></div>;
  if (!isNew && !v) return <div className="wrap muted">Loading…</div>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const body = { ...f, photos: photos.split(/\s+/).map((p) => p.trim()).filter(Boolean) };
    try {
      if (isNew) {
        const r = await api<{ id: string }>("/vehicles", { method: "POST", body: { ...body, channels } });
        await qc.invalidateQueries({ queryKey: ["vehicles"] });
        nav(`/stock/${r.id}`, { replace: true });
      } else {
        await api(`/vehicles/${id}`, { method: "PUT", body: { ...body, version: v!.version } });
        await qc.invalidateQueries({ queryKey: ["vehicle", id] });
        await qc.invalidateQueries({ queryKey: ["vehicles"] });
        setSaved(true);
      }
    } catch (err) {
      setError(err as Error);
    }
  };
  const fe = (k: string) => (error instanceof ApiError ? error.details[k] : undefined);
  const input = (k: keyof typeof f, label: string, opts: { type?: string; numeric?: boolean } = {}) => (
    <label>
      {label}
      <input
        type={opts.type ?? "text"}
        disabled={!edit}
        inputMode={opts.numeric ? "numeric" : undefined}
        value={String(f[k])}
        aria-invalid={!!fe(k)}
        onChange={(e) => setF({ ...f, [k]: opts.numeric ? Number(e.target.value.replace(/\D/g, "")) : e.target.value })}
      />
      {fe(k) && <div className="field-error">{fe(k)}</div>}
    </label>
  );

  return (
    <div className="wrap stack">
      <Link to="/stock" className="small">← Stock</Link>
      <div className="row">
        <h1>{isNew ? "Add a car" : `${v!.stockNo} · ${v!.year} ${v!.make} ${v!.model}`}</h1>
        <span className="spacer" />
        {v && <Status value={v.status} />}
      </div>
      <div className="grid-car">
        <form className="card stack" onSubmit={submit}>
          <div className="grid-3">
            {input("stockNo", "Stock number")}
            {input("vin", "VIN")}
            {input("year", "Year", { numeric: true })}
            {input("make", "Make")}
            {input("model", "Model")}
            {input("trim", "Trim")}
            {input("mileage", "Mileage", { numeric: true })}
            <label>Fuel<select disabled={!edit} value={f.fuel} onChange={(e) => setF({ ...f, fuel: e.target.value as Vehicle["fuel"] })}>{["Petrol", "Diesel", "Hybrid", "Electric", "Other"].map((x) => <option key={x}>{x}</option>)}</select></label>
            <label>Gearbox<select disabled={!edit} value={f.transmission} onChange={(e) => setF({ ...f, transmission: e.target.value as Vehicle["transmission"] })}><option>Manual</option><option>Automatic</option></select></label>
            {input("body", "Body")}
            {input("colour", "Colour")}
            <MoneyInput label="Price" cents={f.priceCents} disabled={!edit} onChange={(c) => setF({ ...f, priceCents: c })} error={fe("priceCents")} />
          </div>
          <label>
            Status
            <select disabled={!edit} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Vehicle["status"] })}>
              <option value="available">Available</option>
              <option value="reserved">Reserved (stays listed where the site shows "reserved")</option>
              <option value="sold">Sold (comes down everywhere; enquirers are told)</option>
              <option value="withdrawn">Withdrawn (comes down everywhere)</option>
            </select>
          </label>
          <label>Description<textarea disabled={!edit} rows={5} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <label>
            Photos (https links, one per line, in display order)
            <textarea disabled={!edit} rows={4} value={photos} onChange={(e) => setPhotos(e.target.value)} className="mono" />
            {Object.entries(error instanceof ApiError ? error.details : {}).filter(([k]) => k.startsWith("photos")).map(([k, m]) => <div key={k} className="field-error">Photo {Number(k.split(".")[1]) + 1}: {m}</div>)}
          </label>
          {photos.trim() && (
            <div className="thumbs">{photos.split(/\s+/).filter(Boolean).slice(0, 8).map((p, i) => <img key={i} src={p} alt="" loading="lazy" />)}</div>
          )}
          {isNew && (
            <fieldset>
              <legend>List it on</legend>
              {meta.channels.map((c) => (
                <label key={c.id} className="check">
                  <input type="checkbox" checked={channels.includes(c.id)} onChange={(e) => setChannels(e.target.checked ? [...channels, c.id] : channels.filter((x) => x !== c.id))} /> {c.name}
                </label>
              ))}
            </fieldset>
          )}
          {error && <div className="notice notice-bad">{errorText(error)}</div>}
          {saved && <div className="notice notice-good">Saved. Channels are being updated.</div>}
          {edit && <div className="row"><span className="spacer" /><button className="btn btn-primary">{isNew ? "Add car" : "Save"}</button></div>}
        </form>
        {!isNew && <ChannelsPanel id={id!} listings={q.data!.listings} edit={edit} onChange={() => q.refetch()} />}
      </div>
    </div>
  );
}

function ChannelsPanel({ id, listings, edit, onChange }: { id: string; listings: Listing[]; edit: boolean; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const call = async (path: string, body?: unknown) => {
    setError(null);
    try {
      await api(path, { method: "POST", body });
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section className="card stack">
      <div className="row">
        <h2>Where it's listed</h2>
        <span className="spacer" />
        {edit && <button className="btn btn-sm" onClick={() => call(`/vehicles/${id}/resync`)} title="Send the listing again everywhere, even if nothing changed">Send again</button>}
        <Link to={`/inbox?vehicleId=${id}`} className="small">Buyers →</Link>
      </div>
      {error && <div className="notice notice-bad">{error}</div>}
      <ul className="plain listings">
        {listings.map((l) => (
          <li key={l.channelId} className="stack-sm">
            <div className="row">
              <b className="grow">{l.channelName}</b>
              {!l.channelEnabled && <span className="badge">Channel paused</span>}
              {l.queued && <span className="badge badge-brand">Sending…</span>}
              <Status value={l.state} />
              {edit && (
                <label className="switch" title={l.wanted ? "Take it off this channel" : "List it on this channel"}>
                  <input type="checkbox" checked={l.wanted} onChange={(e) => call(`/vehicles/${id}/channels/${l.channelId}`, { wanted: e.target.checked })} aria-label={`List on ${l.channelName}`} />
                  <span />
                </label>
              )}
            </div>
            {l.wanted && l.errors.map((e) => <div key={e} className="small bad">✕ {e}</div>)}
            {l.wanted && l.warnings.map((w) => <div key={w} className="small warn">! {w}</div>)}
            {l.lastError && <div className="small bad">Last attempt failed: {l.lastError}</div>}
            {l.externalId && <div className="muted small">Listing {l.externalId}{l.publishedAt ? ` · first live ${ago(l.publishedAt)}` : ""}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
