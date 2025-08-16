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
export async function getProvider() {
  try {
    const r = await fetch(`${API}/api/market/provider`, {
      method: "GET",
      headers: { ...authHeaders() },
    });
    const data = await j(r);
    return data.provider || "dhan";
  } catch {
    return "dhan";
  }
}

export async function setProvider(provider) {
  const r = await fetch(`${API}/api/market/provider`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ provider }),
  });
  return j(r);
}

// ---- expiries ----
export async function getExpiries(symbol = "NIFTY") {
  const q = `symbol=${encodeURIComponent(symbol)}`;
  const r = await fetch(`${API}/api/market/expiries?${q}`, {
    headers: { ...authHeaders() },
  });
  return j(r); // { provider, expiries: [] }
}

// ---- option chain ----
export async function fetchOptionChain(symbol, expiry, opts = {}) {
  const params = new URLSearchParams({ symbol, expiry });
  if (opts.cached) params.set("cached", "1");
  const r = await fetch(`${API}/api/market/option-chain?${params.toString()}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return j(r); // { provider, rows, lastPrice?, source }
}

// ---- trading (unchanged) ----
export async function placeOrdersForStrategy(strategyId, orders) {
  const r = await fetch(`${API}/api/strategies/${strategyId}/place-orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ orders }),
  });
  return j(r);
}

// ---- orders list + retry ----
export async function listStrategyOrders(strategyId) {
  const r = await fetch(`${API}/api/strategies/${strategyId}/orders`, {
    headers: { ...authHeaders() },
  });
  return j(r); // { items: [...] }
}

export async function retryOrder(orderId) {
  const r = await fetch(`${API}/api/orders/${orderId}/retry`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  return j(r);
}

// ---- brokers (unchanged) ----
export async function listBrokerAccounts() {
  const r = await fetch(`${API}/api/brokers`, { headers: { ...authHeaders() } });
  return j(r);
}
export async function createBrokerAccount(payload) {
  const r = await fetch(`${API}/api/brokers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload || {}),
  });
  return j(r);
}
export async function listStrategyBrokers(strategyId) {
  const r = await fetch(`${API}/api/brokers/strategy/${strategyId}`, {
    headers: { ...authHeaders() },
  });
  return j(r);
}
export async function linkBrokerToStrategy(strategyId, brokerAccountId) {
  const r = await fetch(`${API}/api/brokers/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ strategyId, brokerAccountId }),
  });
  return j(r);
}
export async function unlinkBrokerFromStrategy(strategyId, brokerAccountId) {
  const r = await fetch(`${API}/api/brokers/unlink`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ strategyId, brokerAccountId }),
  });
  return j(r);
}
export async function getLastStrategyId() {
  const r = await fetch(`${API}/api/strategies/last`, { headers: { ...authHeaders() } });
  const data = await j(r);
  return data?.id ?? null;
}
export async function selectStrategy(id) {
  const r = await fetch(`${API}/api/strategies/${id}/select`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  return j(r);
}
