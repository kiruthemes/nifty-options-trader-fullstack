// server/src/adapters/dhan.ts

export type ExchangeSegment = "NSE_FNO" | "NSE_EQ" | "NSE_INDEX";

export interface OptionChainRow {
  strike: number;
  callLtp?: number;
  putLtp?: number;
  callOi?: number;
  putOi?: number;
  iv?: number;
  deltaC?: number;
  deltaP?: number;
  expiry?: string; // YYYY-MM-DD
}

const DHAN_BASE = "https://api.dhan.co";
const CLIENT_ID = process.env.DHAN_CLIENT_ID || "";
const ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN || "";

// Minimal symbol -> Dhan securityId map (expand later if needed)
const UNDERLYING_ID: Record<string, string> = {
  NIFTY: "49081",      // NIFTY 50
  BANKNIFTY: "49086",  // NIFTY BANK
};

function authHeaders() {
  if (!CLIENT_ID || !ACCESS_TOKEN) {
    throw new Error(
      "Dhan credentials missing: set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN in server/.env"
    );
  }
  return {
    "Dhan-Client-Id": CLIENT_ID,
    "Access-Token": ACCESS_TOKEN,
    "Content-Type": "application/json",
  };
}

async function postJson<T = any>(path: string, body: any): Promise<T> {
  const r = await fetch(`${DHAN_BASE}${path}`, {
    method: "POST",
    headers: authHeaders() as any,
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Dhan API ${path} -> HTTP ${r.status}: ${txt}`);
  }
  const txt = await r.text();
  try {
    return (txt ? JSON.parse(txt) : {}) as T;
  } catch {
    return {} as T;
  }
}

// Map Dhan option-chain payload to our OptionChainRow[]
function mapChainRows(payload: any, wantedExpiry?: string): OptionChainRow[] {
  const rows: OptionChainRow[] = [];
  const arr: any[] =
    payload?.data ||
    payload?.option_chain ||
    payload?.records ||
    (Array.isArray(payload) ? payload : []);

  for (const r of arr) {
    const strike = Number(
      r.strike_price ?? r.strikePrice ?? r.strike ?? r.k ?? r.strikeprice
    );
    if (!Number.isFinite(strike)) continue;

    const expiryRaw = r.expiry_date ?? r.expiryDate ?? r.expiry ?? r.expirydate ?? null;
    const expiry =
      typeof expiryRaw === "string"
        ? expiryRaw.slice(0, 10)
        : expiryRaw
        ? new Date(expiryRaw).toISOString().slice(0, 10)
        : undefined;

    if (wantedExpiry && expiry && wantedExpiry !== expiry) continue;

    const ce = r.call_option ?? r.ce ?? r.call ?? {};
    const pe = r.put_option ?? r.pe ?? r.put ?? {};

    rows.push({
      strike,
      callLtp: num(ce.ltp ?? ce.last_price ?? ce.lastPrice),
      putLtp:  num(pe.ltp ?? pe.last_price ?? pe.lastPrice),
      callOi:  num(ce.oi ?? ce.open_interest ?? ce.openInterest),
      putOi:   num(pe.oi ?? pe.open_interest ?? pe.openInterest),
      iv:      num(ce.iv ?? ce.implied_volatility ?? ce.impliedVolatility ?? pe.iv),
      deltaC:  num(ce.delta),
      deltaP:  num(pe.delta),
      expiry,
    });
  }
  rows.sort((a, b) => (a.strike || 0) - (b.strike || 0));
  return rows;
}

function num(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function getExpiries(symbol: string): Promise<string[]> {
  const sid = UNDERLYING_ID[symbol?.toUpperCase?.() || ""];
  if (!sid) return [];
  const payload = await postJson("/v2/option-chain", {
    exchangeSegment: "NSE_FNO",
    securityId: sid,
  });
  const rows = mapChainRows(payload);
  const uniq = Array.from(new Set(rows.map((r) => r.expiry).filter(Boolean))) as string[];
  uniq.sort();
  return uniq;
}

export async function getOptionChain(symbol: string, expiry?: string): Promise<OptionChainRow[]> {
  const sid = UNDERLYING_ID[symbol?.toUpperCase?.() || ""];
  if (!sid) throw new Error(`Unsupported symbol '${symbol}'. Add mapping in adapters/dhan.ts.`);
  const payload = await postJson("/v2/option-chain", {
    exchangeSegment: "NSE_FNO",
    securityId: sid,
  });
  return mapChainRows(payload, expiry);
}

// Optional: spot via Market Quote (index)
export async function getSpot(symbol: string): Promise<number> {
  const sid = UNDERLYING_ID[symbol?.toUpperCase?.() || ""];
  if (!sid) return NaN;
  try {
    const q: any = await postJson("/v2/market-quote", {
      exchangeSegment: "NSE_INDEX",
      securityId: sid,
    });
    const ltp = q?.last_price ?? q?.lastPrice ?? q?.ltp ?? q?.data?.ltp;
    const n = Number(ltp);
    return Number.isFinite(n) ? n : NaN;
  } catch {
    return NaN;
  }
}

export default { getExpiries, getOptionChain, getSpot };
