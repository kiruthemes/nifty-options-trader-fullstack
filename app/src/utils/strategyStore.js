// app/src/utils/strategyStore.js
// DB-first strategy store. Current strategy is tracked on the server (User.lastStrategyId).

import { getToken } from "./auth.js";

const API = import.meta.env.VITE_API_BASE || "";

/* ---------------- internal fetch helpers ---------------- */
function authHeaders() {
  const t = getToken?.();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
async function j(res) {
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(txt || `HTTP ${res.status}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : {};
}
async function api(path, init = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...authHeaders(),
    ...(init.headers || {}),
  };
  const url = path.startsWith("/api") ? `${API}${path}` : `${API}/api${path}`;
  const res = await fetch(url, { ...init, headers });
  return j(res);
}

/* ---------------- current strategy id (DB-backed) ---------------- */
export async function getCurrentIdAsync() {
  try {
    const r = await api(`/strategies/last`);
    return r?.id ?? null;
  } catch {
    return null;
  }
}

export async function setCurrentIdAsync(id) {
  if (!id) return;
  await api(`/strategies/${id}/select`, { method: "POST" });
}

/** No-op legacy helpers kept for compatibility */
export function getCurrentId() { return null; }
export function setCurrentId(_id) { /* no-op; server owns this now */ }

/** Clear any client-local pointers on logout (kept for callers) */
export function clearCurrentId() { /* no-op */ }
export function resetLocalOnLogout() { clearCurrentId(); }

/* ---------------- list / get / create / patch ---------------- */
export async function listAsync(includeArchived = false) {
  const q = includeArchived ? "?includeArchived=1" : "";
  const items = await api(`/strategies${q}`);
  return Array.isArray(items) ? items : [];
}

export async function getAsync(id) {
  if (!id) return null;
  try {
    return await api(`/strategies/${id}`); // includes legs + {state?}
  } catch {
    return null;
  }
}

/** Minimal meta for topbar */
export async function getMetaByIdAsync(id) {
  if (!id) return null;
  const s = await getAsync(id);
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    archived: !!(s.archived ?? s.isArchived),
    isArchived: !!(s.isArchived ?? s.archived),
    updatedAt: s.updatedAt,
    createdAt: s.createdAt,
  };
}

export async function createAsync(name = "Untitled Strategy", defaultLots = 1) {
  const r = await api(`/strategies`, {
    method: "POST",
    body: JSON.stringify({ name, defaultLots }),
  });
  // server also marks it as selected
  return r.id;
}

export async function setArchived(id, archived = true) {
  return api(`/strategies/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ archived }),
  });
}

/**
 * Save *preferences* on strategy (not legs).
 * Columns: defaultLots, atmBasis, selectedExpiry, underlying, realized?
 */
export async function saveState(id, prefs = {}) {
  if (!id) return;
  const payload = {};
  if (prefs.defaultLots != null) payload.defaultLots = Number(prefs.defaultLots) || 1;
  if (prefs.atmBasis) payload.atmBasis = String(prefs.atmBasis);
  if (prefs.selectedExpiry) payload.selectedExpiry = String(prefs.selectedExpiry);
  if (prefs.underlying) payload.underlying = String(prefs.underlying);
  if (typeof prefs.realized === "number") payload.realized = Number(prefs.realized);
  if (Object.keys(payload).length === 0) return;
  await api(`/strategies/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
}

/**
 * Load normalized state for the strategy.
 * Returns { liveLegs, stagedLegs, realized, defaultLots, atmBasis, underlying, selectedExpiry }
 */
export async function loadStateAsync(id) {
  if (!id) return null;

  const full = await getAsync(id);
  if (!full) return null;

  // Prefer server snapshot if present
  const s = full.state;
  if (s && (Array.isArray(s.liveLegs) || Array.isArray(s.stagedLegs))) {
    return {
      liveLegs: s.liveLegs || [],
      stagedLegs: s.stagedLegs || [],
      realized: Number(s.realized) || 0,
      defaultLots: Number(s.defaultLots) || 1,
      atmBasis: s.atmBasis || "spot",
      underlying: s.underlying || "NIFTY",
      selectedExpiry: s.selectedExpiry || null,
    };
  }

  // Otherwise derive from DB legs + top-level fields
  const dbLegs = Array.isArray(full.legs) ? full.legs : [];
  const normLeg = (l) => ({
    side: (l.side || "BUY").toUpperCase(),
    type: (l.type || "CE").toUpperCase(),
    strike: Number(l.strike) || 0,
    premium: Number(l.entryPrice ?? l.premium ?? 0),
    expiry: l.expiry || full.selectedExpiry || null,
    lots: Number(l.lots ?? 1),
    id: l.id,
  });
  const liveLegs = dbLegs.filter((l) => (l.status || "").toUpperCase() === "OPEN").map(normLeg);
  const stagedLegs = dbLegs.filter((l) => (l.status || "").toUpperCase() === "STAGED").map(normLeg);

  return {
    liveLegs,
    stagedLegs,
    realized: Number(full.realized ?? 0),
    defaultLots: Number(full.defaultLots ?? 1),
    atmBasis: full.atmBasis || "spot",
    underlying: full.underlying || "NIFTY",
    selectedExpiry: full.selectedExpiry || null,
  };
}

/* ---------------- legs (DB-backed) ---------------- */
export async function createLeg(strategyId, leg) {
  return api(`/legs`, {
    method: "POST",
    body: JSON.stringify({
      strategyId,
      side: String(leg.side || "BUY").toUpperCase(),
      type: String(leg.type || "CE").toUpperCase(),
      strike: Number(leg.strike) || 0,
      expiry: String(leg.expiry || ""),
      lots: Number(leg.lots) || 1,
      status: String(leg.status || "STAGED").toUpperCase(),
      premium: Number(leg.premium || 0),
    }),
  });
}

export async function updateLeg(legId, patch) {
  return api(`/legs/${legId}`, { method: "PATCH", body: JSON.stringify(patch || {}) });
}

export async function deleteLeg(legId) {
  return api(`/legs/${legId}`, { method: "DELETE" });
}

/* ---------------- legacy convenience ---------------- */
export function ensureDefault() { return null; }
