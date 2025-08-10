// src/layout/Sidebar.jsx
import React, { useEffect, useState } from "react";
import { inr } from "../utils/format.js";

// super-light inline icons (no extra deps)
const Icon = {
  menu: (cls = "w-5 h-5") => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path strokeWidth="2" strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  ),
  sun: (cls = "w-5 h-5") => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="4" strokeWidth="2" />
      <path
        strokeWidth="2"
        strokeLinecap="round"
        d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
      />
    </svg>
  ),
  moon: (cls = "w-5 h-5") => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path strokeWidth="2" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  ),
  dash: (cls = "w-5 h-5") => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="3" y="3" width="7" height="7" rx="2" strokeWidth="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" strokeWidth="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" strokeWidth="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" strokeWidth="2" />
    </svg>
  ),
  orders: (cls = "w-5 h-5") => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path strokeWidth="2" d="M4 6h16M4 12h10M4 18h7" strokeLinecap="round" />
    </svg>
  ),
  strategy: (cls = "w-5 h-5") => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path strokeWidth="2" d="M4 19h16M4 15h16M4 11h10M4 7h7" strokeLinecap="round" />
    </svg>
  ),
  backtest: (cls = "w-5 h-5") => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path strokeWidth="2" d="M3 3v18h18" />
      <path strokeWidth="2" d="M7 17l4-6 4 3 4-8" />
    </svg>
  ),
  settings: (cls = "w-5 h-5") => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path strokeWidth="2" d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
      <path
        strokeWidth="2"
        d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06A1.65 1.65 0 0015 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 008.6 15a1.65 1.65 0 00-1.82-.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0015 8.6a1.65 1.65 0 001.82.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 15z"
      />
    </svg>
  ),
  help: (cls = "w-5 h-5") => (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path strokeWidth="2" d="M9.09 9a3 3 0 115.82 1c0 2-3 2-3 4" />
      <path strokeWidth="2" d="M12 17h.01" />
      <circle cx="12" cy="12" r="10" strokeWidth="2" />
    </svg>
  ),
};

export default function Sidebar({ collapsed = false, onToggleCollapse, onToggleTheme, hotkeyHint }) {
  const [user, setUser] = useState(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("userProfile")) || {
          name: "Trader",
          email: "you@example.com",
          phone: "",
          risk: "Moderate",
        }
      );
    } catch {
      return { name: "Trader", email: "you@example.com", phone: "", risk: "Moderate" };
    }
  });

  const [snapshot] = useState({
    capital: 1000000,
    marginAvailable: 650000,
    dayPnL: 0,
  });

  const [brokers, setBrokers] = useState([
    { key: "dhan", label: "Dhan", connected: false },
    { key: "zerodha", label: "Zerodha", connected: false },
  ]);

  useEffect(() => {
    localStorage.setItem("userProfile", JSON.stringify(user));
  }, [user]);

  const initials = (user.name || "T")
    .split(" ")
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // dummy nav links (you can wire routes later)
  const links = [
    { key: "dashboard", label: "Dashboard", icon: Icon.dash },
    { key: "orders", label: "Orders", icon: Icon.orders },
    { key: "strategies", label: "Strategies", icon: Icon.strategy },
    { key: "backtest", label: "Backtest", icon: Icon.backtest },
    { key: "settings", label: "Settings", icon: Icon.settings },
    { key: "help", label: "Help", icon: Icon.help },
  ];

  return (
    <aside
      className={`p-3 card h-[calc(100vh-24px)] sticky top-3 flex flex-col gap-4 transition-all ${
        collapsed ? "w-16 items-center" : "w-72"
      }`}
    >
      {/* Header: avatar + collapse button */}
      <div
        className={`flex ${
          collapsed ? "flex-col items-center gap-2" : "items-center justify-between"
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center font-semibold">
            {initials}
          </div>
          {!collapsed && (
            <div>
              <div className="text-[15px] font-semibold">{user.name}</div>
              <div className="text-xs muted">{user.email}</div>
            </div>
          )}
        </div>

        <button
          className="px-2 py-2 rounded-lg border dark:border-blue-gray-700 hover:bg-gray-50 dark:hover:bg-blue-gray-800"
          onClick={onToggleCollapse}
          title={`Toggle sidebar (${typeof hotkeyHint === "string" ? hotkeyHint : "["})`}
          aria-label="Toggle sidebar"
        >
          {Icon.menu()}
        </button>
      </div>

      {/* Nav links */}
      <nav className="flex-0">
        <ul className="space-y-1">
          {links.map((l) => (
            <li key={l.key}>
              <a
                href="#"
                title={collapsed ? l.label : undefined}
                className={`flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-gray-800 ${
                  collapsed ? "justify-center" : ""
                }`}
              >
                {l.icon("w-5 h-5")}
                {!collapsed && <span className="text-sm">{l.label}</span>}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* Account snapshot */}
      {!collapsed && (
        <section className="p-3 rounded-xl bg-gray-50 dark:bg-blue-gray-800 border border-blue-gray-100 dark:border-blue-gray-700">
          <div className="text-sm font-semibold mb-2">Account</div>
          <div className="space-y-2 text-sm">
            <Row label="Capital" value={inr(snapshot.capital)} />
            <Row label="Available Margin" value={inr(snapshot.marginAvailable)} />
            <Row
              label="Day P&L"
              value={inr(snapshot.dayPnL)}
              valueClass={snapshot.dayPnL >= 0 ? "text-emerald-600" : "text-red-600"}
            />
          </div>
        </section>
      )}

      {/* Brokers */}
      {!collapsed && (
        <section className="p-3 rounded-xl bg-gray-50 dark:bg-blue-gray-800 border border-blue-gray-100 dark:border-blue-gray-700">
          <div className="text-sm font-semibold mb-2">Brokers</div>
          <div className="space-y-2">
            {brokers.map((b, i) => (
              <div key={b.key} className="flex items-center justify-between">
                <div className="text-sm">{b.label}</div>
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2 py-1 text-xs rounded-full ${
                      b.connected
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-gray-100 text-gray-700 dark:bg-blue-gray-700 dark:text-blue-gray-200"
                    }`}
                  >
                    {b.connected ? "Connected" : "Not connected"}
                  </span>
                  <button
                    className="text-xs px-2 py-1 rounded bg-blue-600 text-white"
                    onClick={() =>
                      setBrokers((arr) => {
                        const copy = [...arr];
                        copy[i] = { ...copy[i], connected: !copy[i].connected };
                        return copy;
                      })
                    }
                  >
                    {b.connected ? "Disconnect" : "Connect"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Footer controls */}
      <div
        className={`mt-auto flex ${
          collapsed ? "flex-col items-center gap-2" : "items-center justify-between"
        }`}
      >
        {!collapsed && <div className="text-[11px] muted">v0.1 • NIFTY Options Trader</div>}
        {onToggleTheme && (
          <button
            onClick={onToggleTheme}
            className={`px-3 py-2 rounded-lg bg-blue-600 text-white text-sm ${
              collapsed ? "w-10 h-10 flex items-center justify-center" : ""
            }`}
            title="Toggle theme"
            aria-label="Toggle theme"
          >
            {Icon.sun()}
          </button>
        )}
      </div>
    </aside>
  );
}

function Row({ label, value, valueClass = "" }) {
  return (
    <div className="flex items-center justify-between">
      <div className="muted">{label}</div>
      <div className={`font-medium ${valueClass}`}>{value}</div>
    </div>
  );
}
