import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';

app.use(cors()); // in prod, tighten origin
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

function sign(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// Health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Auth
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email & password required' });
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return res.status(409).json({ error: 'email already registered' });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { email, passwordHash } });
  return res.json({ token: sign(user), user: { id: user.id, email: user.email } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  return res.json({ token: sign(user), user: { id: user.id, email: user.email } });
});

// Strategies
app.get('/api/strategies', auth, async (req, res) => {
  const includeArchived = String(req.query.includeArchived || '0') === '1';
  const items = await prisma.strategy.findMany({
    where: { userId: req.user.sub, ...(includeArchived ? {} : { archived: false }) },
    orderBy: { updatedAt: 'desc' }
  });
  res.json(items.map(({ id, name, archived, updatedAt, createdAt }) => ({ id, name, archived, updatedAt, createdAt })));
});

app.post('/api/strategies', auth, async (req, res) => {
  const { name } = req.body || {};
  const s = await prisma.strategy.create({
    data: { name: name || 'Untitled Strategy', userId: req.user.sub, state: {} }
  });
  res.json({ id: s.id });
});

app.get('/api/strategies/:id', auth, async (req, res) => {
  const s = await prisma.strategy.findFirst({ where: { id: req.params.id, userId: req.user.sub } });
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

app.put('/api/strategies/:id', auth, async (req, res) => {
  const { name, archived } = req.body || {};
  const s = await prisma.strategy.update({
    where: { id: req.params.id },
    data: {
      ...(name != null ? { name } : {}),
      ...(archived != null ? { archived: !!archived } : {})
    }
  }).catch(() => null);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.put('/api/strategies/:id/state', auth, async (req, res) => {
  const state = req.body || {};
  const s = await prisma.strategy.update({
    where: { id: req.params.id },
    data: { state }
  }).catch(() => null);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.delete('/api/strategies/:id', auth, async (req, res) => {
  await prisma.strategy.delete({ where: { id: req.params.id } }).catch(() => null);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API on http://localhost:${PORT}`);
});
