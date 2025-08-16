// server/src/adapters/dhan.ts
import type { MarketAdapter, OptionChainRow, ExecutionAdapter } from "./types";

/**
 * Dhan v2 Data APIs
 * Docs:
 *  - /v2/optionchain            (POST)  { UnderlyingScrip, UnderlyingSeg, Expiry? }
 *  - /v2/optionchain/expirylist (POST)  { UnderlyingScrip, UnderlyingSeg }
 *  - /v2/charts/historical      (POST)  { securityId, exchangeSegment, instrument, ... }
 *
 * Headers MUST be: 'access-token' and 'client-id'
 */

const DHAN_BASE = process.env.DHAN_BASE || "https://api.dhan.co";
const CLIENT_ID = process.env.DHAN_CLIENT_ID || "";
const ACCESS    = process.env.DHAN_ACCESS_TOKEN || "";
const DEBUG_DHAN = process.env.DEBUG_DHAN === "1";

/** Index underlyings (Option Chain requires index "scrip" id, not instrument security id) */
export const INDEX_SCRIP: Record<string, number> = {
  NIFTY: 13,
  BANKNIFTY: 25,
  INDIAVIX: 21,
};
const UNDERLYING: Record<string, { scrip: number; seg: "IDX_I" }> = {
  NIFTY: { scrip: INDEX_SCRIP.NIFTY, seg: "IDX_I" },
  BANKNIFTY: { scrip: INDEX_SCRIP.BANKNIFTY, seg: "IDX_I" },
};

function headers(): Record<string, string> {
  if (!CLIENT_ID || !ACCESS) {
    throw new Error("Set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN in server/.env");
  }
  return {
    "access-token": ACCESS,
    "client-id": CLIENT_ID,
    "Content-Type": "application/json",
  };
}

import redisClient from "../lib/redisClient";

// --- throttled request queue to avoid Dhan rate limits (Redis-backed with fallback) ---
const DHAN_QPS = Number(process.env.DHAN_QPS || process.env.DHAN_API_QPS || 5);
const DHAN_INTERVAL_MS = Math.max(100, Math.floor(1000 / (DHAN_QPS || 1)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Redis queue keys
const REDIS_QUEUE_KEY = "dh:queue";
const REDIS_RATE_KEY_PREFIX = "dh:req_count:"; // per-second counter key

async function doFetch<T = any>(path: string, body: any): Promise<T> {
  const url = `${DHAN_BASE}${path}`;
  if (process.env.NODE_ENV !== "test") {
    console.log("[DHAN] POST", url, "body=", body);
  }
  const r = await fetch(url, {
    method: "POST",
    headers: headers() as any,
    body: JSON.stringify(body || {}),
  });
  const txt = await r.text().catch(() => "");
  if (DEBUG_DHAN) {
    console.log(`[DHAN][RAW] ${path} →`, txt.slice(0, 4000)); // first 4k chars
  }
  if (!r.ok) {
    throw new Error(`Dhan API ${path} -> HTTP ${r.status}: ${txt || "(empty)"}`);
  }
  try {
    return txt ? (JSON.parse(txt) as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

if (redisClient) {
  // Redis-backed processor: BRPOP items and enforce global rate via INCR per-second key
  (async function redisProcessor() {
    try {
      while (true) {
        const res = await (redisClient as any).brpop(REDIS_QUEUE_KEY, 5).catch(() => null);
        if (!res) continue;
        const payload = res[1];
        let item;
        try {
          item = JSON.parse(payload);
        } catch (e) {
          if (DEBUG_DHAN) console.warn('[DHAN][REDIS] invalid queue item', payload);
          continue;
        }

        const nowSec = Math.floor(Date.now() / 1000);
        const rateKey = `${REDIS_RATE_KEY_PREFIX}${nowSec}`;
        const allowed = await (redisClient as any).incr(rateKey).catch(() => 0);
        if (allowed === 1) await (redisClient as any).expire(rateKey, 2).catch(() => {});
        if (allowed > DHAN_QPS) {
          // requeue and wait
          await (redisClient as any).lpush(REDIS_QUEUE_KEY, payload).catch(() => {});
          await sleep(DHAN_INTERVAL_MS);
          continue;
        }

        try {
          const out = await doFetch(item.path, item.body);
          if (item.replyKey) await (redisClient as any).set(item.replyKey, JSON.stringify({ ok: true, data: out }), 'EX', 10).catch(()=>{});
        } catch (e: any) {
          if (item.replyKey) await (redisClient as any).set(item.replyKey, JSON.stringify({ ok: false, err: String(e?.message || e) }), 'EX', 10).catch(()=>{});
        }
        await sleep(DHAN_INTERVAL_MS);
      }
    } catch (e) {
      console.warn('[DHAN][REDIS] processor error', (e as any)?.message || e);
    }
  })();
}

// fallback in-memory queue
type QueueItem = { path: string; body: any; resolve: (v: any) => void; reject: (e: any) => void };
const requestQueue: QueueItem[] = [];
let queueProcessing = false;

async function processQueue() {
  if (queueProcessing) return;
  queueProcessing = true;
  while (requestQueue.length) {
    const item = requestQueue.shift()!;
    try {
      const out = await doFetch(item.path, item.body);
      item.resolve(out);
    } catch (e) {
      item.reject(e);
    }
    if (DEBUG_DHAN) console.log(`[DHAN] queue remaining=${requestQueue.length}`);
    await sleep(DHAN_INTERVAL_MS);
  }
  queueProcessing = false;
}

async function postJson<T = any>(path: string, body: any): Promise<T> {
  if (redisClient) {
    const replyKey = `dh:reply:${Math.random().toString(36).slice(2)}:${Date.now()}`;
    const payload = JSON.stringify({ path, body, replyKey });
    await (redisClient as any).lpush(REDIS_QUEUE_KEY, payload).catch(() => {});
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const resp = await (redisClient as any).get(replyKey).catch(() => null);
      if (resp) {
        try {
          const obj = JSON.parse(resp);
          if (obj?.ok) return obj.data as T;
          throw new Error(obj?.err || 'Dhan error');
        } catch (e) {
          throw e;
        }
      }
      await sleep(100);
    }
    throw new Error('Dhan request timeout');
  }

  return new Promise<T>((resolve, reject) => {
    requestQueue.push({ path, body, resolve, reject });
    processQueue().catch((e) => {
      if (DEBUG_DHAN) console.warn("[DHAN] queue processor error", e?.message || e);
    });
    if (requestQueue.length > (DHAN_QPS * 2) && DEBUG_DHAN) {
      console.warn(`[DHAN] request queue growing: ${requestQueue.length}`);
    }
  });
}

/* ---------------- historical OHLC ---------------- */

/**
 * Raw historical request wrapper.
 * Dates are YYYY-MM-DD; `toDate` is non-inclusive per Dhan docs.
 */
export async function getHistorical(payload: {
  securityId: string;
  exchangeSegment: "NSE_FNO" | "NSE_EQ" | "NSE_INDEX" | "IDX_I";
  instrument: "EQUITY" | "INDEX" | "FUTIDX" | "FUTSTK" | "OPTIDX" | "OPTSTK";
  expiryCode?: number;
  oi?: boolean;
  fromDate: string;
  toDate: string; // non-inclusive
}): Promise<{
  open?: number[];
  high?: number[];
  low?: number[];
  close?: number[];
  volume?: number[];
  timestamp?: number[];
  open_interest?: number[];
}> {
  const body = {
    securityId: String(payload.securityId),
    exchangeSegment: payload.exchangeSegment,
    instrument: payload.instrument,
    expiryCode: payload.expiryCode ?? 0,
    oi: !!payload.oi,
    fromDate: payload.fromDate,
    toDate: payload.toDate,
  };
  return postJson("/v2/charts/historical", body);
}

/**
 * Convenience: get last available daily close (& OI if requested) for a single securityId.
 * Returns undefined if the series is empty.
 */
export async function getHistoricalLastClose(params: {
  securityId: string;
  exchangeSegment: "NSE_FNO" | "NSE_EQ" | "NSE_INDEX" | "IDX_I";
  instrument: "EQUITY" | "INDEX" | "FUTIDX" | "FUTSTK" | "OPTIDX" | "OPTSTK";
  date: string;     // YYYY-MM-DD (we'll query [date, date+1) window)
  withOi?: boolean; // include OI in response if available
  expiryCode?: number;
}): Promise<{ close?: number; oi?: number } | undefined> {
  const fromDate = params.date;
  // toDate is non-inclusive; +1 day (keep in local TZ then slice)
  const d = new Date(params.date + "T00:00:00");
  const to = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  const toDate = new Date(to.getTime() - to.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  const resp = await getHistorical({
    securityId: params.securityId,
    exchangeSegment: params.exchangeSegment,
    instrument: params.instrument,
    expiryCode: params.expiryCode ?? 0,
    oi: !!params.withOi,
    fromDate,
    toDate,
  });

  // TS-safe narrowing (fixes “resp.close possibly undefined”)
  const closes: number[] = Array.isArray(resp?.close) ? resp.close.map(Number) : [];
  const ois: number[]    = Array.isArray(resp?.open_interest) ? resp.open_interest.map(Number) : [];
  const n = closes.length;
  if (!n) return undefined;

  const close = Number.isFinite(closes[n - 1]) ? closes[n - 1] : undefined;
  const oi    = Number.isFinite(ois[n - 1])    ? ois[n - 1]    : undefined;

  return { close, oi };
}

/* ---------------- expiry list cache (to avoid 429) ---------------- */
const expiryCache = new Map<string, { ts: number; list: string[] }>();
const EXPIRY_TTL_MS = 5 * 60 * 1000; // 5 min

function toISODate10(d: any): string | undefined {
  if (!d) return undefined;
  const s = typeof d === "string" ? d : (d.Expiry ?? d.expiry ?? d.date ?? "");
  if (typeof s !== "string" || !s) return undefined;
  // Keep YYYY-MM-DD if present; otherwise try to parse
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dt = new Date(s);
  if (!Number.isFinite(dt.getTime())) return undefined;
  return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export async function getExpiries(symbol: string): Promise<string[]> {
  const key = symbol.toUpperCase();
  const now = Date.now();
  const hit = expiryCache.get(key);
  if (hit && now - hit.ts < EXPIRY_TTL_MS) return hit.list;

  const u = UNDERLYING[key];
  if (!u) return [];

  const payload: any = await postJson("/v2/optionchain/expirylist", {
    UnderlyingScrip: u.scrip,
    UnderlyingSeg: u.seg,
  });

  // Be tolerant: payload.data may be string[] or array of objects
  const raw = payload?.data;
  const arr: any[] = Array.isArray(raw)
    ? raw
    : Array.isArray(payload?.data?.Expiries)
    ? payload.data.Expiries
    : Array.isArray(payload?.Expiries)
    ? payload.Expiries
    : [];

  const list = arr
    .map((x) => toISODate10(x))
    .filter(Boolean) as string[];

  list.sort(); // ascending
  expiryCache.set(key, { ts: now, list });
  return list;
}

function toNum(v: any, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Map Dhan optionchain payload → OptionChainRow[] (supports both "oc object" and "array" shapes) */
function mapOptionChain(payload: any): OptionChainRow[] {
  const d = payload?.data;
  if (!d) return [];

  // { data: { last_price, oc: { "19100.000000": { ce, pe }, ... } } }
  if (d.oc && typeof d.oc === "object" && !Array.isArray(d.oc)) {
    const out: OptionChainRow[] = [];
    for (const [k, v] of Object.entries<any>(d.oc)) {
      const strike = toNum(k);
      if (!Number.isFinite(strike)) continue;

      const ce = v?.ce ?? v?.CE ?? v?.call ?? v?.call_option ?? {};
      const pe = v?.pe ?? v?.PE ?? v?.put  ?? v?.put_option  ?? {};

      out.push({
        strike,
        callLtp: toNum(ce.ltp ?? ce.last_price ?? ce.lastPrice),
        putLtp:  toNum(pe.ltp ?? pe.last_price ?? pe.lastPrice),
        callOi:  toNum(ce.oi  ?? ce.open_interest ?? ce.openInterest),
        putOi:   toNum(pe.oi  ?? pe.open_interest ?? pe.openInterest),
        iv:      toNum(
                   ce.iv ?? ce.implied_volatility ?? ce.impliedVolatility ??
                   pe.iv ?? pe.implied_volatility ?? pe.impliedVolatility
                 ),
      });
    }
    out.sort((a, b) => a.strike - b.strike);
    return out;
  }

  // fallback if Dhan returns an array
  if (Array.isArray(d)) {
    const out: OptionChainRow[] = [];
    for (const r of d) {
      const strike = toNum(
        r.strikePrice ?? r.StrikePrice ?? r.strike_price ?? r.k ?? r.strike,
        NaN
      );
      if (!Number.isFinite(strike)) continue;

      const ce = r.CE ?? r.ce ?? r.call ?? r.call_option ?? {};
      const pe = r.PE ?? r.pe ?? r.put ?? r.put_option ?? {};

      out.push({
        strike,
        callLtp: toNum(ce.ltp ?? ce.last_price ?? ce.lastPrice),
        putLtp:  toNum(pe.ltp ?? pe.last_price ?? pe.lastPrice),
        callOi:  toNum(ce.oi  ?? ce.open_interest ?? ce.openInterest),
        putOi:   toNum(pe.oi  ?? pe.open_interest ?? pe.openInterest),
        iv:      toNum(
                   ce.iv ?? ce.implied_volatility ?? ce.impliedVolatility ??
                   pe.iv ?? pe.implied_volatility ?? pe.impliedVolatility
                 ),
      });
    }
    out.sort((a, b) => a.strike - b.strike);
    return out;
  }

  return [];
}

/* ---------------- public adapter ---------------- */
async function getOptionChain(symbol: string, expiry: string): Promise<OptionChainRow[]> {
  const key = symbol?.toUpperCase?.() || "NIFTY";
  const u = UNDERLYING[key];
  if (!u) throw new Error(`Unsupported symbol '${symbol}'. Add mapping in adapters/dhan.ts.`);

  // Validate expiry against Dhan list (prevents 811 Invalid Expiry Date)
  const list = await getExpiries(key);
  if (!list.includes(expiry)) {
    throw new Error(
      `Expiry '${expiry}' not valid for ${key}. Valid: ${list.slice(0, 6).join(", ")}${list.length > 6 ? ", ..." : ""}`
    );
  }

  const payload = await postJson("/v2/optionchain", {
    UnderlyingScrip: u.scrip,
    UnderlyingSeg: u.seg,
    Expiry: expiry, // YYYY-MM-DD
  });
  if (DEBUG_DHAN) {
    const root = payload?.data ?? payload;
    console.log("[DHAN][SHAPE] keys:", Object.keys(payload || {}));
    if (Array.isArray(root)) {
      console.log("[DHAN][SHAPE] array length:", root.length);
      if (root.length) console.log("[DHAN][ROW0]:", JSON.stringify(root[0], null, 2).slice(0, 2000));
    } else {
      console.log("[DHAN][SHAPE] type:", typeof root);
    }
  }
  return mapOptionChain(payload);
}

/** Raw OC fetch that also returns lastPrice (index spot) when available. */
export async function getOptionChainRaw(
  symbol: string,
  expiry: string
): Promise<{ rows: OptionChainRow[]; lastPrice?: number }> {
  const key = symbol?.toUpperCase?.() || "NIFTY";
  const u = UNDERLYING[key];
  if (!u) throw new Error(`Unsupported symbol '${symbol}'. Add mapping in adapters/dhan.ts.`);

  const list = await getExpiries(key);
  if (!list.includes(expiry)) {
    throw new Error(
      `Expiry '${expiry}' not valid for ${key}. Valid: ${list.slice(0, 6).join(", ")}${list.length > 6 ? ", ..." : ""}`
    );
  }

  const payload: any = await postJson("/v2/optionchain", {
    UnderlyingScrip: u.scrip,
    UnderlyingSeg: u.seg,
    Expiry: expiry,
  });

  const rows = mapOptionChain(payload);
  const lastPrice = Number(payload?.data?.last_price);
  return { rows, lastPrice: Number.isFinite(lastPrice) ? lastPrice : undefined };
}

export const DhanMarket: MarketAdapter = { name: "dhan", getOptionChain };
export default DhanMarket;

// Temporary execution adapter stub to satisfy callers expecting DhanExec.
// Real order placement is not implemented yet.
export const DhanExec: ExecutionAdapter = {
  name: "dhan",
  async placeOrder() {
    return { ok: false, raw: { error: "DhanExec not implemented" } };
  },
};


