// server/src/services/dataFeed.ts
import fs from "fs";
import path from "path";
import { Server } from "socket.io";
import { MarketAdapter, Provider, OptionChainRow } from "../adapters/types";
import { DhanMarket } from "../adapters/dhan";
import * as Dhan from "../adapters/dhan";
import { KiteMarket } from "../adapters/zerodha";
import { loadDhanInstrumentMaps } from "../lib/dhanInstruments";

const inflight = new Map<string, Promise<OCData>>();

/* ---------------- providers ---------------- */
type State = { provider: Provider; adapter: MarketAdapter };

const INSTR_CSV =
  process.env.DHAN_INSTRUMENTS_CSV ||
  "server/data/dhan_instruments.csv"; // keep this default; override with env for custom path

// lazy singleton maps from CSV
let _maps: ReturnType<typeof loadDhanInstrumentMaps> | null = null;
function maps() {
  if (!_maps) _maps = loadDhanInstrumentMaps(INSTR_CSV);
  return _maps!;
}

const providers: Record<Provider, MarketAdapter> = {
  synthetic: { name: "synthetic", getOptionChain: async () => [] },
  dhan: DhanMarket,
  kite: KiteMarket,
};

const state: State = {
  provider: (process.env.DATA_SOURCE as Provider) || "synthetic",
  adapter: providers[(process.env.DATA_SOURCE as Provider) || "synthetic"],
};

const DBG = process.env.DEBUG_DATAFEED === "1";

/* ---------------- market clock (IST) ---------------- */
function nowIST() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const istMs = utcMs + 5.5 * 60 * 60000; // UTC+5:30
  return new Date(istMs);
}
function isWeekdayIST(d = nowIST()) {
  const day = d.getDay(); // 0 Sun .. 6 Sat
  return day >= 1 && day <= 5;
}
const OPEN_MIN = 9 * 60 + 15; // 09:15
const CLOSE_MIN = 15 * 60 + 30; // 15:30
function minutesIST(d = nowIST()) {
  return d.getHours() * 60 + d.getMinutes();
}
function isMarketOpenIST(d = nowIST()) {
  if (!isWeekdayIST(d)) return false;
  const m = minutesIST(d);
  return m >= OPEN_MIN && m <= CLOSE_MIN;
}
function msUntilNextOpenIST(d = nowIST()) {
  const base = new Date(d);
  let day = base.getDay();
  let addDays = 0;
  if (isMarketOpenIST(d)) return 0;
  if (day === 6) addDays = 2; // Sat -> Mon
  else if (day === 0) addDays = 1; // Sun -> Mon
  else if (minutesIST(d) > CLOSE_MIN) addDays = 1; // after close -> next day
  const next = new Date(base);
  next.setDate(base.getDate() + addDays);
  next.setHours(9, 15, 0, 0);
  while (!isWeekdayIST(next)) next.setDate(next.getDate() + 1);
  return next.getTime() - d.getTime();
}
// yyyy-mm-dd (IST)
function isoDateIST(d = nowIST()) {
  const dd = new Date(d);
  dd.setHours(0, 0, 0, 0);
  return dd.toISOString().slice(0, 10);
}

/* ---------------- helpers ---------------- */
function isIndexSymbol(sym: string) {
  const s = (sym || "").toUpperCase();
  return s === "NIFTY" || s === "BANKNIFTY";
}
// naive instrument inference (good for index F&O)
function inferInstrument(meta: {
  isIndex?: boolean;
  optType?: "CE" | "PE";
  isFut?: boolean;
}) {
  if (meta.isIndex) return "INDEX";
  if (meta.optType) return "OPTIDX";
  if (meta.isFut) return "FUTIDX";
  return "EQUITY";
}

// tiny concurrency pool
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0,
    active = 0;
  return new Promise((resolve) => {
    const kick = () => {
      while (active < limit && i < items.length) {
        const idx = i++,
          item = items[idx];
        active++;
        Promise.resolve(worker(item, idx))
          .then((r) => {
            out[idx] = r as any;
          })
          .catch(() => {
            out[idx] = undefined as any;
          })
          .finally(() => {
            active--;
            if (i < items.length) kick();
            else if (active === 0) resolve(out);
          });
      }
    };
    kick();
  });
}

/* ---------------- file store (OC) ---------------- */
const STORE_DIR = process.env.OC_STORE_DIR || "server/.cache/optionchain";
function ensureStoreDir() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  } catch {}
}
function safeName(s: string) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, "_");
}
function storePath(provider: Provider, symbol: string, expiry: string) {
  ensureStoreDir();
  return path.resolve(
    STORE_DIR,
    `${safeName(provider)}_${safeName(symbol)}_${safeName(expiry)}.json`
  );
}

export type OCData = {
  rows: OptionChainRow[];
  lastPrice?: number; // index last price from /optionchain
  futClose?: number; // nearest futures daily close (after-hours fallback)
  ltpTs?: number; // last time LTP/IV refreshed
  oiTs?: number; // last time OI refreshed
  source?: "fresh" | "cache" | "store";
};

function loadFromStore(symbol: string, expiry: string): OCData | null {
  try {
    const p = storePath(state.provider, symbol, expiry);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const obj = JSON.parse(raw);
    if (Array.isArray(obj?.rows)) {
      return { ...obj, source: "store" };
    }
  } catch (e) {
    if (DBG)
      console.warn("[DATA] load store failed:", (e as any)?.message || e);
  }
  return null;
}
function saveToStore(symbol: string, expiry: string, data: OCData) {
  try {
    const p = storePath(state.provider, symbol, expiry);
    const payload = {
      ...data,
      savedAt: Date.now(),
      provider: state.provider,
      symbol,
      expiry,
    };
    fs.writeFileSync(p, JSON.stringify(payload));
  } catch (e) {
    if (DBG)
      console.warn("[DATA] save store failed:", (e as any)?.message || e);
  }
}

/* ---------------- FUT store (per-symbol close) ---------------- */

const FUT_STORE_DIR =
  process.env.FUT_STORE_DIR || "server/.cache/fut_close"; // one file per symbol
function ensureFutDir() {
  try {
    fs.mkdirSync(FUT_STORE_DIR, { recursive: true });
  } catch {}
}
function futStorePath(symbol: string) {
  ensureFutDir();
  return path.resolve(FUT_STORE_DIR, `${safeName(symbol.toUpperCase())}.json`);
}
function loadFutStore(symbol: string): { value: number; at: number } | null {
  try {
    const p = futStorePath(symbol);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const obj = JSON.parse(raw);
    if (Number.isFinite(obj?.value)) return { value: Number(obj.value), at: Number(obj.at || 0) };
  } catch {}
  return null;
}
function saveFutStore(symbol: string, value: number) {
  try {
    const p = futStorePath(symbol);
    fs.writeFileSync(p, JSON.stringify({ value, at: Date.now() }));
  } catch {}
}
/** Best-effort futures close: FUT store → historic API (and persist) */
async function getBestFutClose(symbol: string): Promise<number | undefined> {
  const sym = symbol.toUpperCase();
  const fromStore = loadFutStore(sym);
  if (fromStore?.value != null && Number.isFinite(fromStore.value)) {
    return fromStore.value;
  }
  const fromHist = await getHistoricalFutClose(sym).catch(() => undefined);
  if (Number.isFinite(Number(fromHist))) {
    saveFutStore(sym, Number(fromHist));
    return Number(fromHist);
  }
  return undefined;
}

/* ---------------- historical fallbacks ---------------- */

/** fetch nearest futures daily close (for UI ATM=futures after-hours) */
async function getHistoricalFutClose(
  symbol: string
): Promise<number | undefined> {
  try {
    const m = maps();
    const sym = (symbol || "NIFTY").toUpperCase();
    const futSecId = m.idxFut.get(sym);
    if (DBG)
      console.log(
        `[DATA][HIST] futClose: sym=${sym} futSecId=${futSecId ?? "-"}`
      );
    if (!futSecId) return;

    const instrument = isIndexSymbol(sym) ? "FUTIDX" : "FUTSTK";
    const date = isoDateIST();
    if (DBG)
      console.log(
        `[DATA][HIST] calling getHistoricalLastClose secId=${futSecId} instr=${instrument} date=${date}`
      );

    const r = await Dhan.getHistoricalLastClose({
      securityId: futSecId,
      exchangeSegment: "NSE_FNO",
      instrument,
      date,
      withOi: false,
    });
    const c = Number(r?.close);
    if (DBG) console.log(`[DATA][HIST] futClose result: ${sym} close=${c}`);
    return Number.isFinite(c) ? c : undefined;
  } catch (e: any) {
    if (DBG) console.warn("[DATA][HIST] futClose error:", e?.message || e);
    return undefined;
  }
}

/**
 * Build OC snapshot from historical daily close for the given (symbol, expiry).
 * Only used after-hours on cold start or when /optionchain is unavailable.
 */
async function seedFromHistorical(
  symbol: string,
  expiry: string
): Promise<OCData | null> {
  if (state.provider !== "dhan") return null; // only implemented for Dhan
  const m = maps();
  const key = `${symbol.toUpperCase()}|${expiry}`;
  const secIds = m.chainIndex.get(key) || [];
  if (!secIds.length) {
    if (DBG) console.warn("[DATA] hist seed: no secIds for", key);
    return null;
  }

  const date = isoDateIST();
  if (DBG)
    console.log(
      `[DATA][HIST] seedFromHistorical start ${symbol}|${expiry} secIds=${secIds.length}`
    );

  // fetch last close (and OI) for each securityId with gentle concurrency
  const results = await mapConcurrent(
    secIds,
    Number(process.env.HIST_CONCURRENCY || 5),
    async (secId) => {
      const meta = m.bySecId.get(secId);
      if (!meta) return null;
      const instrument = inferInstrument(meta);
      try {
        const r = await Dhan.getHistoricalLastClose({
          securityId: secId,
          exchangeSegment: meta.exch,
          instrument,
          date,
          withOi: true,
        });
        return { meta, close: r?.close, oi: r?.oi };
      } catch {
        return null;
      }
    }
  );

  // group by strike; fold CE/PE into rows
  const byStrike = new Map<number, OptionChainRow>();
  for (const r of results) {
    if (!r || !r.meta || !Number.isFinite(r.meta.strike as any)) continue;
    const s = Number(r.meta.strike);
    const row =
      byStrike.get(s) || { strike: s, callLtp: 0, putLtp: 0, callOi: 0, putOi: 0, iv: 0 };
    if (r.meta.optType === "CE") {
      if (Number.isFinite(r.close as any)) row.callLtp = Number(r.close);
      if (Number.isFinite(r.oi as any)) row.callOi = Number(r.oi);
    } else if (r.meta.optType === "PE") {
      if (Number.isFinite(r.close as any)) row.putLtp = Number(r.close);
      if (Number.isFinite(r.oi as any)) row.putOi = Number(r.oi);
    }
    byStrike.set(s, row);
  }

  const rows = Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
  if (!rows.length) return null;

  const data: OCData = {
    rows,
    lastPrice: undefined,
    futClose: await getBestFutClose(symbol).catch(() => undefined),
    ltpTs: Date.now(),
    oiTs: Date.now(),
    source: "fresh",
  };

  const keyCache = cacheKey(symbol, expiry);
  ocCache.set(keyCache, { ts: Date.now(), data });
  saveToStore(symbol, expiry, data);

  if (DBG)
    console.log(
      `[DATA][HIST] seedFromHistorical done ${symbol}|${expiry} rows=${rows.length} futClose=${data.futClose ?? "-"}`
    );
  return data;
}

/* ---------------- provider access ---------------- */
export function getProvider(): Provider {
  return state.provider;
}
export function setProvider(p: Provider) {
  if (!providers[p]) return;
  state.provider = p;
  state.adapter = providers[p];
  if (DBG) console.log(`[DATA] provider set -> ${p}`);
  stopAllWorkers();
  ocCache.clear();
}

/* ---------------- cache + workers ---------------- */
type CacheEntry = { ts: number; data?: OCData };
const ocCache = new Map<string, CacheEntry>();

type Worker = {
  timer?: NodeJS.Timeout;
  backoffUntil?: number;
};
const workers = new Map<string, Worker>();

function cacheKey(symbol: string, expiry: string) {
  return `${state.provider}|${symbol}|${expiry}`;
}

const IV_MS = Number(process.env.OC_IV_MS || 3 * 60_000); // 3 min
const OI_MS = Number(process.env.OC_OI_MS || 5 * 60_000); // 5 min
const BACKOFF_MS = Number(process.env.OC_BACKOFF_MS || 60_000); // 1 min
const CLOSED_POLL = Number(process.env.OC_CLOSED_POLL || 15 * 60_000); // refresh store view every 15 min (no REST)

/**
 * Start / keep a lightweight scheduler per (symbol, expiry).
 * - During market hours: REST fetch every 3 min; merge OI only if 5 min elapsed.
 * - On 429: back off and try later.
 * - During closed hours: no REST; rely on store; schedule wake-up at next open.
 */
function ensureWorker(symbol: string, expiry: string) {
  if (workers.has(cacheKey(symbol, expiry))) return;

  const key = cacheKey(symbol, expiry);
  const w: Worker = {};

  const schedule = (ms: number) => {
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(loop, Math.max(0, ms | 0));
  };

  const loop = async () => {
    if (w.backoffUntil && Date.now() < w.backoffUntil) {
      schedule(w.backoffUntil - Date.now());
      return;
    }

    if (!isMarketOpenIST()) {
      const entry = ocCache.get(key);
      if (!entry?.data) {
        const store = loadFromStore(symbol, expiry);
        if (store) ocCache.set(key, { ts: Date.now(), data: store });
      }
      const wait = msUntilNextOpenIST();
      schedule(Math.min(Math.max(wait, 60_000), CLOSED_POLL));
      if (DBG)
        console.log(
          `[DATA] market closed; worker idle ${key} (sleep ${Math.round(wait / 1000)}s)`
        );
      return;
    }

    try {
      const now = Date.now();
      const entry = ocCache.get(key);
      const have = entry?.data;
      const needOi = !have?.oiTs || now - (have.oiTs || 0) >= OI_MS;

      let rows: OptionChainRow[] = [];
      let lastPrice: number | undefined = undefined;

      if (state.provider === "dhan") {
        const raw = await Dhan.getOptionChainRaw(symbol, expiry);
        rows = raw.rows || [];
        lastPrice = raw.lastPrice;
      } else {
        rows = await state.adapter.getOptionChain(symbol, expiry);
      }

      const merged: OptionChainRow[] = [];
      const priorByStrike = new Map<number, OptionChainRow>(
        (have?.rows || []).map((r) => [Number(r.strike), r])
      );
      for (const r of rows) {
        const k = Number(r.strike);
        const prev = priorByStrike.get(k);
        merged.push({
          strike: k,
          callLtp: r.callLtp,
          putLtp: r.putLtp,
          iv: r.iv,
          callOi: needOi ? r.callOi : prev?.callOi ?? r.callOi,
          putOi: needOi ? r.putOi : prev?.putOi ?? r.putOi,
        } as OptionChainRow);
      }
      merged.sort((a, b) => a.strike - b.strike);

      const next: OCData = {
        rows: merged,
        lastPrice,
        futClose: have?.futClose, // keep existing futClose; we fill/refresh after hours outside the worker
        ltpTs: now,
        oiTs: needOi ? now : have?.oiTs ?? now,
        source: "fresh",
      };

      ocCache.set(key, { ts: now, data: next });
      saveToStore(symbol, expiry, next);

      if (DBG) {
        console.log(
          `[DATA] refresh ok ${key} rows=${merged.length} ${needOi ? "(LTP+IV+OI)" : "(LTP+IV)"}`
        );
      }

      schedule(IV_MS);
    } catch (err: any) {
      const msg = String(err?.message || err || "");
      if (DBG) console.warn(`[DATA] refresh error ${key}: ${msg}`);
      if (/429|Too many/i.test(msg)) {
        w.backoffUntil = Date.now() + BACKOFF_MS;
      }
      schedule(w.backoffUntil ? BACKOFF_MS : IV_MS);
    }
  };

  workers.set(key, w);
  schedule(0);
}

function stopAllWorkers() {
  for (const [, w] of workers) {
    if (w.timer) clearTimeout(w.timer);
  }
  workers.clear();
}

/* ---------------- public API ---------------- */

/** Quick peek of the latest in-memory (or store) without forcing a refresh. */
export function getCachedOptionChain(symbol: string, expiry: string): OCData {
  const key = cacheKey(symbol, expiry);
  const entry = ocCache.get(key);
  if (entry?.data) return { ...entry.data, source: "cache" };
  const store = loadFromStore(symbol, expiry);
  if (store) return store;
  return { rows: [], source: "cache" };
}

/** Ensure a worker is running and return the latest snapshot (may be from cache/store). */
export async function fetchOptionChain(
  symbol: string,
  expiry: string
): Promise<OCData> {
  const key = cacheKey(symbol, expiry);

  ensureWorker(symbol, expiry);

  // ⚠️ Important: if we already have a cached snapshot and market is CLOSED, top-up futClose before returning.
  const cached = ocCache.get(key)?.data;
  if (cached) {
    if (!isMarketOpenIST() && !Number.isFinite(Number(cached.futClose))) {
      const fc = await getBestFutClose(symbol).catch(() => undefined);
      if (Number.isFinite(Number(fc))) {
        const enriched = { ...cached, futClose: Number(fc) };
        ocCache.set(key, { ts: Date.now(), data: enriched });
        saveToStore(symbol, expiry, enriched);
        return { ...enriched, source: "cache" };
      }
    }
    return { ...cached, source: "cache" };
  }

  const store = loadFromStore(symbol, expiry);
  if (!isMarketOpenIST()) {
    // try store first; add futClose if missing
    if (store) {
      if (!Number.isFinite(Number(store.futClose))) {
        if (DBG)
          console.log(`[DATA][HIST] store has no futClose; fetching for ${symbol}`);
        const fc = await getBestFutClose(symbol).catch(() => undefined);
        if (Number.isFinite(Number(fc))) {
          store.futClose = Number(fc);
          saveToStore(symbol, expiry, store);
          ocCache.set(key, { ts: Date.now(), data: store });
          if (DBG)
            console.log(
              `[DATA][HIST] added futClose=${store.futClose} to store ${symbol}|${expiry}`
            );
        } else if (DBG) {
          console.log(`[DATA][HIST] futClose not available for ${symbol}`);
        }
      } else {
        // mirror store to memory for subsequent requests
        ocCache.set(key, { ts: Date.now(), data: store });
      }
      return store;
    }

    // no store → try single-shot /optionchain (cheap + entire chain) to seed
    if (state.provider === "dhan") {
      try {
        const now = Date.now();
        const raw = await Dhan.getOptionChainRaw(symbol, expiry);
        const data: OCData = {
          rows: raw.rows || [],
          lastPrice: raw.lastPrice,
          futClose: await getBestFutClose(symbol).catch(() => undefined),
          ltpTs: now,
          oiTs: now,
          source: "fresh",
        };
        ocCache.set(key, { ts: now, data });
        saveToStore(symbol, expiry, data);
        if (DBG)
          console.log(
            `[DATA][HIST] after-hours /optionchain seeded ${symbol}|${expiry} futClose=${data.futClose ?? "-"}`
          );
        return data;
      } catch {
        const seeded = await seedFromHistorical(symbol, expiry);
        if (seeded) return seeded;
      }
    }

    return { rows: [], source: "store" };
  }

  // market open seeding (also 429 aware): dedupe concurrent first hit
  if (inflight.has(key)) return inflight.get(key)!;
  const p = (async () => {
    try {
      const now = Date.now();
      if (state.provider === "dhan") {
        const raw = await Dhan.getOptionChainRaw(symbol, expiry);
        const data: OCData = {
          rows: raw.rows || [],
          lastPrice: raw.lastPrice,
          futClose: undefined,
          ltpTs: now,
          oiTs: now,
          source: "fresh",
        };
        ocCache.set(key, { ts: now, data });
        saveToStore(symbol, expiry, data);
        return data;
      } else {
        const rows = await state.adapter.getOptionChain(symbol, expiry);
        const data: OCData = {
          rows,
          ltpTs: now,
          oiTs: now,
          source: "fresh",
        };
        ocCache.set(key, { ts: now, data });
        saveToStore(symbol, expiry, data);
        return data;
      }
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function wireTicks(_io: Server) {
  // Reserved for emitting server-pushed deltas if needed
}

/* ==================== PREWARMERS / DAILY CAPTURE ==================== */

const SNAPSHOT_HHMM_IST = process.env.OC_SNAPSHOT_HHMM_IST || "15:20";
const SNAPSHOT_THROTTLE_MS = Number(
  process.env.OC_SNAPSHOT_THROTTLE_MS || 1500
);
const SNAPSHOT_MAX = Number(process.env.OC_SNAPSHOT_MAX || 0); // 0 = all

function hhmmToTodayIST(hhmm: string) {
  const [hh, mm] = (hhmm || "15:20").split(":").map((n) => Number(n));
  const d = nowIST();
  d.setHours(hh || 15, mm || 20, 0, 0);
  return d;
}
function msUntilNextHHMMIST(hhmm: string) {
  const target = hhmmToTodayIST(hhmm);
  const now = nowIST();
  let next = target;
  if (now.getTime() >= target.getTime()) {
    next = new Date(target);
    next.setDate(target.getDate() + 1);
  }
  while (!isWeekdayIST(next)) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listExpiries(symbol: string): Promise<string[]> {
  if (state.provider === "dhan") {
    try {
      const list = await Dhan.getExpiries(symbol.toUpperCase());
      if (SNAPSHOT_MAX > 0) return list.slice(0, SNAPSHOT_MAX);
      return list;
    } catch (e) {
      if (DBG)
        console.warn("[DATA] getExpiries failed:", (e as any)?.message || e);
      return [];
    }
  }
  return [];
}

/**
 * Snapshot every expiry for a symbol and persist to file store.
 * Throttled & 429-aware. Does not spin up per-expiry workers.
 */
export async function snapshotAllExpiries(
  symbol: string,
  opts?: { throttleMs?: number }
) {
  const throttleMs = Math.max(250, Number(opts?.throttleMs ?? SNAPSHOT_THROTTLE_MS));
  const sym = symbol.toUpperCase();
  const expiries = await listExpiries(sym);
  if (!expiries.length) {
    if (DBG) console.warn(`[DATA] snapshot: no expiries for ${sym}`);
    return;
  }

  if (DBG)
    console.log(
      `[DATA] snapshot starting for ${sym} (${expiries.length} expiries)`
    );

  for (const expiry of expiries) {
    const key = cacheKey(sym, expiry);
    try {
      let rows: OptionChainRow[] = [];
      let lastPrice: number | undefined = undefined;

      if (state.provider === "dhan") {
        const raw = await Dhan.getOptionChainRaw(sym, expiry);
        rows = raw.rows || [];
        lastPrice = raw.lastPrice;
      } else {
        rows = await state.adapter.getOptionChain(sym, expiry);
      }

      const now = Date.now();
      const data: OCData = {
        rows,
        lastPrice,
        futClose: undefined,
        ltpTs: now,
        oiTs: now,
        source: "fresh",
      };

      saveToStore(sym, expiry, data);
      ocCache.set(key, { ts: now, data });

      if (DBG) console.log(`[DATA] snapshot ok ${key} rows=${rows.length}`);
      await sleep(throttleMs);
    } catch (e: any) {
      const msg = String(e?.message || e || "");
      if (/429|Too many/i.test(msg)) {
        if (DBG)
          console.warn(
            `[DATA] snapshot 429 for ${key}; backing off ${Math.round(
              BACKOFF_MS / 1000
            )}s`
          );
        await sleep(BACKOFF_MS);
        try {
          let rows: OptionChainRow[] = [];
          let lastPrice: number | undefined = undefined;
          if (state.provider === "dhan") {
            const raw = await Dhan.getOptionChainRaw(sym, expiry);
            rows = raw.rows || [];
            lastPrice = raw.lastPrice;
          } else {
            rows = await state.adapter.getOptionChain(sym, expiry);
          }
          const now = Date.now();
          const data: OCData = {
            rows,
            lastPrice,
            futClose: undefined,
            ltpTs: now,
            oiTs: now,
            source: "fresh",
          };
          saveToStore(sym, expiry, data);
          ocCache.set(key, { ts: now, data });
          if (DBG) console.log(`[DATA] snapshot retry ok ${key} rows=${rows.length}`);
        } catch (ee: any) {
          if (DBG)
            console.warn(
              `[DATA] snapshot retry failed ${key}:`,
              String(ee?.message || ee || "")
            );
        }
      } else {
        if (DBG) console.warn(`[DATA] snapshot failed ${key}:`, msg);
      }
      await sleep(throttleMs);
    }
  }

  if (DBG) console.log(`[DATA] snapshot finished for ${sym}`);
}

/**
 * Daily FUT close capture (persists to FUT store so FE always has a number after hours).
 * Default at 15:25 IST (a few mins after close).
 */
const FUTCLOSE_HHMM_IST = process.env.FUTCLOSE_HHMM_IST || "15:25";
export function startDailyFutCloseCapture(symbol: string) {
  const sym = symbol.toUpperCase();

  const scheduleNext = () => {
    const ms = msUntilNextHHMMIST(FUTCLOSE_HHMM_IST);
    if (DBG)
      console.log(
        `[DATA] next futClose capture for ${sym} in ~${Math.round(ms / 1000)}s`
      );
    setTimeout(async () => {
      try {
        const v = await getHistoricalFutClose(sym).catch(() => undefined);
        if (Number.isFinite(Number(v))) {
          saveFutStore(sym, Number(v));
          if (DBG) console.log(`[DATA] futClose captured ${sym}=${v}`);
        } else if (DBG) {
          console.log(`[DATA] futClose capture skipped for ${sym}`);
        }
      } finally {
        scheduleNext();
      }
    }, ms);
  };

  scheduleNext();
}

/**
 * Schedule daily pre-close snapshots (default 15:20 IST).
 */
export function startDailySnapshots(symbol: string) {
  const sym = symbol.toUpperCase();

  const scheduleNext = () => {
    const ms = msUntilNextHHMMIST(SNAPSHOT_HHMM_IST);
    if (DBG) console.log(`[DATA] next snapshot for ${sym} in ~${Math.round(ms / 1000)}s`);
    setTimeout(async () => {
      await snapshotAllExpiries(sym).catch(() => {});
      scheduleNext();
    }, ms);
  };

  scheduleNext();
}
