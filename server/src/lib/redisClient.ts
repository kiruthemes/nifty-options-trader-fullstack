// Lazy import to avoid hard dependency in dev until installed
let client: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Redis = require('ioredis');
  const REDIS_URL = process.env.REDIS_URL || process.env.REDIS || 'redis://127.0.0.1:6379';
  client = new Redis(REDIS_URL);
  client.on('error', (e: any) => console.warn('[REDIS] error', (e && e.message) || e));
  client.on('connect', () => console.log('[REDIS] connected'));
} catch (e) {
  console.warn('[REDIS] connection failed (ioredis not installed or unreachable):', (e as any)?.message || e);
  client = null;
}

export default client;
