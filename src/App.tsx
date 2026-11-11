import { NavLink, Route, Routes } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Shipments from "./pages/Shipments";
import ShipmentDetail from "./pages/ShipmentDetail";
import PurchaseOrders from "./pages/PurchaseOrders";
import NewShipment from "./pages/NewShipment";
import { useApi } from "./components/ui";

const nav = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/shipments", label: "Shipments" },
  { to: "/pos", label: "Purchase orders" },
];

export default function App() {
  const { data: me } = useApi<{ email: string }>("/me");
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold text-teal-800">
            <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
              <rect x="2" y="9" width="28" height="16" rx="2" fill="currentColor" />
              <path d="M8 12v10M13 12v10M18 12v10M23 12v10" stroke="white" strokeWidth="2" />
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
                  `rounded-md px-3 py-1.5 text-sm font-medium ${
                    isActive ? "bg-teal-50 text-teal-800" : "text-slate-600 hover:bg-slate-100"
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto text-xs text-slate-500">{me?.email}</div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/shipments" element={<Shipments />} />
          <Route path="/shipments/new" element={<NewShipment />} />
          <Route path="/shipments/:id" element={<ShipmentDetail />} />
          <Route path="/pos" element={<PurchaseOrders />} />
        </Routes>
      </main>
    </div>
  );
}
