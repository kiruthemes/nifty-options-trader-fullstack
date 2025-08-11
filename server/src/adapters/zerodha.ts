// server/src/adapters/zerodha.ts
import axios from "axios";
import { MarketAdapter, OptionChainRow, ExecutionAdapter, PlaceOrderRequest } from "./types";

const BASE = process.env.KITE_BASE_URL || "https://api.kite.trade";
const API_KEY = process.env.KITE_API_KEY || "";
const ACCESS = process.env.KITE_ACCESS_TOKEN || "";

async function getOptionChain(symbol: string, expiry: string): Promise<OptionChainRow[]> {
  // NOTE: Kite does not have a single "option chain" endpoint;
  // you usually fetch instruments + LTP + OI for strikes. For now stub with empty.
  // You can implement a true fetch later; FE will fallback to synthetic if empty.
  return [];
}

async function placeOrder(req: PlaceOrderRequest, creds: any) {
  // NOTE: Map to kite order endpoint here. Example body is illustrative only.
  const url = `${BASE}/orders/regular`;
  const headers: any = {
    "Content-Type": "application/json",
    "X-Kite-Version": "3",
    "Authorization": `token ${creds?.apiKey || API_KEY}:${creds?.accessToken || ACCESS}`,
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
