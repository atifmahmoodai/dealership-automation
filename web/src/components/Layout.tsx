import { Suspense } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import { can, useLogout, useMe, useMeta } from "../api/auth";
import { errorText } from "../api/client";

/** Signed-in shell. `print` drops the navigation for printable documents. */
export function Layout({ print = false }: { print?: boolean }) {
  const me = useMe();
  const meta = useMeta(!!me.data);
  const logout = useLogout();
  const location = useLocation();

  if (me.isPending) return <div className="wrap muted">Loading…</div>;
  if (me.isError) return <div className="wrap"><div className="notice">{errorText(me.error)}</div></div>;
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (meta.isPending) return <div className="wrap muted">Loading…</div>;
  if (meta.isError) {
    return (
      <div className="wrap">
        <div className="card">
          <h1>Couldn't reach the server</h1>
          <p className="muted">{errorText(meta.error)}</p>
          <button className="btn btn-primary" onClick={() => void meta.refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  const user = me.data;
  const role = user.role;
  if (print) {
    return (
      <Suspense fallback={<div className="wrap muted">Loading…</div>}>
        <Outlet />
      </Suspense>
    );
  }
  return (
    <>
      <header className="appbar">
        <div className="appbar-inner">
          <NavLink to="/" end className="brand">
            <img src="/favicon.svg" alt="" width={26} height={26} />
            <span>{meta.data.settings.dealerName}</span>
          </NavLink>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>Dashboard</NavLink>
            <NavLink to="/stock">Stock</NavLink>
            <NavLink to="/inbox">Inbox</NavLink>
            <NavLink to="/channels">Channels</NavLink>
            <NavLink to="/rules">Follow-ups</NavLink>
            {can.admin(role) && <NavLink to="/settings">Settings</NavLink>}
            {can.admin(role) && <NavLink to="/audit">Activity</NavLink>}
          </nav>
          <span className="spacer" />
          <div className="user small">
            <NavLink to="/account" title="My account">
              {user.name}
            </NavLink>{" "}
            <span className="muted">({role})</span>
            <button className="btn btn-sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main>
        <Suspense fallback={<div className="wrap muted">Loading…</div>}>
          <Outlet />
        </Suspense>
      </main>
    </>
  );
}
