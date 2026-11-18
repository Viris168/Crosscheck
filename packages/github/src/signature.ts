import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/**
 * Verifies GitHub's `X-Hub-Signature-256` header (`sha256=<hex HMAC of the raw body>`).
 * Timing-safe; returns false for a missing/malformed header or empty secret.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!secret || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith(PREFIX)) return false;
  const hex = signatureHeader.slice(PREFIX.length);
  if (!HEX_SHA256.test(hex)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(hex, 'hex');
  // Both are 32 bytes here (regex above), so timingSafeEqual never throws.
  return timingSafeEqual(expected, received);
}

/** Builds a signature header for `rawBody` (tests, local tooling). */
export function signWebhookBody(rawBody: Buffer | string, secret: string): string {
  return PREFIX + createHmac('sha256', secret).update(rawBody).digest('hex');
}
