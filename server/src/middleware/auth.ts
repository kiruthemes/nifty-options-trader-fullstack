import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || "devsecret";
const DEV_EMAIL_HEADER = "x-user-email";
// Allow dev header auth if ALLOW_HEADER_EMAIL=1 or not in production
const ALLOW_HEADER_EMAIL =
  process.env.ALLOW_HEADER_EMAIL === "1" || process.env.NODE_ENV !== "production";

export type AuthUser = { id: number; email: string; name?: string | null };

export function signJwt(user: { id: number; email: string; name?: string | null }) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name ?? null },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

/** Try to resolve a user from a verified JWT payload via id (sub) or email */
async function userFromJwtPayload(payload: any): Promise<AuthUser | null> {
  let user = null;

  if (payload?.sub != null) {
    const idNum = Number(payload.sub);
    if (!Number.isNaN(idNum)) {
      user = await prisma.user.findUnique({ where: { id: idNum } });
    }
  }

  if (!user && payload?.email) {
    user = await prisma.user.findUnique({ where: { email: String(payload.email) } });
  }

  if (!user) return null;
  return { id: user.id, email: user.email, name: user.name ?? null };
}

/** Dev helper: find or create a user from the X-User-Email header */
async function devUserFromHeader(req: Request): Promise<AuthUser> {
  const email = String(req.header(DEV_EMAIL_HEADER) || "demo@local");
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        password: "dev", // placeholder; replace when you wire real auth
        name: email.split("@")[0],
      },
    });
  }
  return { id: user.id, email: user.email, name: user.name ?? null };
}

export async function auth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;

  // 1) Try Bearer JWT first
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      const u = await userFromJwtPayload(payload);
      if (u) {
        (req as any).user = u;
        return next();
      }
      // JWT valid but user missing in DB — in dev, auto-provision using payload.email
      if (ALLOW_HEADER_EMAIL && payload?.email) {
        const tempReq = {
          ...req,
          header: (name: string) => (name.toLowerCase() === DEV_EMAIL_HEADER ? payload.email : req.header(name)),
        } as Request;
        const u2 = await devUserFromHeader(tempReq);
        (req as any).user = u2;
        return next();
      }
      return res.status(401).json({ error: "User not found" });
    } catch {
      // fall through to dev header if allowed
    }
  }

  // 2) Dev fallback: X-User-Email
  if (ALLOW_HEADER_EMAIL) {
    try {
      const u = await devUserFromHeader(req);
      (req as any).user = u;
      return next();
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // 3) No auth
  return res.status(401).json({ error: "Unauthorized" });
}

// (Optional) Express typing augment so req.user is typed across your app
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
