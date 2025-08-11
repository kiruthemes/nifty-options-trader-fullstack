// server/src/routes/brokers.ts
import { Router, Request, Response } from "express";
import prisma from "../db";
import { auth } from "../middleware/auth";
import { maybeEncrypt } from "../utils/vault";
const router = Router();

const ALLOWED_PROVIDERS = new Set(["dhan", "kite"]);

function uid(req: Request) {
  const u = (req as any).user || {};
  const id = Number(u.id ?? u.sub);
  return Number.isFinite(id) ? id : 0;
}

function parseDateMaybe(v: unknown): Date | null {
  if (!v) return null;
  try {
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * GET /api/brokers
 * List broker accounts for the authenticated user
 */
router.get("/", auth, async (req: Request, res: Response) => {
  const userId = uid(req);
  const items = await prisma.brokerAccount.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      provider: true,
      label: true,
      clientId: true,
      // tokenExpiresAt is fine to include if you want it in the UI
      tokenExpiresAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  res.json(items);
});

/**
 * POST /api/brokers
 * Create a broker account (production-ready fields; validation per provider)
 * Body: { provider, label?, clientId?, apiKey?, apiSecret?, accessToken?, refreshToken?, tokenExpiresAt?, metaJson? }
 */
router.post("/", auth, async (req: Request, res: Response) => {
  const userId = uid(req);
  const provider = String(req.body?.provider || "").toLowerCase();
  const label = String(req.body?.label || provider || "");

  if (!ALLOWED_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: "Invalid provider" });
  }

  // Provider-specific minimal validation
  if (provider === "dhan") {
    if (!req.body?.accessToken) {
      return res.status(400).json({ error: "accessToken is required for Dhan" });
    }
  }
  if (provider === "kite") {
    if (!req.body?.apiKey || !req.body?.apiSecret) {
      return res
        .status(400)
        .json({ error: "apiKey and apiSecret are required for Zerodha (Kite)" });
    }
  }

  const tokenExpiresAt = parseDateMaybe(req.body?.tokenExpiresAt);

  // metaJson must be a string (or omitted). Never pass null for fields with defaults.
  let metaJson: string | undefined = undefined;
  if (req.body?.metaJson !== undefined) {
    try {
      if (typeof req.body.metaJson === "object") {
        metaJson = JSON.stringify(req.body.metaJson);
      } else if (typeof req.body.metaJson === "string" && req.body.metaJson.trim()) {
        JSON.parse(req.body.metaJson); // validate
        metaJson = req.body.metaJson;
      } else {
        metaJson = "{}";
      }
    } catch {
      return res.status(400).json({ error: "metaJson must be valid JSON or object" });
    }
  }

  // Build data object without sending null for fields that Prisma types as string | undefined
  const data: any = {
    userId,
    provider,
    label,
  };

  // These columns are nullable in your schema; null is acceptable
  if (req.body?.clientId !== undefined) data.clientId = req.body.clientId || null;
  if (req.body?.apiKey !== undefined) data.apiKey = req.body.apiKey || null;
  if (req.body?.apiSecret !== undefined) data.apiSecret = req.body.apiSecret || null;
  if (req.body?.accessToken !== undefined) data.accessToken = req.body.accessToken || null;
  if (req.body?.refreshToken !== undefined) data.refreshToken = req.body.refreshToken || null;

  // Only set when valid date supplied
  if (tokenExpiresAt) data.tokenExpiresAt = tokenExpiresAt;

  // Only include metaJson when we have a string; omit otherwise to let default("{}") apply
  if (metaJson !== undefined) data.metaJson = metaJson;

  const created = await prisma.brokerAccount.create({
    data: {
      userId,
      provider,
      label,
      clientId: maybeEncrypt(req.body?.clientId) || null,
      apiKey: maybeEncrypt(req.body?.apiKey) || null,
      apiSecret: maybeEncrypt(req.body?.apiSecret) || null,
      accessToken: maybeEncrypt(req.body?.accessToken) || null,
      refreshToken: maybeEncrypt(req.body?.refreshToken) || null,
      tokenExpiresAt, // this is Date | null
      metaJson, // already a JSON string
    },
    select: { id: true },
  });

  res.json({ id: created.id });
});

/**
 * PATCH /api/brokers/:id
 * Update credentials / label / tokens
 */
router.patch("/:id", auth, async (req: Request, res: Response) => {
  const userId = uid(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  const acct = await prisma.brokerAccount.findFirst({ where: { id, userId } });
  if (!acct) return res.status(404).json({ error: "Not found" });

  const patch: any = {};
  if (typeof req.body?.label === "string") patch.label = req.body.label;

  // credentials/tokens are optional; set only when provided
  for (const k of ["clientId", "apiKey", "apiSecret", "accessToken", "refreshToken"] as const) {
    if (req.body?.[k] !== undefined) patch[k] = maybeEncrypt(req.body[k]) || null;
  }

  if (req.body?.tokenExpiresAt !== undefined) {
    const d = parseDateMaybe(req.body.tokenExpiresAt);
    if (d) patch.tokenExpiresAt = d;
    else patch.tokenExpiresAt = null; // explicitly clear if invalid/empty
  }

  if (req.body?.metaJson !== undefined) {
    try {
      if (typeof req.body.metaJson === "object") {
        patch.metaJson = JSON.stringify(req.body.metaJson);
      } else if (typeof req.body.metaJson === "string" && req.body.metaJson.trim()) {
        JSON.parse(req.body.metaJson);
        patch.metaJson = req.body.metaJson;
      } else {
        patch.metaJson = "{}";
      }
    } catch {
      return res.status(400).json({ error: "metaJson must be valid JSON or object" });
    }
  }

  await prisma.brokerAccount.update({ where: { id }, data: patch });
  res.json({ ok: true });
});

/**
 * DELETE /api/brokers/:id
 * Remove a broker account (also cascades StrategyBroker & Orders by schema)
 */
router.delete("/:id", auth, async (req: Request, res: Response) => {
  const userId = uid(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  const acct = await prisma.brokerAccount.findFirst({ where: { id, userId } });
  if (!acct) return res.status(404).json({ error: "Not found" });

  await prisma.brokerAccount.delete({ where: { id } });
  res.json({ ok: true });
});

/**
 * POST /api/brokers/link
 * Link a broker to a strategy
 */
router.post("/link", auth, async (req: Request, res: Response) => {
  const userId = uid(req);
  const strategyId = Number(req.body?.strategyId);
  const brokerAccountId = Number(req.body?.brokerAccountId);
  if (!strategyId || !brokerAccountId) return res.status(400).json({ error: "Missing ids" });

  // verify ownership
  const strat = await prisma.strategy.findFirst({ where: { id: strategyId, userId } });
  const broker = await prisma.brokerAccount.findFirst({ where: { id: brokerAccountId, userId } });
  if (!strat || !broker) return res.status(404).json({ error: "Not found" });

  await prisma.strategyBroker.upsert({
    where: { strategyId_brokerAccountId: { strategyId, brokerAccountId } },
    create: { strategyId, brokerAccountId, enabled: true },
    update: { enabled: true },
  });
  res.json({ ok: true });
});

/**
 * POST /api/brokers/unlink
 * Unlink a broker from a strategy
 */
router.post("/unlink", auth, async (req: Request, res: Response) => {
  const userId = uid(req);
  const strategyId = Number(req.body?.strategyId);
  const brokerAccountId = Number(req.body?.brokerAccountId);
  if (!strategyId || !brokerAccountId) return res.status(400).json({ error: "Missing ids" });

  const link = await prisma.strategyBroker.findFirst({
    where: { strategyId, brokerAccountId, strategy: { userId } },
  });
  if (!link) return res.status(404).json({ error: "Not linked" });

  await prisma.strategyBroker.delete({ where: { id: link.id } });
  res.json({ ok: true });
});

/**
 * GET /api/brokers/strategy/:id
 * List linked brokers for a given strategy (owned by user)
 */
router.get("/strategy/:id", auth, async (req: Request, res: Response) => {
  const userId = uid(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  const links = await prisma.strategyBroker.findMany({
    where: { strategyId: id, strategy: { userId } },
    include: { broker: { select: { id: true, provider: true, label: true } } },
  });

  res.json(
    links.map((l) => ({
      id: l.id,
      brokerAccountId: l.brokerAccountId,
      provider: l.broker.provider,
      label: l.broker.label,
      enabled: l.enabled,
    }))
  );
});

export default router;
