// server/src/adapters/zerodha.ts
import axios from "axios";
import {
  MarketAdapter,
  OptionChainRow,
  ExecutionAdapter,
  PlaceOrderRequest,
} from "./types";

const BASE = process.env.KITE_BASE_URL || "https://api.kite.trade";
const API_KEY = process.env.KITE_API_KEY || "";
const ACCESS = process.env.KITE_ACCESS_TOKEN || "";
const KITE_VERSION = "3";

// ------- Instruments cache (CSV) -------
type KiteInstrument = {
  instrument_token: string;
  exchange_token: string;
  tradingsymbol: string;
  name: string;
  last_price: number;
  expiry: string;       // YYYY-MM-DD
  strike: number;
  tick_size: number;
  lot_size: number;
  instrument_type: string; // "FUT", "OPTIDX", ...
  segment: string;         // e.g., "NFO-OPT"
  exchange: string;        // "NFO"
};

let _instruments: KiteInstrument[] | null = null;
let _insFetchedAt = 0;
const INS_TTL_MS = 1000 * 60 * 60 * 6; // 6h

async function fetchInstrumentsCSV(): Promise<KiteInstrument[]> {
  // Public endpoint (no auth for CSV)
  const url = `${BASE}/instruments`;
  const { data: csv } = await axios.get<string>(url, {
    headers: { "X-Kite-Version": KITE_VERSION },
    timeout: 15000,
    responseType: "text",
  });

  const lines = csv.trim().split(/\r?\n/);
  const header = lines.shift()!;
  const cols = header.split(",");
  const idx = (k: string) => cols.indexOf(k);

  const out: KiteInstrument[] = [];
  for (const line of lines) {
    // simple CSV split (Kite CSV fields don't contain commas in practice)
    const cells = line.split(",");
    const row = (k: string) => cells[idx(k)] ?? "";

    const instrument_type = row("instrument_type");
    const segment = row("segment");
    const exchange = row("exchange");

    out.push({
      instrument_token: row("instrument_token"),
      exchange_token: row("exchange_token"),
      tradingsymbol: row("tradingsymbol"),
      name: row("name"),
      last_price: Number(row("last_price") || 0),
      expiry: row("expiry"),
      strike: Number(row("strike") || 0),
      tick_size: Number(row("tick_size") || 0),
      lot_size: Number(row("lot_size") || 0),
      instrument_type,
      segment,
      exchange,
    });
  }
  return out;
}

async function getInstruments(): Promise<KiteInstrument[]> {
  const now = Date.now();
  if (_instruments && now - _insFetchedAt < INS_TTL_MS) return _instruments;
  _instruments = await fetchInstrumentsCSV();
  _insFetchedAt = now;
  return _instruments;
}

// ------- Option chain via Zerodha (quotes for all strikes at expiry) -------
export async function getOptionChain(symbol: string, expiry: string): Promise<OptionChainRow[]> {
  if (!API_KEY || !ACCESS) {
    console.warn("[Kite] Missing API_KEY/ACCESS; returning empty chain");
    return [];
  }

  const all = await getInstruments();

  // Filter to NFO-OPT options for the underlying (Kite 'name' matches 'NIFTY' / 'BANKNIFTY')
  const rows = all.filter(
    (r) =>
      r.exchange === "NFO" &&
      r.segment === "NFO-OPT" &&
      r.instrument_type === "OPTIDX" &&
      r.name?.toUpperCase() === symbol?.toUpperCase() &&
      r.expiry === expiry
  );

  if (!rows.length) return [];

  // Group by strike -> { CE, PE }
  const byStrike = new Map<number, { ce?: KiteInstrument; pe?: KiteInstrument }>();
  for (const it of rows) {
    const strike = Number(it.strike);
    if (!Number.isFinite(strike)) continue;
    const end = it.tradingsymbol?.slice(-2).toUpperCase(); // CE/PE
    const curr = byStrike.get(strike) || {};
    if (end === "CE") curr.ce = it;
    else if (end === "PE") curr.pe = it;
    byStrike.set(strike, curr);
  }

  // Build quote list
  const items: { strike: number; ce?: KiteInstrument; pe?: KiteInstrument }[] = [];
  for (const [k, v] of Array.from(byStrike.entries()).sort((a, b) => a[0] - b[0])) {
    items.push({ strike: k, ce: v.ce, pe: v.pe });
  }
  if (!items.length) return [];

  // Batch quote calls (Kite /quote supports multiple i= params)
  const toParam = (ts: string) => `i=${encodeURIComponent(`NFO:${ts}`)}`;

  const headers: any = {
    "X-Kite-Version": KITE_VERSION,
    Authorization: `token ${API_KEY}:${ACCESS}`,
  };

  // prepare all tradingsymbols
  const allTs: string[] = [];
  for (const it of items) {
    if (it.ce?.tradingsymbol) allTs.push(it.ce.tradingsymbol);
    if (it.pe?.tradingsymbol) allTs.push(it.pe.tradingsymbol);
  }

  // Kite suggests batching; keep batches moderate (e.g., 150)
  const batchSize = 150;
  const quotes: Record<string, any> = {};
  for (let i = 0; i < allTs.length; i += batchSize) {
    const batch = allTs.slice(i, i + batchSize);
    const url = `${BASE}/quote?${batch.map(toParam).join("&")}`;
    try {
      const { data } = await axios.get(url, { headers, timeout: 10000 });
      Object.assign(quotes, data?.data || {});
    } catch (e: any) {
      console.warn("[Kite] quote batch failed:", e?.response?.status || e?.message);
    }
  }

  // Map to OptionChainRow (use 0 when data missing)
  const out: OptionChainRow[] = items.map(({ strike, ce, pe }) => {
    const keyCE = ce?.tradingsymbol ? `NFO:${ce.tradingsymbol}` : "";
    const keyPE = pe?.tradingsymbol ? `NFO:${pe.tradingsymbol}` : "";
    const qCE = keyCE ? quotes[keyCE] : undefined;
    const qPE = keyPE ? quotes[keyPE] : undefined;

    const callLtp = Number(qCE?.last_price || qCE?.lastPrice || 0);
    const putLtp  = Number(qPE?.last_price || qPE?.lastPrice || 0);
    const callOi  = Number(qCE?.oi || qCE?.oi_day_high || 0);
    const putOi   = Number(qPE?.oi || qPE?.oi_day_high || 0);

    return {
      strike: Number(strike) || 0,
      callLtp: Number.isFinite(callLtp) ? callLtp : 0,
      putLtp:  Number.isFinite(putLtp)  ? putLtp  : 0,
      callOi:  Number.isFinite(callOi)  ? callOi  : 0,
      putOi:   Number.isFinite(putOi)   ? putOi   : 0,
      iv: 0,       // not provided by Kite; keep 0 (FE can BS-fallback)
      deltaC: 0,   // not provided; 0
      deltaP: 0,   // not provided; 0
    };
  });

  return out;
}

// ------- Orders (execution) via Zerodha -------
async function placeOrder(req: PlaceOrderRequest, creds: any) {
  const url = `${BASE}/orders/regular`;
  const headers: any = {
    "Content-Type": "application/json",
    "X-Kite-Version": KITE_VERSION,
    Authorization: `token ${creds?.apiKey || API_KEY}:${creds?.accessToken || ACCESS}`,
  };

  const body = {
    tradingsymbol: req.symbol,
    exchange: req.exchange,
    transaction_type: req.side,
    order_type: req.order_type,
    quantity: req.lots * req.lot_size,
    product: req.product,
    variety: "regular",
    validity: "DAY",
    price: req.price || 0,
  };

  try {
    const { data } = await axios.post(url, body, { headers, timeout: 7000 });
    return { ok: true, orderId: data?.data?.order_id, raw: data };
  } catch (e: any) {
    return { ok: false, raw: e?.response?.data || e?.message };
  }
}

export const KiteMarket: MarketAdapter = { name: "kite", getOptionChain };
export const KiteExec: ExecutionAdapter = { name: "kite", placeOrder };
export default { getOptionChain, placeOrder };
