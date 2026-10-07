import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API keys look like `ff_<prefix>_<secret>`: the prefix (8 characters) is stored in clear to find
 * the key and to show it in the admin screen; the whole key is stored only as a SHA-256 hash.
 * The secret is 32 random bytes, so a fast hash is enough (no brute-forcing a 256-bit secret).
 */
const KEY_RE = /^ff_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

export function generateApiKey(): { key: string; prefix: string; hash: Buffer } {
  const bytes = randomBytes(8);
  const prefix = Array.from(bytes, (b) => ALPHANUM[b % ALPHANUM.length]).join('');
  const key = `ff_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix, hash: hashApiKey(key) };
}

/** The prefix of a well-formed key, or null. */
export function apiKeyPrefix(key: string): string | null {
  return KEY_RE.exec(key)?.[1] ?? null;
}

export function apiKeyMatches(key: string, storedHash: Buffer): boolean {
  const h = hashApiKey(key);
  return h.length === storedHash.length && timingSafeEqual(h, storedHash);
}
