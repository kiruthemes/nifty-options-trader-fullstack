// server/src/routes/market.ts
import { Router, Request, Response } from "express";
import { auth } from "../middleware/auth";
import {
  fetchOptionChain,
  getCachedOptionChain,
  getProvider,
  setProvider,
} from "../services/dataFeed";
import { Provider } from "../adapters/types";
import { getExpiries as dhanGetExpiries } from "../adapters/dhan";
import { wsSubscribeChain } from "../ws/dhanFeed";
const router = Router();

// GET active provider
router.get("/provider", (_req: Request, res: Response) => {
  res.json({ provider: getProvider() });
});

// PATCH set provider { provider: "dhan"|"kite" }
router.patch("/provider", auth, (req: Request, res: Response) => {
  const p = String(req.body?.provider || "").toLowerCase() as Provider;
  if (!["dhan", "kite"].includes(p)) {
    return res
      .status(400)
      .json({ error: "Invalid provider. Allowed: 'dhan' | 'kite' (synthetic disabled)" });
  }
  setProvider(p);
  res.json({ provider: p });
});

// GET expiries (Dhan implemented)
router.get("/expiries", auth, async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol || "NIFTY");
  const provider = getProvider();
  res.setHeader("X-Market-Provider", provider);

  try {
    if (provider === "dhan") {
      const expiries = await dhanGetExpiries(symbol);
      return res.json({ provider, expiries });
    }
    return res.status(501).json({ error: "Expiries not implemented for provider", provider });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Failed to fetch expiries", provider });
  }
});

// GET option chain
// Query: ?symbol=NIFTY&expiry=YYYY-MM-DD[&cached=1]
router.get("/option-chain", auth, async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol || "NIFTY");
  const expiry = String(req.query.expiry || "");
  const cached = String(req.query.cached || "") === "1";
  if (!expiry) return res.status(400).json({ error: "expiry required" });

  const provider = getProvider();
  res.setHeader("X-Market-Provider", provider);

  try {
    const snap = cached
      ? getCachedOptionChain(symbol, expiry)
      : await fetchOptionChain(symbol, expiry);

    if (provider === "dhan") {
      try {
        wsSubscribeChain(symbol, expiry);
      } catch {}
    }
    // expose last price in header too (useful for debugging)
    if (Number.isFinite(Number(snap.lastPrice))) {
      res.setHeader("X-Underlying-Last", String(snap.lastPrice));
    }

    return res.json({ provider, rows: snap.rows, lastPrice: snap.lastPrice, source: snap.source });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Failed to fetch option chain", provider });
  }
});

export default router;
