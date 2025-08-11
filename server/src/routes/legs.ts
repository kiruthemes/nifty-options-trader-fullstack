import { Router, Request, Response } from "express";
import prisma from "../db";

const router = Router();

function getUserId(req: Request): number {
  const u = (req as any).user || {};
  const id = Number(u.id ?? u.sub);
  return Number.isFinite(id) ? id : 0;
}

// POST /api/legs
// body: { strategyId, side, type, strike, premium, lots, expiry, status? }
router.post("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const { strategyId, side, type, strike, premium, lots, expiry, status } = req.body || {};
  const sid = Number(strategyId);
  if (!Number.isFinite(sid)) return res.status(400).json({ error: "Invalid strategyId" });

  // strategy must belong to the user
  const strat = await prisma.strategy.findFirst({ where: { id: sid, userId } });
  if (!strat) return res.status(404).json({ error: "Strategy not found" });

  const created = await prisma.leg.create({
    data: {
      strategyId: sid,
      status: String(status || "STAGED").toUpperCase(),     // "STAGED" | "OPEN" | "CLOSED"
      side: String(side || "BUY").toUpperCase(),            // "BUY" | "SELL"
      type: String(type || "CE").toUpperCase(),             // "CE" | "PE"
      strike: Number(strike) || 0,
      premium: Number(premium) || 0,
      lots: Number(lots) || strat.defaultLots || 1,
      expiry: String(expiry || strat.selectedExpiry || new Date().toISOString().slice(0,10)),
    },
    select: {
      id: true, status: true, side: true, type: true, strike: true, premium: true, lots: true, expiry: true,
    },
  });

  return res.json(created);
});

// PATCH /api/legs/:id
router.patch("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  // ensure the leg belongs to a strategy owned by the user
  const leg = await prisma.leg.findFirst({
    where: { id, strategy: { userId } },
    select: { id: true },
  });
  if (!leg) return res.status(404).json({ error: "Not found" });

  const patch: any = {};
  const allow = ["status", "side", "type", "strike", "premium", "lots", "expiry", "entryPrice", "exitPrice"];
  for (const k of allow) {
    if (req.body?.[k] != null) patch[k] = req.body[k];
  }

  const updated = await prisma.leg.update({
    where: { id },
    data: patch,
    select: {
      id: true, status: true, side: true, type: true, strike: true, premium: true, lots: true, expiry: true,
      entryPrice: true, exitPrice: true,
    },
  });

  return res.json(updated);
});

// DELETE /api/legs/:id
router.delete("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  const leg = await prisma.leg.findFirst({
    where: { id, strategy: { userId } },
    select: { id: true },
  });
  if (!leg) return res.status(404).json({ error: "Not found" });

  await prisma.leg.delete({ where: { id } });
  return res.json({ ok: true });
});

export default router;
