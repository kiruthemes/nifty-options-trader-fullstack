// server/src/routes/providers.ts
import { Router, Request, Response } from "express";
import prisma from "../db";
import { auth } from "../middleware/auth";

const router = Router();
const ALLOWED = new Set(["synthetic", "dhan", "kite"]);

function getUserId(req: Request): number {
  const u = (req as any).user || {};
  const id = Number(u.id ?? u.sub);
  return Number.isFinite(id) ? id : 0;
}

// GET /api/providers/current  -> { provider: "synthetic" | "dhan" | "kite" }
router.get("/current", auth, async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { dataProvider: true },
  });
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const provider = user.dataProvider ?? "synthetic";
  return res.json({ provider });
});

// PATCH /api/providers/current  { provider }
router.patch("/current", auth, async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const p = String(req.body?.provider || "").toLowerCase();
  if (!ALLOWED.has(p)) {
    return res.status(400).json({ error: "Invalid provider" });
  }
  await prisma.user.update({
    where: { id: userId },
    data: { dataProvider: p },
  });
  return res.json({ ok: true, provider: p });
});

export default router;
