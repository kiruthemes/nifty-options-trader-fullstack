import { isAuthed, getToken } from './auth.js';

const META_KEY = "strategies.meta";
const CURR_KEY = "strategies.current";

export function getCurrentId() { return localStorage.getItem(CURR_KEY) || null; }
export function setCurrentId(id) { if (id) localStorage.setItem(CURR_KEY, String(id)); }

async function api(path, opts = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { ...opts, headers });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { errorText: text }; }
  if (!res.ok) throw new Error(data?.error || data?.message || data?.errorText || `HTTP ${res.status}`);
  return data;
}

/* ---------- Strategies ---------- */
export async function listAsync(includeArchived=false) {
  if (isAuthed()) {
    const list = await api(`/strategies?includeArchived=${includeArchived ? 1 : 0}`);
    try { localStorage.setItem(META_KEY, JSON.stringify(list)); } catch {}
    return list.map(s => ({ id: String(s.id), name: s.name, archived: !!s.archived, updatedAt: s.updatedAt }));
  }
  try { return JSON.parse(localStorage.getItem(META_KEY) || "[]"); } catch { return []; }
}

export async function createAsync(name='Untitled Strategy') {
  if (isAuthed()) {
    const r = await api(`/strategies`, { method:'POST', body: JSON.stringify({ name }) });
    const id = String(r.id);
    await listAsync(true);
    setCurrentId(id);
    window.dispatchEvent(new CustomEvent('strategy:selected', { detail: id }));
    return id;
  }
  // local fallback only if not authed
  const id = `local_${Date.now()}`;
  const m = await listAsync(true);
  m.unshift({ id, name, archived:false, updatedAt: new Date().toISOString() });
  localStorage.setItem(META_KEY, JSON.stringify(m));
  setCurrentId(id);
  window.dispatchEvent(new CustomEvent('strategy:selected', { detail: id }));
  return id;
}

export async function getAsync(id) {
  if (!id) id = getCurrentId();
  if (!id) return null;
  if (isAuthed()) return api(`/strategies/${id}`);
  const list = await listAsync(true);
  const meta = list.find(x => String(x.id) === String(id));
  return meta ? { id: meta.id, name: meta.name, legs: [] } : null;
}

export async function setArchived(id, archived=true) {
  if (isAuthed()) {
    await api(`/strategies/${id}`, { method:'PATCH', body: JSON.stringify({ archived }) });
    await listAsync(true);
    if (String(getCurrentId()) === String(id) && archived) {
      const next = (await listAsync(false))[0]?.id;
      if (next) {
        setCurrentId(String(next));
        window.dispatchEvent(new CustomEvent('strategy:selected', { detail: String(next) }));
      }
    }
    return;
  }
}

export async function updatePrefs(id, patch) {
  if (!id) id = getCurrentId();
  if (!id) return;
  if (isAuthed()) await api(`/strategies/${id}`, { method:'PATCH', body: JSON.stringify(patch || {}) });
}

/* ---------- Legs ---------- */
export async function listLegs(id) {
  if (!id) id = getCurrentId();
  if (!id) return [];
  if (isAuthed()) {
    const r = await api(`/legs?strategyId=${encodeURIComponent(id)}`);
    return Array.isArray(r?.legs) ? r.legs : [];
  }
  return []; // local mode: not persisted
}

export async function createLeg(id, leg) {
  if (!id) id = getCurrentId();
  if (!id) return null;
  if (isAuthed()) return api(`/legs`, { method:'POST', body: JSON.stringify({ ...leg, strategyId: id }) });
  return { ...leg, id: `local_${Date.now()}` };
}

export async function updateLeg(legId, patch) {
  if (!isAuthed()) return null;
  return api(`/legs/${legId}`, { method:'PATCH', body: JSON.stringify(patch || {}) });
}

export async function deleteLeg(legId) {
  if (!isAuthed()) return null;
  return api(`/legs/${legId}`, { method:'DELETE' });
}

/* ---------- Legacy state helpers (Dashboard expects these) ---------- */
export async function loadStateAsync(id) {
  if (!id) id = getCurrentId();
  if (!id) return null;
  const full = await getAsync(id);
  // Normalize to legacy blob
  const legs = Array.isArray(full?.legs) ? full.legs : [];
  const liveLegs = legs.filter(l => (l.status || "").toUpperCase() === "OPEN");
  const stagedLegs = legs.filter(l => (l.status || "").toUpperCase() === "STAGED");
  return {
    liveLegs: liveLegs.map(mapLeg),
    stagedLegs: stagedLegs.map(mapLeg),
    realized: Number(full?.realized || 0),
    defaultLots: Number(full?.defaultLots || 1),
    atmBasis: full?.atmBasis || "spot",
    underlying: full?.underlying || "NIFTY",
    selectedExpiry: full?.selectedExpiry || null,
  };
}

export async function saveState(id, state) {
  // no-op: we persist via legs & strategy prefs now
  if (!id) id = getCurrentId();
  if (!id) return;
  await updatePrefs(id, {
    defaultLots: state?.defaultLots,
    atmBasis: state?.atmBasis,
    selectedExpiry: state?.selectedExpiry,
    underlying: state?.underlying,
  });
}

function mapLeg(l) {
  return {
    id: l.id,
    side: l.side,
    type: l.type,
    strike: Number(l.strike) || 0,
    premium: Number(l.entryPrice ?? l.premium ?? 0),
    lots: Number(l.lots || 1),
    expiry: l.expiry,
  };
}
