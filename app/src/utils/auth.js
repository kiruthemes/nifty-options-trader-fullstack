// app/src/utils/auth.js
const TOKEN_KEY = "auth.token";
const USER_KEY = "auth.user";

// ---- storage helpers ----
export function setAuth(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user || {}));
}
export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || null;
}
export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "{}");
  } catch {
    return {};
  }
}
export function isAuthed() {
  return !!getToken();
}
export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

// ---- fetch helpers (robust JSON parsing) ----
async function readJsonSafe(res) {
  // Try JSON by header first
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      // fallthrough to text
    }
  }
  // Fallback to text (could be empty, HTML, etc.)
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { errorText: text }; // not JSON, but at least return something
  }
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await readJsonSafe(res);
  if (!res.ok) {
    // prefer structured error fields, fall back to raw text or status
    const msg =
      data?.error ||
      data?.message ||
      data?.errorText ||
      `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// ---- API: login / register ----
export async function login(email, password) {
  const data = await postJson("/api/auth/login", { email, password });
  if (!data?.token || !data?.user) {
    throw new Error("Malformed response from server");
  }
  setAuth(data.token, data.user);
  return data.user;
}

export async function register(email, password, name) {
  const data = await postJson("/api/auth/register", { email, password, name });
  if (!data?.token || !data?.user) {
    throw new Error("Malformed response from server");
  }
  setAuth(data.token, data.user);
  return data.user;
}
