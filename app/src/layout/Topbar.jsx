// app/src/components/Topbar.jsx
import React, { useEffect, useMemo, useState } from "react";
import * as StrategyStore from "../utils/strategyStore.js";
import {
  isAuthed,
  getUser,
  login,
  register,
  clearAuth,
  onAuthChange,
  fetchMe,
  validateSession,
} from "../utils/auth.js";

console.log("%cTopbar v13 (validateSession + provider/kite creds)", "color:#10b981");

/* --- local API helpers (no extra imports) --- */
function authHeader() {
  try {
    const t = localStorage.getItem("auth.token");
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}
async function api(path, init = {}) {
  const headers = { "Content-Type": "application/json", ...authHeader(), ...(init.headers || {}) };
  const res = await fetch(path.startsWith("/api") ? path : `/api${path}`, { ...init, headers });
  if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
  const txt = await res.text();
  return txt ? JSON.parse(txt) : {};
}
const listBrokerAccounts = () => api("/brokers");
const getStrategyLinks = (sid) => api(`/brokers/strategy/${sid}`);
const createBrokerAccount = (payload) =>
  api("/brokers", { method: "POST", body: JSON.stringify(payload) });
const linkBroker = (strategyId, brokerAccountId) =>
  api("/brokers/link", { method: "POST", body: JSON.stringify({ strategyId, brokerAccountId }) });
const unlinkBroker = (strategyId, brokerAccountId) =>
  api("/brokers/unlink", { method: "POST", body: JSON.stringify({ strategyId, brokerAccountId }) });

// Provider endpoints (market router: GET is public, PATCH requires auth)
const getProvider = async () => {
  try {
    const r = await fetch("/api/market/provider", { method: "GET" });
    const j = await r.json().catch(() => ({}));
    return j.provider || "synthetic";
  } catch {
    return "synthetic";
  }
};
const setProviderReq = async (provider) => {
  const r = await fetch("/api/market/provider", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ provider }),
  });
  if (!r.ok) throw new Error("Failed to set provider");
  return r.json();
};

export default function Topbar({ theme = "light", onToggleTheme }) {
  // 👉 Start logged-out; validate below to avoid stale local token UI bug
  const [authed, setAuthed] = useState(false);
  const [user, setUser] = useState(null);
  const displayName = user?.name || user?.email || "Account";

  // Validate session on mount (no hard dependency on /api/auth/me)
  useEffect(() => {
    (async () => {
      try {
        const { authed: ok, user: u } = await validateSession();
        setAuthed(ok);
        setUser(ok ? u : null);
      } catch {
        setAuthed(false);
        setUser(null);
      }
    })();
  }, []);

  // Underlying
  const [underlying, setUnderlying] = useState(() => {
    try {
      return localStorage.getItem("ui.underlying") || "NIFTY";
    } catch {
      return "NIFTY";
    }
  });
  const persistUnderlying = (val) => {
    try {
      localStorage.setItem("ui.underlying", val);
    } catch {}
    setUnderlying(val);
    window.dispatchEvent(new CustomEvent("ui:underlying-change", { detail: val }));
  };

  // Market chips
  const [spot, setSpot] = useState(),
    [pcNifty, setPcNifty] = useState();
  const [vix, setVix] = useState(),
    [pcVix, setPcVix] = useState();
  const [pcr, setPcr] = useState(),
    [pcrOpen, setPcrOpen] = useState();
  useEffect(() => {
    const onMarket = (e) => {
      const d = e.detail || {};
      if ("spot" in d) setSpot(d.spot);
      if ("prevCloseNifty" in d) setPcNifty(d.prevCloseNifty);
      if ("vix" in d) setVix(d.vix);
      if ("prevCloseVix" in d) setPcVix(d.prevCloseVix);
      if ("pcr" in d) setPcr(d.pcr);
      if ("pcrOpen" in d) setPcrOpen(d.pcrOpen);
    };
    window.addEventListener("market:update", onMarket);
    return () => window.removeEventListener("market:update", onMarket);
  }, []);
  const niftyChip = useMemo(() => chipDelta("NIFTY ₹", spot, pcNifty), [spot, pcNifty]);
  const vixChip = useMemo(() => chipDelta("India VIX", vix, pcVix), [vix, pcVix]);
  const pcrChip = useMemo(() => chipDelta("PCR", pcr, pcrOpen), [pcr, pcrOpen]);

  // Provider
  const [provider, setProviderState] = useState("synthetic");
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  useEffect(() => {
    (async () => setProviderState(await getProvider()))();
  }, []);
  const changeProvider = async (p) => {
    try {
      await setProviderReq(p);
      setProviderState(p);
      setProviderMenuOpen(false);
      window.dispatchEvent(new CustomEvent("provider:change", { detail: p }));
    } catch (e) {
      alert(e.message || "Failed to set provider");
    }
  };

  // Strategies — current
  const [strategies, setStrategies] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [currentId, setCurrentId] = useState(null);
  const [currentName, setCurrentName] = useState("");

  // Broker linking UI state
  const [linkOpen, setLinkOpen] = useState(false);
  const [brokerAccounts, setBrokerAccounts] = useState([]);
  const [linked, setLinked] = useState([]);
  const [savingLink, setSavingLink] = useState(false);

  // Add-first-account inline form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProvider, setNewProvider] = useState("dhan");
  const [newLabel, setNewLabel] = useState("");
  // provider-specific creds
  const [newAccessToken, setNewAccessToken] = useState(""); // Dhan
  const [newApiKey, setNewApiKey] = useState(""); // Kite
  const [newApiSecret, setNewApiSecret] = useState(""); // Kite

  const refreshStrategies = async () => {
    try {
      const list = authed ? await StrategyStore.listAsync(showArchived) : [];
      setStrategies(list);
      const id = authed ? await StrategyStore.getCurrentIdAsync() : null;
      setCurrentId(id);
      if (id && authed) {
        const meta = await StrategyStore.getMetaByIdAsync(id);
        setCurrentName(meta?.name || "");
      } else {
        setCurrentName("");
      }
    } catch {
      setStrategies([]);
      setCurrentName("");
      setCurrentId(null);
    }
  };
  useEffect(() => {
    refreshStrategies();
  }, [showArchived, authed]);

  // Keep strategy name in sync on switch/save
  useEffect(() => {
    const onSwitch = async (e) => {
      const id = e.detail?.id;
      if (!id) return;
      await refreshStrategies();
      if (authed) await refreshBrokers(id);
    };
    window.addEventListener("strategy:switch", onSwitch);
    return () => window.removeEventListener("strategy:switch", onSwitch);
  }, [authed]);

  const selectStrategy = async (id) => {
    await StrategyStore.setCurrentIdAsync(id);
    window.dispatchEvent(new CustomEvent("strategy:switch", { detail: { id } }));
    await refreshStrategies();
    await refreshBrokers(id);
    setStratMenuOpen(false);
  };

  const toggleArchive = async (id, archived) => {
    if (!authed) {
      setAuthOpen(true);
      return;
    }
    await StrategyStore.setArchived(id, !archived);
    await refreshStrategies();
  };

  // Create Strategy modal
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const openCreateModal = () => {
    if (!authed) {
      setAuthOpen(true);
      return;
    }
    setNewName("");
    setCreateOpen(true);
    setStratMenuOpen(false);
  };
  const closeCreateModal = () => setCreateOpen(false);
  const submitCreate = async (e) => {
    e?.preventDefault?.();
    if (!authed) {
      setAuthOpen(true);
      return;
    }
    const name = (newName || "").trim() || "Untitled Strategy";
    const id = await StrategyStore.createAsync(name);
    await StrategyStore.setCurrentIdAsync(id);
    window.dispatchEvent(new CustomEvent("strategy:switch", { detail: { id } }));
    await refreshStrategies();
    await refreshBrokers(id);
    setCreateOpen(false);
  };

  // Auth modal (with Name for register)
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const openAuth = () => {
    setEmail("");
    setPassword("");
    setName("");
    setAuthMode("login");
    setAuthOpen(true);
  };
  const closeAuth = () => setAuthOpen(false);
  const submitAuth = async (e) => {
    e?.preventDefault?.();
    try {
      const u =
        authMode === "login" ? await login(email, password) : await register(email, password, name);
      setUser(u);
      setAuthed(true);
      setAuthOpen(false);
      window.dispatchEvent(new CustomEvent("auth:login"));
      await refreshStrategies();
      const id = await StrategyStore.getCurrentIdAsync();
      if (id) await refreshBrokers(id);
    } catch (err) {
      alert(err.message || "Auth failed");
    }
  };
  const signOut = async () => {
    clearAuth();
    StrategyStore.clearCurrentId();
    setAuthed(false);
    setUser(null);
    setBrokerAccounts([]);
    setLinked([]);
    await refreshStrategies();
    window.dispatchEvent(new CustomEvent("auth:logout"));
  };

  // Dropdown toggles
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [stratMenuOpen, setStratMenuOpen] = useState(false);
  useEffect(() => {
    const onDoc = (e) => {
      if (!(e.target.closest && e.target.closest(".user-menu"))) setUserMenuOpen(false);
      if (!(e.target.closest && e.target.closest(".strategy-menu"))) setStratMenuOpen(false);
      if (!(e.target.closest && e.target.closest(".provider-menu"))) setProviderMenuOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  // global auth sync
  useEffect(() => {
    const off = onAuthChange(async (payload) => {
      let signedIn = false;
      let nextUser = null;

      if (payload && typeof payload === "object" && "authed" in payload) {
        signedIn = !!payload.authed;
        nextUser = payload.user || null;
      } else {
        signedIn = !!payload;
        nextUser = payload || null;
      }

      setAuthed(signedIn);
      setUser(nextUser);

      if (!signedIn) {
        StrategyStore.clearCurrentId();
        setStrategies([]);
        setCurrentId(null);
        setCurrentName("");
        setBrokerAccounts([]);
        setLinked([]);
        window.dispatchEvent(new CustomEvent("strategy:clear"));
      } else {
        await refreshStrategies();
        const id = await StrategyStore.getCurrentIdAsync();
        if (id) await refreshBrokers(id);
      }
    });
    return off;
  }, []);

  /* -------- broker linking helpers -------- */
  const refreshBrokers = async (sid = currentId) => {
    if (!authed || !sid) {
      setBrokerAccounts([]);
      setLinked([]);
      return;
    }
    try {
      const [accs, links] = await Promise.all([listBrokerAccounts(), getStrategyLinks(sid)]);
      setBrokerAccounts(Array.isArray(accs) ? accs : []);
      setLinked(Array.isArray(links) ? links : []);
    } catch {
      setBrokerAccounts([]);
      setLinked([]);
    }
  };

  const openLink = async () => {
    if (!authed) {
      setAuthOpen(true);
      return;
    }
    if (!currentId) {
      alert("Load a strategy first");
      return;
    }
    await refreshBrokers(currentId);
    setShowAddForm(false);
    setLinkOpen(true);
  };

  const onToggleLink = async (accountId, checked) => {
    if (!currentId) return;
    setSavingLink(true);
    try {
      if (checked) {
        await linkBroker(currentId, accountId);
      } else {
        await unlinkBroker(currentId, accountId);
      }
      await refreshBrokers(currentId);
    } catch (e) {
      alert(e.message || "Failed to update link");
    } finally {
      setSavingLink(false);
    }
  };

  const onCreateAccount = async (e) => {
    e?.preventDefault?.();
    try {
      const payload = {
        provider: newProvider,
        label: newLabel || newProvider.toUpperCase(),
      };
      if (newProvider === "dhan") {
        payload.accessToken = newAccessToken.trim();
        if (!payload.accessToken) throw new Error("Access token is required for Dhan");
      } else if (newProvider === "kite") {
        payload.apiKey = newApiKey.trim();
        payload.apiSecret = newApiSecret.trim();
        if (!payload.apiKey || !payload.apiSecret) {
          throw new Error("API key and API secret are required for Zerodha (Kite)");
        }
      }

      await createBrokerAccount(payload);
      await refreshBrokers(currentId);

      // reset form
      setNewLabel("");
      setNewAccessToken("");
      setNewApiKey("");
      setNewApiSecret("");
      setShowAddForm(false);
    } catch (e) {
      alert(e.message || "Failed to create broker account");
    }
  };

  return (
    <header className="card sticky top-3 z-30 px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="text-sm font-semibold">Ivy Options</div>

        {/* Strategy pill */}
        <div className="relative strategy-menu">
          <button
            className="text-xs px-2 h-7 rounded-xl border dark:border-blue-gray-700 inline-flex items-center gap-2 hover:bg-gray-50 dark:hover:bg-blue-gray-800"
            onClick={() => setStratMenuOpen((s) => !s)}
            title="Manage strategies"
          >
            Strategy:{" "}
            <span className="font-semibold truncate max-w-[220px]">
              {currentName || (authed ? "—" : "Sign in")}
            </span>
            <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" fill="none">
              <path strokeWidth="2" d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {stratMenuOpen && (
            <div className="absolute mt-2 w-[480px] max-w-[90vw] max-h-[70vh] overflow-hidden rounded-2xl bg-white dark:bg-blue-gray-900 border border-gray-200 dark:border-blue-gray-800 shadow-xl">
              {/* header */}
              <div className="px-3 py-2 flex items-center justify-between border-b dark:border-blue-gray-800">
                <div className="text-sm font-semibold flex items-center gap-2">
                  Strategies{" "}
                  {authed ? "" : <span className="text-xs muted">(sign in required)</span>}
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="accent-blue-600"
                      checked={showArchived}
                      onChange={(e) => setShowArchived(e.target.checked)}
                    />
                    Show archived
                  </label>
                  <button
                    className={`px-3 h-8 rounded-xl text-xs font-medium ${
                      authed
                        ? "bg-blue-600 text-white hover:brightness-110"
                        : "bg-gray-200 text-gray-500 cursor-not-allowed"
                    }`}
                    onClick={authed ? openCreateModal : openAuth}
                    title={authed ? "New strategy" : "Sign in to create"}
                  >
                    + New
                  </button>
                </div>
              </div>

              {/* list */}
              <div className="max-h-[44vh] overflow-y-auto divide-y dark:divide-blue-gray-800">
                {strategies.length === 0 && (
                  <div className="p-4 text-sm muted">
                    {authed ? "No strategies yet." : "Sign in to load strategies."}
                  </div>
                )}

                {strategies.map((s) => {
                  const active = s.id === currentId;
                  return (
                    <div key={s.id} className="px-3 py-2 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 overflow-hidden">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            active ? "bg-emerald-500" : "bg-gray-300 dark:bg-blue-gray-700"
                          }`}
                        />
                        <div className="truncate">
                          <div className="text-sm font-medium truncate">
                            {s.name} {s.archived ? <span className="muted">(archived)</span> : null}
                          </div>
                          <div className="text-xs muted">
                            Updated {new Date(s.updatedAt || Date.now()).toLocaleString()}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {!s.archived && (
                          <button
                            className={`px-2 h-8 rounded-lg border dark:border-blue-gray-700 text-xs ${
                              active
                                ? "opacity-50 cursor-default"
                                : "hover:bg-gray-50 dark:hover:bg-blue-gray-800"
                            }`}
                            onClick={() => (authed ? !active && selectStrategy(s.id) : openAuth())}
                            title={authed ? "Load strategy" : "Sign in to load"}
                          >
                            {active ? "Active" : "Load"}
                          </button>
                        )}
                        <button
                          className={`icon-btn ${authed ? "" : "opacity-60"}`}
                          title={s.archived ? "Unarchive" : "Archive"}
                          onClick={() => (authed ? toggleArchive(s.id, s.archived) : openAuth())}
                        >
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            fill="none"
                          >
                            <path strokeWidth="2" d="M3 4h18v4H3z" />
                            <path strokeWidth="2" d="M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8" />
                            <path strokeWidth="2" d="M9 12h6" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Linked brokers section */}
              <div className="border-t dark:border-blue-gray-800">
                <div className="px-3 py-2 flex items-center justify-between">
                  <div className="text-sm font-semibold">Linked brokers (this strategy)</div>
                  <button
                    className={`px-2 h-8 rounded-xl text-xs font-medium ${
                      authed && currentId
                        ? "bg-blue-600 text-white hover:brightness-110"
                        : "bg-gray-200 text-gray-500 cursor-not-allowed"
                    }`}
                    onClick={authed ? openLink : openAuth}
                    title={authed ? "Manage broker links" : "Sign in to manage"}
                  >
                    Manage
                  </button>
                </div>
                <div className="px-3 pb-3">
                  {!authed ? (
                    <div className="text-sm muted">Sign in to manage brokers.</div>
                  ) : !currentId ? (
                    <div className="text-sm muted">Load a strategy to link brokers.</div>
                  ) : linked.length === 0 ? (
                    <div className="text-sm muted">No broker accounts linked.</div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {linked.map((l) => (
                        <span
                          key={l.id}
                          className="px-2 py-1 text-xs rounded-lg border dark:border-blue-gray-700"
                        >
                          {l.label || l.provider}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Underlying dropdown */}
        <UnderlyingDropdown value={underlying} onChange={persistUnderlying} />

        {/* Provider dropdown */}
        <div className="relative provider-menu">
          <button
            className="h-8 px-3 rounded-xl border dark:border-blue-gray-700 text-xs font-medium hover:bg-gray-50 dark:hover:bg-blue-gray-800 inline-flex items-center gap-2"
            onClick={() => setProviderMenuOpen((s) => !s)}
            title="Change data/order provider"
          >
            Provider: <span className="font-semibold">{provider.toUpperCase()}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" fill="none">
              <path strokeWidth="2" d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {providerMenuOpen && (
            <div className="absolute mt-2 w-44 rounded-xl bg-white dark:bg-blue-gray-900 border border-gray-200 dark:border-blue-gray-800 shadow-lg overflow-hidden">
              {["dhan", "kite", "synthetic"].map((p) => (
                <button
                  key={p}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-blue-gray-800 ${
                    p === provider ? "font-semibold" : ""
                  }`}
                  onClick={() => changeProvider(p)}
                >
                  {p === "kite" ? "Zerodha (Kite)" : p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Chips */}
        <div className="ml-auto flex items-center gap-2">
          <span className={niftyChip.cls}>{niftyChip.txt}</span>
          <span className={vixChip.cls}>{vixChip.txt}</span>
          <span className={pcrChip.cls} title="OI Put/Call ratio (Δ since open)">
            {pcrChip.txt}
          </span>
        </div>

        {/* User + Theme */}
        <div className="flex items-center gap-2">
          {authed ? (
            <div className="relative user-menu">
              <button
                className="h-8 px-3 rounded-xl border dark:border-blue-gray-700 text-xs hover:bg-gray-50 dark:hover:bg-blue-gray-800"
                onClick={() => setUserMenuOpen((s) => !s)}
                title="Account"
              >
                {displayName}
              </button>
              {userMenuOpen && (
                <div className="absolute right-0 mt-2 w-44 rounded-xl bg-white dark:bg-blue-gray-900 border border-gray-200 dark:border-blue-gray-800 shadow-lg overflow-hidden">
                  <div className="px-3 py-2 text-xs muted">{user?.email}</div>
                  <button
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-blue-gray-800"
                    onClick={signOut}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button className="icon-btn" title="Sign in" onClick={openAuth}>
              <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" fill="none">
                <path strokeWidth="2" d="M16 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                <circle cx="12" cy="7" r="4" strokeWidth="2" />
              </svg>
            </button>
          )}

          <button className="icon-btn" title="Toggle theme" onClick={() => onToggleTheme?.()}>
            {theme === "dark" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" fill="none">
                <circle cx="12" cy="12" r="4" strokeWidth="2" />
                <path
                  strokeWidth="2"
                  d="M12 2v2M12 20v2M20 12h2M2 12H4M18.36 5.64l1.41-1.41M4.23 19.78l1.41-1.41M5.64 5.64L4.23 4.23M19.78 19.78l-1.41-1.41"
                />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" fill="none">
                <path strokeWidth="2" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Create Strategy Modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={closeCreateModal} />
          <form
            onSubmit={submitCreate}
            className="absolute inset-0 flex items-center justify-center p-4"
          >
            <div className="w-full max-w-md rounded-2xl bg-white dark:bg-blue-gray-900 border border-gray-200 dark:border-blue-gray-800 shadow-2xl">
              <div className="px-4 py-3 border-b dark:border-blue-gray-800 flex items-center justify-between">
                <div className="text-sm font-semibold">Create Strategy</div>
                <button type="button" className="icon-btn" onClick={closeCreateModal} title="Close">
                  <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" fill="none">
                    <path strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="p-4 space-y-3">
                <label className="text-xs muted block">Strategy name</label>
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g., NIFTY Iron Condor"
                  className="w-full h-10 px-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900"
                />
                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    className="px-3 h-9 rounded-xl border dark:border-blue-gray-700 text-sm hover:bg-gray-50 dark:hover:bg-blue-gray-800"
                    onClick={closeCreateModal}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 h-9 rounded-xl bg-blue-600 text-white text-sm font-medium hover:brightness-110"
                  >
                    Create
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Auth Modal */}
      {authOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={closeAuth} />
          <form
            onSubmit={submitAuth}
            className="absolute inset-0 flex items-center justify-center p-4"
          >
            <div className="w-full max-w-md rounded-2xl bg-white dark:bg-blue-gray-900 border border-gray-200 dark:border-blue-gray-800 shadow-2xl">
              <div className="px-4 py-3 border-b dark:border-blue-gray-800 flex items-center justify-between">
                <div className="text-sm font-semibold">
                  {authMode === "login" ? "Sign in" : "Create account"}
                </div>
                <button type="button" className="icon-btn" onClick={closeAuth} title="Close">
                  <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" fill="none">
                    <path strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="p-4 space-y-3">
                {authMode === "register" && (
                  <div>
                    <label className="text-xs muted block">Name</label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full h-10 px-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900"
                    />
                  </div>
                )}
                <div>
                  <label className="text-xs muted block">Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full h-10 px-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900"
                  />
                </div>
                <div>
                  <label className="text-xs muted block">Password</label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full h-10 px-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900"
                  />
                </div>
                <div className="flex items-center justify-between pt-2">
                  <button
                    type="button"
                    className="text-xs underline"
                    onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}
                  >
                    {authMode === "login" ? "Create account" : "Have an account? Sign in"}
                  </button>
                  <button
                    type="submit"
                    className="px-4 h-9 rounded-xl bg-blue-600 text-white text-sm font-medium hover:brightness-110"
                  >
                    {authMode === "login" ? "Sign in" : "Register"}
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Link/Manage Brokers Modal */}
      {linkOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setLinkOpen(false)} />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-blue-gray-900 border border-gray-200 dark:border-blue-gray-800 shadow-2xl">
              <div className="px-4 py-3 border-b dark:border-blue-gray-800 flex items-center justify-between">
                <div className="text-sm font-semibold">Manage broker links</div>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setLinkOpen(false)}
                  title="Close"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" fill="none">
                    <path strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="p-4 space-y-4">
                {/* Existing accounts */}
                <div>
                  <div className="text-xs muted mb-2">Your broker accounts</div>
                  {brokerAccounts.length === 0 ? (
                    <div className="rounded-xl border dark:border-blue-gray-800 p-3">
                      <div className="text-sm mb-2">No broker accounts yet.</div>
                      {!showAddForm ? (
                        <button
                          className="px-3 h-9 rounded-xl bg-blue-600 text-white text-sm font-medium"
                          onClick={() => setShowAddForm(true)}
                        >
                          + Add account
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {brokerAccounts.map((acc) => {
                        const isLinked = linked.some((l) => l.brokerAccountId === acc.id);
                        return (
                          <label
                            key={acc.id}
                            className="flex items-center justify-between px-3 py-2 rounded-xl border dark:border-blue-gray-800"
                          >
                            <div className="text-sm">
                              <div className="font-medium">{acc.label || acc.provider}</div>
                              <div className="text-xs muted">{acc.provider.toUpperCase()}</div>
                            </div>
                            <input
                              type="checkbox"
                              className="accent-blue-600 w-5 h-5"
                              checked={isLinked}
                              disabled={savingLink}
                              onChange={(e) => onToggleLink(acc.id, e.target.checked)}
                            />
                          </label>
                        );
                      })}
                      <button
                        className="px-3 h-9 rounded-xl border dark:border-blue-gray-700 text-sm hover:bg-gray-50 dark:hover:bg-blue-gray-800"
                        onClick={() => setShowAddForm((s) => !s)}
                      >
                        {showAddForm ? "Hide add form" : "+ Add another account"}
                      </button>
                    </div>
                  )}
                </div>

                {/* Add account form */}
                {showAddForm && (
                  <form
                    onSubmit={onCreateAccount}
                    className="rounded-xl border dark:border-blue-gray-800 p-3 space-y-3"
                  >
                    <div className="text-xs muted">Add broker account</div>

                    <div className="flex items-center gap-3">
                      <select
                        value={newProvider}
                        onChange={(e) => setNewProvider(e.target.value)}
                        className="h-10 px-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900 text-sm"
                      >
                        <option value="dhan">Dhan</option>
                        <option value="kite">Zerodha (Kite)</option>
                      </select>
                      <input
                        placeholder="Label (optional)"
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.target.value)}
                        className="flex-1 h-10 px-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900 text-sm"
                      />
                    </div>

                    {newProvider === "dhan" && (
                      <div className="space-y-2">
                        <label className="text-xs muted block">Access token (Dhan)</label>
                        <input
                          placeholder="Paste Dhan access token"
                          value={newAccessToken}
                          onChange={(e) => setNewAccessToken(e.target.value)}
                          className="w-full h-10 px-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900 text-sm"
                        />
                      </div>
                    )}

                    {newProvider === "kite" && (
                      <div className="space-y-2">
                        <div>
                          <label className="text-xs muted block">API key (Zerodha Kite)</label>
                          <input
                            placeholder="Enter API key"
                            value={newApiKey}
                            onChange={(e) => setNewApiKey(e.target.value)}
                            className="w-full h-10 px-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900 text-sm"
                          />
                        </div>
                        <div>
                          <label className="text-xs muted block">API secret</label>
                          <input
                            placeholder="Enter API secret"
                            type="password"
                            value={newApiSecret}
                            onChange={(e) => setNewApiSecret(e.target.value)}
                            className="w-full h-10 px-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900 text-sm"
                          />
                        </div>
                        <div className="text-[11px] muted">
                          You’ll generate a request token via Kite login later; for now we just
                          store key+secret.
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="px-3 h-9 rounded-xl border dark:border-blue-gray-700 text-sm"
                        onClick={() => setShowAddForm(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="px-4 h-9 rounded-xl bg-blue-600 text-white text-sm font-medium"
                      >
                        Save
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

function UnderlyingDropdown({ value = "NIFTY", onChange }) {
  const [open, setOpen] = useState(false);
  const opts = ["NIFTY", "BANKNIFTY"];
  useEffect(() => {
    const onDoc = (e) => {
      if (!(e.target.closest && e.target.closest(".underlying-dd"))) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);
  return (
    <div className="relative underlying-dd">
      <button
        className="h-8 px-3 rounded-xl border dark:border-blue-gray-700 text-xs font-medium hover:bg-gray-50 dark:hover:bg-blue-gray-800 inline-flex items-center gap-2"
        onClick={() => setOpen((s) => !s)}
        title="Change underlying"
      >
        <span className="inline-block w-2 h-2 rounded-full bg-blue-600" />
        {value}
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" fill="none">
          <path strokeWidth="2" d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute mt-2 w-40 rounded-xl bg-white dark:bg-blue-gray-900 border border-gray-200 dark:border-blue-gray-800 shadow-lg overflow-hidden">
          {opts.map((o) => (
            <button
              key={o}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-blue-gray-800 ${
                o === value ? "font-semibold" : ""
              }`}
              onClick={() => {
                onChange?.(o);
                setOpen(false);
              }}
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function chipDelta(label, curr, base) {
  const c = Number(curr),
    b = Number(base);
  if (!Number.isFinite(c) || !Number.isFinite(b) || b === 0)
    return { txt: `${label} —`, cls: "chip" };
  const chg = c - b,
    pct = (chg / b) * 100,
    up = chg >= 0;
  const txt = `${label} ${c.toLocaleString("en-IN", { maximumFractionDigits: 2 })}  ${
    up ? "▲" : "▼"
  } ${(chg >= 0 ? "+" : "") + chg.toFixed(2)} (${
    (chg >= 0 ? "+" : "") + Math.abs(pct).toFixed(2)
  }%)`;
  return { txt, cls: `chip ${up ? "chip-up" : "chip-down"}` };
}
