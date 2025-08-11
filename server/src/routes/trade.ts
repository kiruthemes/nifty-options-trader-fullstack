// server/src/routes/trade.ts
import { Router, Request, Response } from "express";
import { auth } from "../middleware/auth";
import prisma from "../db";
import { placeOrdersForStrategy } from "../services/brokerExec";

const router = Router();

function uid(req: Request) {
  const u = (req as any).user || {};
  const id = Number(u.id ?? u.sub);
  return Number.isFinite(id) ? id : 0;
}

type IncomingOrder = {
  symbol?: string;
  exchange?: string;
  product?: string;
  order_type?: string;
  side?: string;
  option_type?: string;
  strike?: number | string;
  price?: number | string;
  lots?: number | string;
  lot_size?: number | string;
  expiry?: string;
  expiryDate?: string;
  action?: string;
};

function normalizeOrder(raw: IncomingOrder) {
  const err = (m: string) => {
    const e = new Error(m);
    (e as any).status = 400;
    return e;
  };
  if (!raw) throw err("Order is required");

  const symbol = String(raw.symbol || "NIFTY").toUpperCase();
  const exchange = String(raw.exchange || "NFO").toUpperCase();
  const product = String(raw.product || "NRML").toUpperCase();
  const order_type = String(raw.order_type || "MARKET").toUpperCase();
  const side = String(raw.side || "").toUpperCase();
  const option_type = String(raw.option_type || "").toUpperCase();

  if (!["BUY", "SELL"].includes(side)) throw err(`Invalid side: ${raw.side}`);
  if (!["CE", "PE"].includes(option_type)) throw err(`Invalid option_type: ${raw.option_type}`);

  const strike = Number(raw.strike);
  const lots = Math.max(1, Number(raw.lots ?? 1));
  const lot_size = Math.max(1, Number(raw.lot_size ?? 75));
  const price = raw.price != null ? Number(raw.price) : undefined;
  if (!Number.isFinite(strike)) throw err("strike must be a number");
  if (!Number.isFinite(lots)) throw err("lots must be a number");
  if (!Number.isFinite(lot_size)) throw err("lot_size must be a number");
  if (price != null && !Number.isFinite(price)) throw err("price must be a number if provided");

  const expiry = String(raw.expiry || raw.expiryDate || "").trim();
  if (!expiry) throw err("expiry is required (YYYY-MM-DD)");

  const action = raw.action ? String(raw.action).toUpperCase() : undefined;

  return {
    symbol,
    exchange,
    product,
    order_type,
    side: side as "BUY" | "SELL",
    option_type: option_type as "CE" | "PE",
    strike,
    price,
    lots,
    lot_size,
    expiry,
    expiryDate: expiry,
    action,
  };
}

function normalizeOrders(arr: any) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr.map(normalizeOrder);
}

// POST /api/strategies/:id/place-orders
router.post("/strategies/:id/place-orders", auth, async (req: Request, res: Response) => {
  try {
    const userId = uid(req);
    const strategyId = Number(req.params.id);
    if (!Number.isFinite(strategyId)) return res.status(400).json({ error: "Invalid strategy id" });

    const orders = normalizeOrders(req.body?.orders);
    if (!orders.length) return res.status(400).json({ error: "orders required" });

    // Strategy ownership
    const strat = await prisma.strategy.findFirst({ where: { id: strategyId, userId } });
    if (!strat) return res.status(404).json({ error: "Strategy not found" });

    const results = await placeOrdersForStrategy(strategyId, orders);
    return res.json({ ok: true, results });
  } catch (e: any) {
    const code = Number(e?.status) || 500;
    return res.status(code).json({ error: String(e?.message || "Failed to place orders") });
  }
});

// Back-compat endpoint but NOW REQUIRES strategyId explicitly.
router.post("/place-order", auth, async (req: Request, res: Response) => {
  try {
    const userId = uid(req);
    const strategyId = Number(req.body?.strategyId);
    if (!Number.isFinite(strategyId)) {
      return res.status(400).json({ error: "strategyId is required" });
    }

    const orders = normalizeOrders(req.body?.orders);
    if (!orders.length) return res.status(400).json({ error: "orders required" });

    // Ownership check
    const strat = await prisma.strategy.findFirst({ where: { id: strategyId, userId } });
    if (!strat) return res.status(404).json({ error: "Strategy not found" });

    const results = await placeOrdersForStrategy(strategyId, orders);
    return res.json({ ok: true, results });
  } catch (e: any) {
    const code = Number(e?.status) || 500;
    return res.status(code).json({ error: String(e?.message || "Failed to place orders") });
  }
});

export default router;
