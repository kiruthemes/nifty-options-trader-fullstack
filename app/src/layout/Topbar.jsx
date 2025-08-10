import React, { useEffect, useMemo, useState } from "react";
import * as StrategyStore from "../utils/strategyStore.js";
import { isAuthed, getUser, login, register, clearAuth } from "../utils/auth.js";

console.log("%cTopbar v8", "color:#10b981");

export default function Topbar({ theme = "light", onToggleTheme }) {
  const [authed, setAuthed] = useState(isAuthed());
  const [user, setUser] = useState(getUser());
  const displayName = user?.name || user?.email || "Account";

  // Underlying
  const [underlying, setUnderlying] = useState(() => localStorage.getItem("ui.underlying") || "NIFTY");
  const persistUnderlying = (val) => {
    localStorage.setItem("ui.underlying", val);
    setUnderlying(val);
    window.dispatchEvent(new CustomEvent("ui:underlying-change", { detail: val }));
  };

  // Market chips (NIFTY/VIX/PCR)
  const [spot, setSpot] = useState(), [pcNifty, setPcNifty] = useState();
  const [vix, setVix] = useState(), [pcVix, setPcVix] = useState();
  const [pcr, setPcr] = useState(), [pcrOpen, setPcrOpen] = useState();
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
  const vixChip   = useMemo(() => chipDelta("India VIX", vix, pcVix), [vix, pcVix]);
  const pcrChip   = useMemo(() => chipDelta("PCR", pcr, pcrOpen), [pcr, pcrOpen]);

  // Strategies
  const [strategies, setStrategies] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [currentId, setCurrentId] = useState(() => StrategyStore.getCurrentId());
  const [currentName, setCurrentName] = useState("");

  const refreshStrategies = async () => {
    const list = await StrategyStore.listAsync(showArchived);
    setStrategies(list);
    const id = StrategyStore.getCurrentId();
    setCurrentId(id);
    const active = list.find(s => String(s.id) === String(id));
    setCurrentName(active?.name || "");
  };
  useEffect(() => { refreshStrategies(); }, [showArchived, authed]);

  // Keep strategy in sync on selection
  useEffect(() => {
    const handleSelect = async (e) => {
      const id = String(e.detail);
      setCurrentId(id);
      await refreshStrategies();
    };
    const handleSwitch = async (e) => {
      const id = String(e.detail?.id);
      setCurrentId(id);
      await refreshStrategies();
    };
    window.addEventListener("strategy:selected", handleSelect);
    window.addEventListener("strategy:switch", handleSwitch);
    return () => {
      window.removeEventListener("strategy:selected", handleSelect);
      window.removeEventListener("strategy:switch", handleSwitch);
    };
  }, [showArchived, authed]);

  const selectStrategy = (id) => {
    StrategyStore.setCurrentId(String(id));
    window.dispatchEvent(new CustomEvent("strategy:selected", { detail: String(id) }));
    window.dispatchEvent(new CustomEvent("strategy:switch",   { detail: { id: String(id) } }));
    refreshStrategies();
    setStratMenuOpen(false);
  };

  const toggleArchive = async (id, archived) => {
    await StrategyStore.setArchived(id, !archived);
    await refreshStrategies();
  };

  // Create Strategy modal
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const openCreateModal = () => { setNewName(""); setCreateOpen(true); setStratMenuOpen(false); };
  const closeCreateModal = () => setCreateOpen(false);
  const submitCreate = async (e) => {
    e?.preventDefault?.();
    const name = (newName || "").trim() || "Untitled Strategy";
    const id = await StrategyStore.createAsync(name);
    window.dispatchEvent(new CustomEvent("strategy:switch", { detail: { id } }));
    await refreshStrategies();
    setCreateOpen(false);
  };

  // Auth modal
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const openAuth = () => { setEmail(''); setPassword(''); setName(''); setAuthMode('login'); setAuthOpen(true); };
  const closeAuth = () => setAuthOpen(false);
  const submitAuth = async (e) => {
    e?.preventDefault?.();
    try {
      const u = authMode === 'login' ? await login(email, password) : await register(email, password, name);
      setUser(u); setAuthed(true); setAuthOpen(false);
      await refreshStrategies();
    } catch (err) {
      alert(err.message || 'Auth failed');
    }
  };
  const signOut = async () => { clearAuth(); setAuthed(false); setUser({}); await refreshStrategies(); };

  // Dropdown toggles
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [stratMenuOpen, setStratMenuOpen] = useState(false);
  useEffect(() => {
    const onDoc = (e) => {
      if (!(e.target.closest && e.target.closest(".user-menu"))) setUserMenuOpen(false);
      if (!(e.target.closest && e.target.closest(".strategy-menu"))) setStratMenuOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  return (
    <header className="card sticky top-3 z-30 px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="text-sm font-semibold">Ivy Options</div>

        {/* Strategy pill */}
        <div className="relative strategy-menu">
          <button
            className="text-xs px-2 h-8 rounded-xl border dark:border-blue-gray-700 inline-flex items-center gap-2 hover:bg-gray-50 dark:hover:bg-blue-gray-800"
            onClick={() => setStratMenuOpen((s) => !s)}
            title="Manage strategies"
          >
            <span className="text-[11px] uppercase tracking-wide text-blue-600">Strategy</span>
            <span className="font-semibold truncate max-w-[220px]">{currentName || "—"}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" fill="none">
              <path strokeWidth="2" d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {stratMenuOpen && (
            <div className="absolute mt-2 w-[440px] max-w-[90vw] max-h-[70vh] overflow-hidden rounded-2xl bg-white dark:bg-blue-gray-900 border border-gray-200 dark:border-blue-gray-800 shadow-2xl">
              {/* header */}
              <div className="px-4 py-3 flex items-center justify-between border-b dark:border-blue-gray-800">
                <div className="text-sm font-semibold">Strategies <span className="muted">{authed ? "" : "(local)"}</span></div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" className="accent-blue-600" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                    <span className="muted">Show archived</span>
                  </label>
                  <button
                    className="h-8 px-3 rounded-lg bg-blue-600 text-white text-xs font-medium hover:brightness-110"
                    onClick={openCreateModal}
                  >
                    + New
                  </button>
                </div>
              </div>

              {/* list */}
              <div className="max-h-[58vh] overflow-y-auto divide-y dark:divide-blue-gray-800">
                {strategies.length === 0 && (
                  <div className="p-4 text-sm muted">No strategies yet.</div>
                )}

                {strategies.map((s) => {
                  const active = String(s.id) === String(currentId);
                  return (
                    <div key={s.id} className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-gray-50 dark:hover:bg-blue-gray-800/40">
                      <div className="flex items-center gap-3 overflow-hidden">
                        <span className={`w-2.5 h-2.5 rounded-full ${active ? "bg-emerald-500" : "bg-gray-300 dark:bg-blue-gray-700"}`} />
                        <div className="truncate">
                          <div className="text-sm font-medium truncate">
                            {s.name} {s.archived ? <span className="muted">(archived)</span> : null}
                          </div>
                          <div className="text-[11px] muted">Updated {new Date(s.updatedAt || Date.now()).toLocaleString()}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {active ? (
                          <span className="px-2 h-7 inline-flex items-center rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-200 dark:border-emerald-800">
                            Active
                          </span>
                        ) : !s.archived ? (
                          <button
                            className="h-8 px-3 rounded-lg bg-blue-600 text-white text-xs font-medium hover:brightness-110"
                            onClick={() => selectStrategy(s.id)}
                          >
                            Load
                          </button>
                        ) : null}
                        <button
                          className="h-8 px-3 rounded-lg border text-xs hover:bg-gray-50 dark:hover:bg-blue-gray-800 dark:border-blue-gray-700"
                          title={s.archived ? "Unarchive" : "Archive"}
                          onClick={() => toggleArchive(s.id, s.archived)}
                        >
                          {s.archived ? "Unarchive" : "Archive"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Underlying dropdown */}
        <UnderlyingDropdown value={underlying} onChange={persistUnderlying} />

        {/* Chips */}
        <div className="ml-auto flex items-center gap-2">
          <span className={niftyChip.cls}>{niftyChip.txt}</span>
          <span className={vixChip.cls}>{vixChip.txt}</span>
          <span className={pcrChip.cls} title="OI Put/Call ratio (Δ since open)">{pcrChip.txt}</span>
        </div>

        {/* User + Theme */}
        <div className="flex items-center gap-2">
          {authed ? (
            <UserMenu displayName={displayName} email={user?.email} onSignOut={signOut} />
          ) : (
            <button className="icon-btn" title="Sign in" onClick={openAuth}>
              <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" fill="none"><path strokeWidth="2" d="M16 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4" strokeWidth="2"/></svg>
            </button>
          )}
          <button className="icon-btn" title="Toggle theme" onClick={() => onToggleTheme?.()}>
            {theme === "dark" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" fill="none"><circle cx="12" cy="12" r="4" strokeWidth="2"/><path strokeWidth="2" d="M12 2v2M12 20v2M20 12h2M2 12H4M18.36 5.64l1.41-1.41M4.23 19.78l1.41-1.41M5.64 5.64L4.23 4.23M19.78 19.78l-1.41-1.41"/></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" fill="none"><path strokeWidth="2" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
            )}
          </button>
        </div>
      </div>

      {/* Create Strategy Modal */}
      {createOpen && (
        <Modal title="Create Strategy" onClose={closeCreateModal} onSubmit={submitCreate}>
          <label className="text-xs muted block">Strategy name</label>
          <input autoFocus type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g., NIFTY Iron Condor" className="w-full h-10 px-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900" />
        </Modal>
      )}

      {/* Auth Modal */}
      {authOpen && (
        <Modal title={authMode === 'login' ? 'Sign in' : 'Create account'} onClose={closeAuth} onSubmit={submitAuth}>
          {authMode === 'register' && (
            <div>
              <label className="text-xs muted block">Name</label>
              <input type="text" value={name} onChange={(e)=>setName(e.target.value)} className="w-full h-10 px-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900" />
            </div>
          )}
          <div>
            <label className="text-xs muted block">Email</label>
            <input type="email" required value={email} onChange={(e)=>setEmail(e.target.value)} className="w-full h-10 px-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900" />
          </div>
          <div>
            <label className="text-xs muted block">Password</label>
            <input type="password" required value={password} onChange={(e)=>setPassword(e.target.value)} className="w-full h-10 px-3 rounded-xl border dark:border-blue-gray-700 bg-white dark:bg-blue-gray-900" />
          </div>
          <div className="flex items-center justify-between pt-2">
            <button type="button" className="text-xs underline" onClick={()=>setAuthMode(authMode==='login'?'register':'login')}>
              {authMode==='login' ? 'Create account' : 'Have an account? Sign in'}
            </button>
            <button type="submit" className="px-4 h-9 rounded-xl bg-blue-600 text-white text-sm font-medium hover:brightness-110">
              {authMode==='login' ? 'Sign in' : 'Register'}
            </button>
          </div>
        </Modal>
      )}
    </header>
  );
}

function UserMenu({ displayName, email, onSignOut }) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  useEffect(() => {
    const onDoc = (e) => { if (!(e.target.closest && e.target.closest(".user-menu"))) setUserMenuOpen(false); };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);
  return (
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
          <div className="px-3 py-2 text-xs muted break-all">{email}</div>
          <button className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-blue-gray-800" onClick={onSignOut}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function Modal({ title, onClose, onSubmit, children }) {
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <form onSubmit={onSubmit} className="absolute inset-0 flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl bg-white dark:bg-blue-gray-900 border border-gray-200 dark:border-blue-gray-800 shadow-2xl">
          <div className="px-4 py-3 border-b dark:border-blue-gray-800 flex items-center justify-between">
            <div className="text-sm font-semibold">{title}</div>
            <button type="button" className="icon-btn" onClick={onClose} title="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" fill="none"><path strokeWidth="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
          <div className="p-4 space-y-3">{children}</div>
        </div>
      </form>
    </div>
  );
}

function UnderlyingDropdown({ value = "NIFTY", onChange }) {
  const [open, setOpen] = useState(false);
  const opts = ["NIFTY", "BANKNIFTY"];
  useEffect(() => {
    const onDoc = (e) => { if (!(e.target.closest && e.target.closest(".underlying-dd"))) setOpen(false); };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);
  return (
    <div className="relative underlying-dd">
      <button className="h-8 px-3 rounded-xl border dark:border-blue-gray-700 text-xs font-medium hover:bg-gray-50 dark:hover:bg-blue-gray-800 inline-flex items-center gap-2" onClick={() => setOpen((s) => !s)} title="Change underlying">
        <span className="inline-block w-2 h-2 rounded-full bg-blue-600" />
        {value}
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" fill="none"><path strokeWidth="2" d="M6 9l6 6 6-6"/></svg>
      </button>
      {open && (
        <div className="absolute mt-2 w-44 rounded-xl bg-white dark:bg-blue-gray-900 border border-gray-200 dark:border-blue-gray-800 shadow-xl overflow-hidden">
          {opts.map((o) => (
            <button key={o} className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-blue-gray-800 ${o === value ? "font-semibold" : ""}`} onClick={() => { onChange?.(o); setOpen(false); }}>
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function chipDelta(label, curr, base) {
  const c = Number(curr), b = Number(base);
  if (!Number.isFinite(c) || !Number.isFinite(b) || b === 0) return { txt: `${label} —`, cls: "chip" };
  const chg = c - b, pct = (chg / b) * 100, up = chg >= 0;
  const txt = `${label} ${c.toLocaleString("en-IN",{maximumFractionDigits:2})}  ${up ? "▲" : "▼"} ${(chg>=0?'+':'')+chg.toFixed(2)} (${(chg>=0?'+':'')+Math.abs(pct).toFixed(2)}%)`;
  return { txt, cls: `chip ${up ? "chip-up" : "chip-down"}` };
}
