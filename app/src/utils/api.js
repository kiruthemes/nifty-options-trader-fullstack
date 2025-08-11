// app/src/utils/api.js
import { getToken } from "./auth.js";

const API = import.meta.env.VITE_API_BASE || "";

// ---- internal fetch helpers ----
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

// ---- provider (per-user) ----
// GET /api/providers/current  -> { provider }
export async function getProvider() {
  try {
    const r = await fetch(`${API}/api/providers/current`, {
      method: "GET",
      headers: { ...authHeaders() },
    });
    const data = await j(r);
    return data.provider || "synthetic";
  } catch {
    // fall back gracefully if not authed or endpoint fails
    return "synthetic";
  }
}

// PATCH /api/providers/current  { provider }
export async function setProvider(provider) {
  const r = await fetch(`${API}/api/providers/current`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ provider }),
  });
  return j(r);
}

// ---- market data (option chain) ----
export async function fetchOptionChain(symbol, expiry) {
  const q = `symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiry)}`;
  const r = await fetch(`${API}/api/market/option-chain?${q}`, {
    method: "GET",
    headers: { ...authHeaders() }, // ok if unauth; server will ignore
  });
  return j(r); // { rows: [...] }
}

// ---- trading (fanout to linked brokers) ----
export async function placeOrdersForStrategy(strategyId, orders) {
  const r = await fetch(`${API}/api/strategies/${strategyId}/place-orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ orders }),
  });
  return j(r); // { results: [...] }
}

// ---- brokers (accounts owned by user) ----
export async function listBrokerAccounts() {
  const r = await fetch(`${API}/api/brokers`, {
    headers: { ...authHeaders() },
  });
  return j(r);
}

export async function createBrokerAccount(payload) {
  const r = await fetch(`${API}/api/brokers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload || {}),
  });
  return j(r); // { id }
}

// List linked brokers for a strategy (read)
export async function listStrategyBrokers(strategyId) {
  // you can also use GET /api/strategies/:id/brokers — this one matches your current UI
  const r = await fetch(`${API}/api/brokers/strategy/${strategyId}`, {
    headers: { ...authHeaders() },
  });
  return j(r); // [{ id, brokerAccountId, provider, label, enabled }]
}

// Link/unlink brokers to a strategy (write)
export async function linkBrokerToStrategy(strategyId, brokerAccountId) {
  const r = await fetch(`${API}/api/brokers/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ strategyId, brokerAccountId }),
  });
  return j(r); // { ok: true }
}

export async function unlinkBrokerFromStrategy(strategyId, brokerAccountId) {
  const r = await fetch(`${API}/api/brokers/unlink`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ strategyId, brokerAccountId }),
  });
  return j(r); // { ok: true }
}

// ---- strategy selection helpers (for last-opened) ----
export async function getLastStrategyId() {
  const r = await fetch(`${API}/api/strategies/last`, {
    headers: { ...authHeaders() },
  });
  const data = await j(r); // { id: number | null }
  return data?.id ?? null;
}

export async function selectStrategy(id) {
  const r = await fetch(`${API}/api/strategies/${id}/select`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  return j(r); // { ok: true }
}
