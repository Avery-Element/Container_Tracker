import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Shipments from "./pages/Shipments";
import ShipmentDetail from "./pages/ShipmentDetail";
import NewShipment from "./pages/NewShipment";
import PoDetail from "./pages/PoDetail";
import Activity from "./pages/Activity";
import { useApi } from "./components/ui";

const nav = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/shipments", label: "Shipments" },
  { to: "/activity", label: "Activity" },
];

export default function App() {
  const { data: me } = useApi<{ email: string }>("/me");
  // The shipments table is wide and data-dense, so it uses the full screen width;
  // other pages keep a readable max width.
  const width = useLocation().pathname === "/shipments" ? "max-w-none" : "max-w-7xl";
  return (
    <div className="min-h-screen">
      <header className="bg-ink text-white">
        <div className={`mx-auto flex ${width} flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6`}>
          <div className="flex items-center gap-2 font-display text-lg font-semibold tracking-[0.01em]">
            <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden className="text-hazard">
              <rect x="2" y="9" width="28" height="16" rx="2" fill="currentColor" />
              <path d="M8 12v10M13 12v10M18 12v10M23 12v10" stroke="var(--color-ink)" strokeWidth="2" />
            </svg>
            Container Tracker
          </div>
          <nav className="flex gap-1">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `border-b-2 px-3 py-1.5 text-sm font-medium ${
                    isActive ? "border-hazard text-white" : "border-transparent text-slate-300 hover:text-white"
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto text-xs text-slate-300">{me?.email}</div>
        </div>
      </header>
      <main className={`mx-auto ${width} px-4 py-4 sm:px-6 sm:py-6`}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/shipments" element={<Shipments />} />
          <Route path="/shipments/new" element={<NewShipment />} />
          <Route path="/shipments/:id" element={<ShipmentDetail />} />
          {/* POs now live on the shipments page; keep old bookmarks working. */}
          <Route path="/activity" element={<Activity />} />
          <Route path="/pos/:id" element={<PoDetail />} />
          <Route path="/pos" element={<Navigate to="/shipments" replace />} />
        </Routes>
      </main>
    </div>
  );
}
