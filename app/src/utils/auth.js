// app/src/utils/auth.js
// Production-safe local persistence + simple event bus for auth state.

const API = import.meta.env.VITE_API_BASE || "";
const TOKEN_KEY = "auth.token";
const USER_KEY  = "auth.user";
const EVT       = "auth:change";

/* ----------------- storage helpers ----------------- */
function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, val) {
  try { localStorage.setItem(key, val); } catch {}
}
function safeDel(key) {
  try { localStorage.removeItem(key); } catch {}
}

/* ----------------- public getters ----------------- */
export function getToken() {
  return safeGet(TOKEN_KEY);
}
export function isAuthed() {
  return !!getToken();
}
export function getUser() {
  const raw = safeGet(USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/* ----------------- event bus ----------------- */
function emitAuthChange(payload) {
  window.dispatchEvent(new CustomEvent(EVT, { detail: payload }));
}
export function onAuthChange(cb) {
  function handler(e) { cb(e.detail || { authed: false, user: null }); }
  window.addEventListener(EVT, handler);
  return () => window.removeEventListener(EVT, handler);
}

/* ----------------- state mutators ----------------- */
function setAuth({ token, user }) {
  if (token) safeSet(TOKEN_KEY, token);
  if (user)  safeSet(USER_KEY, JSON.stringify(user));
  emitAuthChange({ authed: true, user });
}
export function clearAuth() {
  safeDel(TOKEN_KEY);
  safeDel(USER_KEY);
  emitAuthChange({ authed: false, user: null });
}
export function logout() {
  clearAuth();
}

/* ----------------- internal HTTP helpers ----------------- */
function authHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body || {}),
  });
  const txt = await res.text().catch(() => "");
  let data = {};
  try { data = txt ? JSON.parse(txt) : {}; } catch {}
  if (!res.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  }
  return data;
}

/* ----------------- public API ----------------- */
export async function login(email, password) {
  const data = await post("/api/auth/login", { email, password });
  if (!data?.token) throw new Error("No token returned");
  setAuth({ token: data.token, user: data.user || { email } });
  return getUser();
}
export async function register(email, password, name) {
  const data = await post("/api/auth/register", { email, password, name });
  if (!data?.token) throw new Error("No token returned");
  setAuth({ token: data.token, user: data.user || { email, name } });
  return getUser();
}

/**
 * Fetch current user from server if /api/auth/me exists.
 * - 200: updates user + emits authed:true
 * - 401: clears auth (token invalid/expired)
 * - 404: endpoint not implemented -> keep local user; do NOT sign out
 * - network error: ignore (return null); do NOT sign out
 */
export async function fetchMe({ tolerate404 = true } = {}) {
  try {
    const res = await fetch(`${API}/api/auth/me`, { headers: { ...authHeaders() } });

    if (res.status === 404 && tolerate404) {
      const u = getUser();
      emitAuthChange({ authed: !!getToken(), user: u });
      return u;
    }
    if (res.status === 401) {
      clearAuth();
      throw new Error("Unauthorized");
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const me = await res.json().catch(() => null);
    if (me) safeSet(USER_KEY, JSON.stringify(me));
    emitAuthChange({ authed: true, user: me });
    return me;
  } catch {
    return null;
  }
}

/**
 * Convenience: validate session on app start.
 * Returns { authed:boolean, user:any|null }
 */
export async function validateSession() {
  if (!isAuthed()) {
    clearAuth();
    return { authed: false, user: null };
  }
  const me = await fetchMe({ tolerate404: true });
  const authed = !!getToken();
  return { authed, user: me || getUser() };
}
