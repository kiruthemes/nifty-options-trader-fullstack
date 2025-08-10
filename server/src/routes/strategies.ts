import { Router, Request, Response } from "express";
import prisma from "../db";

const router = Router();

function getUserId(req: Request): number {
  const u = (req as any).user || {};
  const id = Number(u.id ?? u.sub);
  return Number.isFinite(id) ? id : 0;
}
function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "1" || v.toLowerCase() === "true";
  return false;
}

/** List row */
function stratListDTO(s: any) {
  return {
    id: s.id,
    name: s.name,
    isArchived: !!s.isArchived,
    archived: !!s.isArchived, // alias for older FE
    defaultLots: s.defaultLots ?? 1,
    updatedAt: s.updatedAt,
    createdAt: s.createdAt,
  };
}

/** Full row */
function stratFullDTO(s: any) {
  return {
    id: s.id,
    name: s.name,
    isArchived: !!s.isArchived,
    archived: !!s.isArchived, // alias
    defaultLots: s.defaultLots ?? 1,
    underlying: s.underlying,
    atmBasis: s.atmBasis,
    selectedExpiry: s.selectedExpiry,
    realized: s.realized ?? 0,
    legs: s.legs ?? [],
    updatedAt: s.updatedAt,
    createdAt: s.createdAt,
  };
}

/** Build read-only "state" snapshot for backward compatibility */
function buildStateSnapshot(s: any) {
  const stagedLegs: any[] = [];
  const liveLegs: any[] = [];

  for (const l of (s.legs as any[]) || []) {
    const status = String(l.status || "").toUpperCase();
    if (status === "STAGED") {
      stagedLegs.push({
        side: l.side,
        type: l.type,
        strike: l.strike,
        expiry: l.expiry,
        lots: l.lots,
        premium: Number(l.premium ?? 0), // preview price
      });
    } else if (status === "OPEN") {
      liveLegs.push({
        side: l.side,
        type: l.type,
        strike: l.strike,
        expiry: l.expiry,
        lots: l.lots,
        premium: Number(l.entryPrice ?? l.premium ?? 0), // entry basis
      });
    }
  }

  return {
    liveLegs,
    stagedLegs,
    realized: Number(s.realized ?? 0),
    defaultLots: s.defaultLots ?? 1,
    atmBasis: s.atmBasis ?? "spot",
    underlying: s.underlying ?? "NIFTY",
    selectedExpiry: s.selectedExpiry ?? null,
  };
}

/* ----------------------------- Routes ----------------------------- */

// GET /api/strategies?includeArchived=0|1
router.get("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const includeArchived = toBool(req.query.includeArchived);
  const items = await prisma.strategy.findMany({
    where: { userId, ...(includeArchived ? {} : { isArchived: false }) },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      isArchived: true,
      defaultLots: true,
      updatedAt: true,
      createdAt: true,
    },
  });

  return res.json(items.map(stratListDTO));
});

// POST /api/strategies  { name, defaultLots?, underlying?, atmBasis?, selectedExpiry? }
router.post("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const name =
    typeof req.body?.name === "string" && req.body.name.trim()
      ? req.body.name.trim()
      : "Untitled Strategy";
  const defaultLots = Math.max(1, Math.min(999, Number(req.body?.defaultLots) || 1));
  const underlying = typeof req.body?.underlying === "string" ? req.body.underlying : "NIFTY";
  const atmBasis = typeof req.body?.atmBasis === "string" ? req.body.atmBasis : "spot";
  const selectedExpiry =
    typeof req.body?.selectedExpiry === "string" ? req.body.selectedExpiry : null;

  const created = await prisma.strategy.create({
    data: {
      userId,
      name,
      isArchived: false,
      defaultLots,
      underlying,
      atmBasis,
      selectedExpiry,
      realized: 0, 
    },
    select: { id: true },
  });

  return res.json({ id: created.id });
});

// GET /api/strategies/:id  (includes legs + compat state)
router.get("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  const s = await prisma.strategy.findFirst({
    where: { id, userId },
    include: { legs: true },
  });
  if (!s) return res.status(404).json({ error: "Not found" });

  return res.json({
    ...stratFullDTO(s),
    state: buildStateSnapshot(s),
  });
});

// PATCH /api/strategies/:id   { name?, isArchived?/archived?, defaultLots?, underlying?, atmBasis?, selectedExpiry?, realized? }
router.patch("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  const exists = await prisma.strategy.findFirst({ where: { id, userId } });
  if (!exists) return res.status(404).json({ error: "Not found" });

  const patch: any = {};

  if (typeof req.body?.name === "string" && req.body.name.trim()) patch.name = req.body.name.trim();
  if (typeof req.body?.isArchived === "boolean") patch.isArchived = req.body.isArchived;
  if (typeof req.body?.archived === "boolean") patch.isArchived = req.body.archived; // alias
  if (req.body?.defaultLots != null) {
    const dl = Math.max(1, Math.min(999, Number(req.body.defaultLots) || 1));
    patch.defaultLots = dl;
  }
  if (typeof req.body?.underlying === "string") patch.underlying = req.body.underlying;
  if (typeof req.body?.atmBasis === "string") patch.atmBasis = req.body.atmBasis;
  if (typeof req.body?.selectedExpiry === "string") patch.selectedExpiry = req.body.selectedExpiry;
  if (req.body?.realized != null && Number.isFinite(Number(req.body.realized))) {
    patch.realized = Number(req.body.realized);
  }

  await prisma.strategy.update({ where: { id }, data: patch });
  return res.json({ ok: true });
});

/** READ/WRITE compat: older FE may PUT /:id/state — treat as prefs update */
router.put("/:id/state", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  const exists = await prisma.strategy.findFirst({ where: { id, userId } });
  if (!exists) return res.status(404).json({ error: "Not found" });

  const body = req.body || {};
  const patch: any = {};
  if (body.defaultLots != null && Number.isFinite(Number(body.defaultLots)))
    patch.defaultLots = Math.max(1, Math.min(999, Number(body.defaultLots)));
  if (typeof body.underlying === "string") patch.underlying = body.underlying;
  if (typeof body.atmBasis === "string") patch.atmBasis = body.atmBasis;
  if (typeof body.selectedExpiry === "string") patch.selectedExpiry = body.selectedExpiry;
  if (body.realized != null && Number.isFinite(Number(body.realized)))
    patch.realized = Number(body.realized);

  if (Object.keys(patch).length) {
    await prisma.strategy.update({ where: { id }, data: patch });
  }
  return res.json({ ok: true });
});

// DELETE /api/strategies/:id (delete legs first to avoid FK issues)
router.delete("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  const exists = await prisma.strategy.findFirst({ where: { id, userId } });
  if (!exists) return res.status(404).json({ error: "Not found" });

  await prisma.leg.deleteMany({ where: { strategyId: id } });
  await prisma.strategy.delete({ where: { id } });
  return res.json({ ok: true });
});

export default router;
