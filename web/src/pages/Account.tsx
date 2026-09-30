import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useMe } from "../api/auth";
import { api, ApiError, errorText } from "../api/client";

export function Account() {
  const me = useMe();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const change = useMutation({
    mutationFn: () => api("/auth/password", { method: "POST", body: { currentPassword: current, newPassword: next } }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
    },
  });
  const errs = change.error instanceof ApiError ? change.error.details : {};

  function submit(e: FormEvent) {
    e.preventDefault();
    setMismatch(next !== confirm);
    if (next === confirm) change.mutate();
  }

  return (
    <div className="wrap narrow">
      <div className="page-head">
        <h1>My account</h1>
      </div>
      <section className="card stack" style={{ maxWidth: 480 }}>
        <p style={{ margin: 0 }}>
          <strong>{me.data?.name}</strong> · {me.data?.email} · {me.data?.role}
        </p>
        <form className="stack" onSubmit={submit} noValidate>
          <h2 style={{ margin: 0 }}>Change password</h2>
          <label>
            Current password
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            {errs.currentPassword && <div className="field-error">{errs.currentPassword}</div>}
          </label>
          <label>
            New password
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            <span className="muted small">At least 10 characters with letters and a number.</span>
            {errs.newPassword && <div className="field-error">{errs.newPassword}</div>}
          </label>
          <label>
            Repeat new password
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            {mismatch && <div className="field-error">The passwords don't match.</div>}
          </label>
          {change.isError && !Object.keys(errs).length && <div className="field-error">{errorText(change.error)}</div>}
          {change.isSuccess && <div className="notice notice-good">Password changed. Your other devices have been signed out.</div>}
          <button type="submit" className="btn btn-primary" disabled={change.isPending}>
            Change password
          </button>
        </form>
      </section>
    </div>
  );
}
