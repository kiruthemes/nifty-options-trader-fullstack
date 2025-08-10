import { Router, Request, Response } from "express";
import prisma from "../db";
import bcrypt from "bcryptjs";
import { signJwt } from "../middleware/auth";

const router = Router();

router.post("/register", async (req: Request, res: Response) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email & password required" });

  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return res.status(409).json({ error: "email already registered" });

  // hash and store in the `password` column (schema has `password String`)
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, password: passwordHash, name: name || null },
  });

  return res.json({
    token: signJwt({ id: user.id, email: user.email, name: user.name || undefined }),
    user: { id: user.id, email: user.email, name: user.name || undefined },
  });
});

router.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email & password required" });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  // compare with the `password` column (stores the bcrypt hash)
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  return res.json({
    token: signJwt({ id: user.id, email: user.email, name: user.name || undefined }),
    user: { id: user.id, email: user.email, name: user.name || undefined },
  });
});

export default router;
