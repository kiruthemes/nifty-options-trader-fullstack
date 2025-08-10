import { Router, Request, Response } from "express";
import { placeOrderZerodha } from "../brokers/zerodha";
import { placeOrderDhan } from "../brokers/dhan";

const router = Router();

type Order = {
  symbol: string;
  exchange: string;
  product: string;
  order_type: string;
  side: "BUY" | "SELL";
  option_type?: "CE" | "PE";
  strike?: number;
  price?: number;
  lots: number;
  lot_size?: number;
  action?: "OPEN" | "CLOSE";
};

router.post("/place-order", async (req: Request, res: Response) => {
  const provider = (req.body?.provider || process.env.DEFAULT_BROKER || "zerodha").toLowerCase();
  const orders: Order[] = Array.isArray(req.body?.orders) ? req.body.orders : [];
  if (!orders.length) return res.status(400).json({ error: "orders[] required" });

  try {
    const results = [];
    for (const o of orders) {
      let r: any;
      if (provider === "dhan") r = await placeOrderDhan(o);
      else r = await placeOrderZerodha(o);
      results.push({ ...r, provider });
    }
    return res.json({ ok: true, results });
  } catch (err: any) {
    console.error("place-order failed", err);
    return res.status(500).json({ error: err?.message || "broker error" });
  }
});

export default router;
