import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";

const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const Dashboard = page(() => import("./pages/Dashboard"), "Dashboard");
const Stock = page(() => import("./pages/Stock"), "Stock");
const CarPage = page(() => import("./pages/CarPage"), "CarPage");
const Channels = page(() => import("./pages/Channels"), "Channels");
const Inbox = page(() => import("./pages/Inbox"), "Inbox");
const Rules = page(() => import("./pages/Rules"), "Rules");
const Settings = page(() => import("./pages/Settings"), "Settings");
const AuditLog = page(() => import("./pages/AuditLog"), "AuditLog");
const Account = page(() => import("./pages/Account"), "Account");

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="wrap muted">Loading…</div>}>
        <Routes>
          <Route path="login" element={<Login />} />
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="stock" element={<Stock />} />
            <Route path="stock/new" element={<CarPage />} />
            <Route path="stock/:id" element={<CarPage />} />
            <Route path="channels" element={<Channels />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="inbox/:id" element={<Inbox />} />
            <Route path="rules" element={<Rules />} />
            <Route path="settings" element={<Settings />} />
            <Route path="audit" element={<AuditLog />} />
            <Route path="account" element={<Account />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
