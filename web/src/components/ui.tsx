import { useState, type ReactNode } from "react";
import { centsToInput, MESSAGE_STATUS_LABEL, parseMoney, STATE_LABEL, VEHICLE_STATUS_LABEL } from "../lib/format";

export function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: ReactNode; tone?: "warn" }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

const TONES: Record<string, string> = {
  live: "badge-good",
  pending: "badge-brand",
  blocked: "badge-warn",
  error: "badge-bad",
  removed: "",
  off: "",
  available: "badge-good",
  reserved: "badge-warn",
  sold: "",
  withdrawn: "",
  sent: "badge-good",
  scheduled: "badge-brand",
  suppressed: "badge-warn",
  failed: "badge-bad",
  cancelled: "",
  received: "",
};
const LABELS: Record<string, string> = { ...STATE_LABEL, ...VEHICLE_STATUS_LABEL, ...MESSAGE_STATUS_LABEL };
export function Status({ value }: { value: string }) {
  return <span className={`badge ${TONES[value] ?? ""}`}>{LABELS[value] ?? value}</span>;
}

/** Amount field that keeps what the user typed and reports cents (NaN while it isn't a valid amount). */
export function MoneyInput({ label, cents, onChange, error, disabled }: { label: string; cents: number; onChange: (c: number) => void; error?: string; disabled?: boolean }) {
  const [text, setText] = useState(() => (Number.isFinite(cents) ? centsToInput(cents) : ""));
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : Number.isFinite(cents) ? centsToInput(cents) : text;
  const bad = shown.trim() !== "" && Number.isNaN(parseMoney(shown));
  return (
    <label>
      {label}
      <input
        inputMode="decimal"
        value={shown}
        disabled={disabled}
        aria-invalid={bad || !!error}
        onFocus={() => {
          setText(shown);
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.trim() === "" ? 0 : parseMoney(e.target.value));
        }}
      />
      {(bad || error) && <div className="field-error">{bad ? "Enter an amount like 1250 or 1250.50" : error}</div>}
    </label>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className={`card modal stack ${wide ? "modal-wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 0 }}>
          <h2>{title}</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

