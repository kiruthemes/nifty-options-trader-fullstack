import { Router, Request, Response } from "express";
import prisma from "../db";

const router = Router();

function getUserId(req: Request): number {
  const u = (req as any).user || {};
  const id = Number(u.id ?? u.sub);
  return Number.isFinite(id) ? id : 0;
}

async function assertOwnStrategy(userId: number, strategyId: number) {
  const strat = await prisma.strategy.findFirst({ where: { id: strategyId, userId } });
  if (!strat) throw Object.assign(new Error("Strategy not found or forbidden"), { statusCode: 404 });
  return strat;
}

/**
 * GET /api/legs?strategyId=123
 */
router.get("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const strategyId = Number(req.query.strategyId);
  if (!Number.isFinite(strategyId)) return res.status(400).json({ error: "Bad strategyId" });

  try {
    await assertOwnStrategy(userId, strategyId);
    const legs = await prisma.leg.findMany({
      where: { strategyId },
      orderBy: { createdAt: "asc" }, // you have createdAt on Leg
    });
    return res.json({ legs });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message || "Failed to fetch legs" });
  }
});

/**
 * POST /api/legs
 * body: { strategyId, side, type, strike, premium, lots, expiry, status?, entryPrice? }
 * - For STAGED, premium is stored; entryPrice can be null.
 * - For OPEN, if entryPrice not provided, we default entryPrice = premium.
 */
router.post("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const {
    strategyId,
    side,
    type,
    strike,
    premium,
    lots,
    expiry,
    status,
    entryPrice,
  } = req.body || {};

  const sid = Number(strategyId);
  if (!Number.isFinite(sid)) return res.status(400).json({ error: "Bad strategyId" });

  const strikeNum = Number(strike) || 0;
  const lotsNum = Math.max(1, Math.min(999, Number(lots) || 1));
  const st = String(status || "STAGED").toUpperCase();
  const sideU = String(side || "BUY").toUpperCase();
  const typeU = String(type || "CE").toUpperCase();
  const expiryStr = String(expiry || new Date().toISOString().slice(0, 10));
  const premiumNum = Number(premium) || 0;
  const entryNum = Number(entryPrice);
  const hasEntry = Number.isFinite(entryNum);

  try {
    await assertOwnStrategy(userId, sid);

    const data: any = {
      strategyId: sid,
      status: st,
      side: sideU,
      type: typeU,
      strike: strikeNum,
      expiry: expiryStr,
      lots: lotsNum,
      premium: premiumNum,
    };

    if (st === "OPEN") {
      data.entryPrice = hasEntry ? entryNum : premiumNum;
    }

    const leg = await prisma.leg.create({ data });
    return res.json(leg);
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message || "Failed to create leg" });
  }
});

/**
 * PATCH /api/legs/:id
 * body: { status?, lots?, premium?, entryPrice?, exitPrice? }
 * - When closing, we also update Strategy.realized based on exitPrice vs (entryPrice||premium).
 */
router.patch("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });

  try {
    const leg = await prisma.leg.findUnique({ where: { id } });
    if (!leg) return res.status(404).json({ error: "Not found" });

    await assertOwnStrategy(userId, leg.strategyId);

    const patch: any = {};
    if (typeof req.body?.status === "string") patch.status = String(req.body.status).toUpperCase();
    if (req.body?.lots != null && Number.isFinite(Number(req.body.lots))) {
      patch.lots = Math.max(1, Math.min(999, Number(req.body.lots)));
    }
    if (req.body?.premium != null && Number.isFinite(Number(req.body.premium))) {
      patch.premium = Number(req.body.premium);
    }
    if (req.body?.entryPrice != null && Number.isFinite(Number(req.body.entryPrice))) {
      patch.entryPrice = Number(req.body.entryPrice);
    }
    if (req.body?.exitPrice != null && Number.isFinite(Number(req.body.exitPrice))) {
      patch.exitPrice = Number(req.body.exitPrice);
    }

    // If closing, update realized P/L on strategy
    const closing =
      String(patch.status || leg.status).toUpperCase() === "CLOSED" &&
      Number.isFinite(patch.exitPrice ?? leg.exitPrice);

    const updated = await prisma.leg.update({ where: { id }, data: patch });

    if (closing) {
      const strat = await prisma.strategy.findUnique({ where: { id: leg.strategyId } });
      if (strat) {
        const LOT_SIZE = 75; // Your app's default
        const sign = (updated.side || "BUY").toUpperCase() === "BUY" ? 1 : -1;
        const entry = Number(updated.entryPrice ?? leg.entryPrice ?? updated.premium ?? 0);
        const exit = Number(updated.exitPrice ?? leg.exitPrice ?? 0);
        const pnl = sign * (exit - entry) * (updated.lots || 1) * LOT_SIZE;
        await prisma.strategy.update({
          where: { id: leg.strategyId },
          data: { realized: Number(strat.realized || 0) + pnl },
        });
      }
    }

    return res.json(updated);
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message || "Failed to update leg" });
  }
});

/**
 * DELETE /api/legs/:id
 */
router.delete("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });

  try {
    const leg = await prisma.leg.findUnique({ where: { id } });
    if (!leg) return res.status(404).json({ error: "Not found" });

    await assertOwnStrategy(userId, leg.strategyId);
    await prisma.leg.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message || "Failed to delete leg" });
  }
});

export default router;
