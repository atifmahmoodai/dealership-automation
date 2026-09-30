import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { can, useLoadedMeta, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Modal } from "../components/ui";
import { TRIGGER_LABEL } from "../../../shared/automation";
import { RULE_TRIGGERS, TEMPLATE_FIELDS, type RuleTrigger } from "../../../shared/schemas";
import type { Rule } from "../../../shared/types";

const WHEN: Record<RuleTrigger, string> = {
  new_enquiry: "after a buyer's first message",
  no_reply: "after we wrote and the buyer went quiet",
  price_drop: "when the price of a car they asked about goes down",
  sold: "when the car they asked about is sold",
};

const delayText = (r: Pick<Rule, "trigger" | "delayMinutes">) => {
  if (r.trigger === "price_drop" || r.trigger === "sold") return "straight away";
  const m = r.delayMinutes;
  if (m === 0) return "straight away";
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? "" : "s"}`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? "" : "s"}`;
  return `${m} minutes`;
};

export function Rules() {
  const role = useMe().data!.role;
  const meta = useLoadedMeta();
  const q = useQuery({ queryKey: ["rules"], queryFn: () => api<{ items: Rule[] }>("/rules") });
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const s = meta.settings;
  return (
    <div className="wrap stack">
      <div className="row">
        <h1>Follow-ups</h1>
        <span className="spacer" />
        {can.manage(role) && <button className="btn btn-primary" onClick={() => setEditing("new")}>Add follow-up</button>}
      </div>
      <p className="muted">
        Automatic messages to buyers. Always true: buyers who reply STOP get nothing more; nothing automatic goes out between {s.quietStart} and {s.quietEnd} (it waits);
        a buyer gets at most {s.maxAutoPerWeek} automatic messages a week; each follow-up is sent at most once per conversation; follow-ups about a car that has gone are cancelled.
      </p>
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      <div className="stack">
        {q.data?.items.map((r) => (
          <section key={r.id} className={`card stack ${r.enabled ? "" : "muted"}`}>
            <div className="row">
              <h2 className="grow">{r.name}</h2>
              {!r.enabled && <span className="badge">Off</span>}
              {can.manage(role) && <button className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>}
            </div>
            <p className="small">
              <b>{TRIGGER_LABEL[r.trigger]}</b>: sent {delayText(r)} {WHEN[r.trigger]}. Last 7 days: {r.sent7d} sent, {r.suppressed7d} held back or cancelled.
            </p>
            <p className="template">{r.template}</p>
          </section>
        ))}
      </div>
      {editing && <RuleForm rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RuleForm({ rule, onClose }: { rule: Rule | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: rule?.name ?? "", trigger: rule?.trigger ?? ("new_enquiry" as RuleTrigger), delayMinutes: rule?.delayMinutes ?? 0, template: rule?.template ?? "Hi {buyer_first_name}, ", enabled: rule?.enabled ?? true });
  const [preview, setPreview] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ text: string }>("/rules/preview", { method: "POST", body: { template: f.template } }).then((r) => setPreview(r.text), () => setPreview(""));
    }, 250);
    return () => clearTimeout(t);
  }, [f.template]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(rule ? `/rules/${rule.id}` : "/rules", { method: rule ? "PUT" : "POST", body: f });
      await qc.invalidateQueries({ queryKey: ["rules"] });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const timed = f.trigger === "new_enquiry" || f.trigger === "no_reply";
  return (
    <Modal title={rule ? `Edit "${rule.name}"` : "Add a follow-up"} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <div className="grid-3">
          <label>Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>When<select value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value as RuleTrigger })}>{RULE_TRIGGERS.map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}</select></label>
          {timed && (
            <label>
              {f.trigger === "no_reply" ? "Wait (hours of silence)" : "Wait (minutes)"}
              <input
                inputMode="numeric"
                value={f.trigger === "no_reply" ? String(f.delayMinutes / 60) : String(f.delayMinutes)}
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/[^\d.]/g, "")) || 0;
                  setF({ ...f, delayMinutes: Math.round(f.trigger === "no_reply" ? n * 60 : n) });
                }}
              />
            </label>
          )}
        </div>
        <label>
          Message
          <textarea rows={4} value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })} />
        </label>
        <p className="muted small">Fields: {TEMPLATE_FIELDS.map((t) => <code key={t}>{`{${t}}`}</code>).reduce<React.ReactNode[]>((a, c, i) => (i ? [...a, " ", c] : [c]), [])}</p>
        {preview && (
          <div className="small">
            <b>Preview</b>
            <p className="template">{preview}</p>
          </div>
        )}
        <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> On (switching off also cancels what it had lined up)</label>
        {error && <div className="notice notice-bad">{error}</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save</button></div>
      </form>
    </Modal>
  );
}
