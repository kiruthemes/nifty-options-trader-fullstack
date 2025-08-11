// server/src/routes/market.ts
import { Router, Request, Response } from "express";
import { auth } from "../middleware/auth";
import { fetchOptionChain, getProvider, setProvider } from "../services/dataFeed";
import { Provider } from "../adapters/types";

const router = Router();

// GET active provider
router.get("/provider", (_req: Request, res: Response) => {
  res.json({ provider: getProvider() });
});

// PATCH set provider { provider: "synthetic"|"dhan"|"kite" }
router.patch("/provider", auth, (req: Request, res: Response) => {
  const p = String(req.body?.provider || "").toLowerCase() as Provider;
  if (!["synthetic", "dhan", "kite"].includes(p)) {
    return res.status(400).json({ error: "Invalid provider" });
  }
  setProvider(p);
  res.json({ provider: p });
});

// GET option chain (normalized)
router.get("/option-chain", auth, async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol || "NIFTY");
  const expiry = String(req.query.expiry || "");
  if (!expiry) return res.status(400).json({ error: "expiry required" });
  const rows = await fetchOptionChain(symbol, expiry);
  res.json({ rows });
});

export default router;
