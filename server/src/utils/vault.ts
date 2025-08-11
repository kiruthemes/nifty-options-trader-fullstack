// server/src/utils/vault.ts
import crypto from "crypto";

/**
 * Production-minded lightweight vault:
 * - AES-256-GCM encryption with key from env (VAULT_KEY or BROKER_SECRET_KEY)
 * - Forward compatible with plaintext already in DB:
 *   - decryptString() returns input if it's not an encrypted blob
 *   - maybeDecrypt() handles undefined/null safely
 * - Encrypted format: enc:v1:<ivHex>:<cipherHex>:<tagHex>
 */

const PREFIX = "enc:v1";

function getKey(): Buffer | null {
  const raw =
    process.env.VAULT_KEY ||
    process.env.BROKER_SECRET_KEY ||
    ""; // legacy env name fallback
  if (!raw) return null;

  // Accept base64 or hex or raw string (32 bytes).
  if (/^[A-Fa-f0-9]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  try {
    const b64 = Buffer.from(raw, "base64");
    if (b64.length === 32) return b64;
  } catch {}
  const buf = Buffer.from(raw, "utf8");
  return buf.length === 32 ? buf : null;
}

export function isEncrypted(s: unknown): s is string {
  return typeof s === "string" && s.startsWith(`${PREFIX}:`);
}

export function encryptString(plain: string): string {
  const key = getKey();
  if (!key) {
    // In production you SHOULD set VAULT_KEY. We still allow running locally without it.
    // If there is no key, store plaintext (explicitly).
    return plain;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${iv.toString("hex")}:${enc.toString("hex")}:${tag.toString("hex")}`;
}

export function decryptString(maybeEnc: string): string {
  if (!isEncrypted(maybeEnc)) return maybeEnc;
  const key = getKey();
  if (!key) {
    // Cannot decrypt without key — return as-is (caller should not crash)
    return maybeEnc;
  }
  const [, , ivHex, dataHex, tagHex] = maybeEnc.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

export function maybeEncrypt(v?: string | null): string | null | undefined {
  if (v == null || v === "") return v;
  return isEncrypted(v) ? v : encryptString(v);
}

export function maybeDecrypt(v?: string | null): string | null | undefined {
  if (v == null || v === "") return v;
  try {
    return decryptString(v);
  } catch {
    // if decryption fails, return original so callers don’t crash
    return v;
  }
}

/** Redact secrets for logs */
export function redact(s?: string | null, keep = 4): string {
  if (!s) return "";
  const plain = isEncrypted(s) ? "[encrypted]" : s;
  if (plain.length <= keep) return "*".repeat(plain.length);
  return `${plain.slice(0, keep)}…[redacted]`;
}

/** Convert a broker account row into decrypted secrets object (safe for adapters) */
export function getBrokerSecrets(acct: {
  clientId?: string | null;
  apiKey?: string | null;
  apiSecret?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  metaJson?: string | null;
}) {
  const meta =
    typeof acct.metaJson === "string" && acct.metaJson.trim()
      ? (JSON.parse(acct.metaJson) as Record<string, any>)
      : {};
  return {
    clientId: maybeDecrypt(acct.clientId) ?? undefined,
    apiKey: maybeDecrypt(acct.apiKey) ?? undefined,
    apiSecret: maybeDecrypt(acct.apiSecret) ?? undefined,
    accessToken: maybeDecrypt(acct.accessToken) ?? undefined,
    refreshToken: maybeDecrypt(acct.refreshToken) ?? undefined,
    meta,
  };
}
