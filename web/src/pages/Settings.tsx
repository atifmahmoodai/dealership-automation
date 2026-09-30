import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useLoadedMeta, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Modal } from "../components/ui";
import { ROLES, type Role } from "../../../shared/schemas";

export function Settings() {
  const me = useMe().data!;
  const meta = useLoadedMeta();
  const qc = useQueryClient();
  const [s, setS] = useState(meta.settings);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (me.role !== "admin") return <div className="wrap"><div className="notice">Only admins can change settings.</div></div>;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("/settings", { method: "PUT", body: s });
      await qc.invalidateQueries({ queryKey: ["meta"] });
      setMsg({ ok: true, text: "Saved." });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    }
  };
  const field = (k: keyof typeof s, label: string, type = "text") => (
    <label>{label}<input type={type} value={String(s[k])} onChange={(e) => setS({ ...s, [k]: type === "number" ? Number(e.target.value) : e.target.value })} /></label>
  );
  return (
    <div className="wrap stack">
      <h1>Settings</h1>
      <form className="card stack" onSubmit={save}>
        <div className="grid-3">
          {field("dealerName", "Dealership name")}
          {field("dealerPhone", "Phone (used in messages)")}
          {field("websiteUrl", "Website (links in messages)")}
          {field("currency", "Currency")}
          {field("locale", "Locale")}
          {field("maxAutoPerWeek", "Max automatic messages per buyer per week", "number")}
          {field("quietStart", "Quiet hours from", "time")}
          {field("quietEnd", "Quiet hours until", "time")}
        </div>
        <p className="muted small">Quiet hours use the dealership's time zone ({meta.timeZone}). Set both to the same time to turn them off.</p>
        {msg && <div className={`notice ${msg.ok ? "notice-good" : "notice-bad"}`}>{msg.text}</div>}
        <div className="row"><span className="spacer" /><button className="btn btn-primary">Save settings</button></div>
      </form>
      <Users />
    </div>
  );
}

interface UserRow { id: string; email: string; name: string; role: Role; active: boolean; locked: boolean }

function Users() {
  const q = useQuery({ queryKey: ["users"], queryFn: () => api<{ items: UserRow[] }>("/users") });
  const [editing, setEditing] = useState<UserRow | "new" | null>(null);
  return (
    <section className="card stack">
      <div className="row"><h2>Users</h2><span className="spacer" /><button className="btn" onClick={() => setEditing("new")}>Add user</button></div>
      <p className="muted small">Admins manage settings, channels and users. Managers manage stock and follow-ups. Sales staff see stock and answer buyers.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead>
          <tbody>
            {q.data?.items.map((u) => (
              <tr key={u.id} className={u.active ? "" : "muted"}>
                <td>{u.name}{!u.active && " (disabled)"}{u.locked && <span className="badge badge-warn">Locked</span>}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td className="num"><button className="btn btn-sm" onClick={() => setEditing(u)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <UserForm user={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function UserForm({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ email: user?.email ?? "", name: user?.name ?? "", role: user?.role ?? ("sales" as Role), active: user?.active ?? true, password: "" });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (user) {
        await api(`/users/${user.id}`, { method: "PUT", body: { name: f.name, role: f.role, active: f.active } });
        if (f.password) await api(`/users/${user.id}/password`, { method: "POST", body: { password: f.password } });
      } else {
        await api("/users", { method: "POST", body: { email: f.email, name: f.name, role: f.role, password: f.password } });
      }
      await qc.invalidateQueries({ queryKey: ["users"] });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={user ? `Edit ${user.name}` : "Add user"} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {!user && <label>Email<input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>}
        <label>Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Role<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
        <label>{user ? "New password (leave empty to keep)" : "Password"}<input type="password" autoComplete="new-password" required={!user} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        {user && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Can sign in</label>}
        {error && <div className="notice notice-bad">{error}</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save</button></div>
      </form>
    </Modal>
  );
}
