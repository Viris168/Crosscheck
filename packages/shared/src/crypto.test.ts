import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decrypt,
  encrypt,
  generateIngestToken,
  getEncryptionKey,
  hashToken,
  safeEqual,
} from './crypto';

const key = randomBytes(32);

describe('encrypt / decrypt', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('round-trips unicode text', () => {
    const plain = 'sk-token-✓-日本';
    const c = encrypt(plain, key);
    expect(c).not.toContain(plain);
    expect(c.startsWith('v1.')).toBe(true);
    expect(decrypt(c, key)).toBe(plain);
  });

  it('uses a random IV (same input → different ciphertext)', () => {
    expect(encrypt('x', key)).not.toBe(encrypt('x', key));
  });

  it('fails with the wrong key', () => {
    expect(() => decrypt(encrypt('x', key), randomBytes(32))).toThrow();
  });

  it('detects tampering', () => {
    const [v, iv, tag, ct] = encrypt('hello world', key).split('.') as [
      string,
      string,
      string,
      string,
    ];
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decrypt([v, iv, tag, flipped.toString('base64url')].join('.'), key)).toThrow();
  });

  it('rejects malformed input', () => {
    expect(() => decrypt('nope', key)).toThrow(/Invalid ciphertext/);
    expect(() => decrypt('v2.a.b.c', key)).toThrow(/Invalid ciphertext/);
  });

  it('reads ENCRYPTION_KEY from env by default', () => {
    vi.stubEnv('ENCRYPTION_KEY', key.toString('base64'));
    expect(decrypt(encrypt('env'))).toBe('env');
  });

  it('validates the key', () => {
    vi.stubEnv('ENCRYPTION_KEY', '');
    expect(() => getEncryptionKey()).toThrow(/not set/);
    expect(() => getEncryptionKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('ingest tokens', () => {
  it('generates rit_ + 32 random bytes base64url', () => {
    const t = generateIngestToken();
    expect(t).toMatch(/^rit_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t.slice(4), 'base64url')).toHaveLength(32);
    expect(generateIngestToken()).not.toBe(t);
  });

  it('hashes with sha256 hex', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('safeEqual', () => {
  it('compares strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
