// server/src/adapters/dhan.ts
import axios from "axios";
import { MarketAdapter, OptionChainRow, ExecutionAdapter, PlaceOrderRequest } from "./types";

const DHAN_BASE = process.env.DHAN_BASE_URL || "https://api.dhan.co";
const DATA_KEY = process.env.DHAN_DATA_API_KEY || "";
const ACCESS = process.env.DHAN_ACCESS_TOKEN || "";

async function getOptionChain(symbol: string, expiry: string): Promise<OptionChainRow[]> {
  // NOTE: Replace with actual Dhan Data API endpoint/shape.
  // Example (pseudo): GET /market/option-chain?symbol=NIFTY&expiry=YYYY-MM-DD
  const url = `${DHAN_BASE}/market/option-chain`;
  const params = { symbol, expiry };
  const headers: any = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${ACCESS}`,
    "x-api-key": DATA_KEY,
  };

  try {
    const { data } = await axios.get(url, { params, headers, timeout: 7000 });
    // Normalize here to OptionChainRow[]
    // Expected incoming shape (example):
    // data.rows = [{strike, ce:{ltp, oi, iv}, pe:{ltp, oi, iv}}, ...]
    const rows: OptionChainRow[] = (data?.rows || []).map((r: any) => ({
      strike: Number(r.strike),
      callLtp: Number(r.ce?.ltp ?? 0),
      putLtp: Number(r.pe?.ltp ?? 0),
      callOi: Number(r.ce?.oi ?? 0),
      putOi: Number(r.pe?.oi ?? 0),
      iv: Number(r.ce?.iv ?? r.pe?.iv ?? 0),
    }));
    return rows;
  } catch (err) {
    // Fallback empty (frontend will use synthetic when rows = 0)
    return [];
  }
}

async function placeOrder(req: PlaceOrderRequest, creds: any) {
  // NOTE: Replace with actual Dhan trade endpoint + body mapping
  // POST /orders
  const url = `${DHAN_BASE}/orders`;
  const headers: any = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${creds?.accessToken || ACCESS}`,
    "x-api-key": creds?.apiKey || DATA_KEY,
  };

  const body = {
    symbol: req.symbol,
    exchange: req.exchange,
    product: req.product,
    order_type: req.order_type,
    transaction_type: req.side,     // BUY/SELL
    option_type: req.option_type,   // CE/PE
    strike_price: req.strike,
    qty: req.lots * req.lot_size,
    price: req.price || 0,
    validity: "DAY",
    expiry: req.expiry,
  };

  try {
    const { data } = await axios.post(url, body, { headers, timeout: 7000 });
    return { ok: true, orderId: data?.order_id, raw: data };
  } catch (e: any) {
    return { ok: false, raw: e?.response?.data || e?.message };
  }
}

export const DhanMarket: MarketAdapter = { name: "dhan", getOptionChain };
export const DhanExec: ExecutionAdapter = { name: "dhan", placeOrder };
