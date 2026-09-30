import { useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useLogin, useMe } from "../api/auth";

/** Only same-site paths are allowed as the return address (no open redirects). */
const safeNext = (s: string | null) => (s && s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/login") ? s : "/");

export function Login() {
  const me = useMe();
  const login = useLogin();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const next = safeNext(params.get("next"));

  if (me.data) return <Navigate to={next} replace />;

  function submit(e: FormEvent) {
    e.preventDefault();
    login.mutate({ email: email.trim(), password });
  }

  return (
    <div className="login-page">
      <form className="card stack login-card" onSubmit={submit}>
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>Dealer Automation</span>
        </div>
        <h1>Sign in</h1>
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {login.isError && (
          <div className="field-error" role="alert">
            {login.error.message}
          </div>
        )}
        <button className="btn btn-primary" type="submit" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
        <p className="muted small">Forgotten your password? Ask your admin to reset it.</p>
      </form>
    </div>
  );
}
