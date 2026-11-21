import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const valid = {
  NODE_ENV: 'development',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://app:app@localhost:5432/app',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
};

describe('parseEnv', () => {
  it('accepts the minimal dev env and treats empty strings as unset', () => {
    const env = parseEnv({ ...valid, GITHUB_APP_ID: '', ENCRYPTION_KEY: '' });
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toBeUndefined();
  });

  it('reports missing required vars by name without leaking values', () => {
    const secret = 'short-secret-value';
    let message = '';
    try {
      parseEnv({ ...valid, DATABASE_URL: undefined, BETTER_AUTH_SECRET: secret });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/BETTER_AUTH_SECRET/);
    expect(message).not.toContain(secret);
  });

  it('defaults REPO_CACHE_DIR when unset or empty', () => {
    expect(parseEnv(valid).REPO_CACHE_DIR).toBe('./.cache/repos');
    expect(parseEnv({ ...valid, REPO_CACHE_DIR: '' }).REPO_CACHE_DIR).toBe('./.cache/repos');
    expect(parseEnv({ ...valid, REPO_CACHE_DIR: '/data/repos' }).REPO_CACHE_DIR).toBe(
      '/data/repos',
    );
  });

  it('validates ENCRYPTION_KEY length', () => {
    expect(parseEnv({ ...valid, ENCRYPTION_KEY: randomBytes(32).toString('base64') })).toBeTruthy();
    expect(() =>
      parseEnv({ ...valid, ENCRYPTION_KEY: randomBytes(16).toString('base64') }),
    ).toThrow(/ENCRYPTION_KEY/);
  });

  it('requires GitHub, Inngest and encryption secrets in production', () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/INNGEST_SIGNING_KEY/);
    expect(
      parseEnv({
        ...valid,
        NODE_ENV: 'production',
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: 'pem',
        GITHUB_WEBHOOK_SECRET: 's',
        GITHUB_CLIENT_ID: 'id',
        GITHUB_CLIENT_SECRET: 'secret',
        INNGEST_EVENT_KEY: 'e',
        INNGEST_SIGNING_KEY: 's',
        ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      }).NODE_ENV,
    ).toBe('production');
  });
});
