import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// Server-only helpers (node:crypto). Never import from client components.

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

/** Decodes a base64 (or base64url) 32-byte key. Defaults to process.env.ENCRYPTION_KEY. */
export function getEncryptionKey(raw: string | undefined = process.env.ENCRYPTION_KEY): Buffer {
  if (!raw) throw new Error('ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

/** AES-256-GCM. Output: `v1.<iv>.<tag>.<ciphertext>` (base64url parts). */
export function encrypt(plain: string, key: Buffer = getEncryptionKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decrypt(cipherText: string, key: Buffer = getEncryptionKey()): string {
  const parts = cipherText.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Invalid ciphertext format');
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export const INGEST_TOKEN_PREFIX = 'rit_';

/** `rit_` + 32 random bytes base64url. Shown to the user once; only its hash is stored. */
export function generateIngestToken(): string {
  return INGEST_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** sha256 hex. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time string compare (compares sha256 digests so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}
