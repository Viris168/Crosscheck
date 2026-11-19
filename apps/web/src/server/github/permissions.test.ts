import { ProviderError } from '@app/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------- mocks

const h = vi.hoisted(() => ({
  store: new Map<string, { value: string; ttl: number }>(),
  redisDown: { value: false },
  setCalls: [] as unknown[][],
  getInstallationOctokit: vi.fn(async (_id: number) => ({ fake: 'octokit' })),
  fetchRepoPermission: vi.fn(),
}));

vi.mock('@/server/redis', () => ({
  getRedis: () => ({
    get: async (key: string) => {
      if (h.redisDown.value) throw new Error('ECONNREFUSED');
      return h.store.get(key)?.value ?? null;
    },
    set: async (...args: unknown[]) => {
      if (h.redisDown.value) throw new Error('ECONNREFUSED');
      h.setCalls.push(args);
      const [key, value, , ttl] = args as [string, string, string, number];
      h.store.set(key, { value, ttl });
      return 'OK';
    },
    del: async (key: string) => {
      if (h.redisDown.value) throw new Error('ECONNREFUSED');
      return h.store.delete(key) ? 1 : 0;
    },
  }),
}));
vi.mock('@/server/logger', () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { logger };
});
vi.mock('@app/github', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getInstallationOctokit: h.getInstallationOctokit,
  fetchRepoPermission: h.fetchRepoPermission,
}));

const { getRepoPermission, invalidateRepoPermission, permissionAtLeast } = await import('./index');

const input = { githubInstallationId: 7, githubRepoId: 42, fullName: 'acme/web', login: 'Octo' };
const KEY = 'gh:perm:42:octo';

beforeEach(() => {
  h.store.clear();
  h.setCalls.length = 0;
  h.redisDown.value = false;
  h.getInstallationOctokit.mockClear();
  h.fetchRepoPermission.mockReset();
});

describe('getRepoPermission', () => {
  it('on a cache miss asks GitHub with the installation token and caches for 300s', async () => {
    h.fetchRepoPermission.mockResolvedValue('write');
    await expect(getRepoPermission(input)).resolves.toBe('write');
    expect(h.getInstallationOctokit).toHaveBeenCalledWith(7);
    expect(h.fetchRepoPermission).toHaveBeenCalledWith({ fake: 'octokit' }, 'acme/web', 'Octo');
    expect(h.setCalls).toEqual([[KEY, 'write', 'EX', 300]]);
  });

  it('on a cache hit does not call GitHub', async () => {
    h.store.set(KEY, { value: 'maintain', ttl: 300 });
    await expect(getRepoPermission(input)).resolves.toBe('maintain');
    expect(h.fetchRepoPermission).not.toHaveBeenCalled();
    expect(h.getInstallationOctokit).not.toHaveBeenCalled();
  });

  it('keys the cache by lower-cased login', async () => {
    h.fetchRepoPermission.mockResolvedValue('read');
    await getRepoPermission(input);
    await expect(getRepoPermission({ ...input, login: 'OCTO' })).resolves.toBe('read');
    expect(h.fetchRepoPermission).toHaveBeenCalledTimes(1);
  });

  it("caches 'none' too", async () => {
    h.fetchRepoPermission.mockResolvedValue('none');
    await expect(getRepoPermission(input)).resolves.toBe('none');
    await expect(getRepoPermission(input)).resolves.toBe('none');
    expect(h.fetchRepoPermission).toHaveBeenCalledTimes(1);
    expect(h.store.get(KEY)).toEqual({ value: 'none', ttl: 300 });
  });

  it('ignores a garbage cache value and asks GitHub', async () => {
    h.store.set(KEY, { value: 'superuser', ttl: 300 });
    h.fetchRepoPermission.mockResolvedValue('read');
    await expect(getRepoPermission(input)).resolves.toBe('read');
    expect(h.fetchRepoPermission).toHaveBeenCalledTimes(1);
  });

  it('never caches an error and rethrows it', async () => {
    const err = new ProviderError('github_error', 'GitHub API error (500)');
    h.fetchRepoPermission.mockRejectedValueOnce(err);
    await expect(getRepoPermission(input)).rejects.toBe(err);
    expect(h.store.has(KEY)).toBe(false);

    h.fetchRepoPermission.mockResolvedValueOnce('admin');
    await expect(getRepoPermission(input)).resolves.toBe('admin');
  });

  it('rethrows when the installation token cannot be created', async () => {
    h.getInstallationOctokit.mockRejectedValueOnce(new Error('bad key'));
    await expect(getRepoPermission(input)).rejects.toThrow('bad key');
    expect(h.store.has(KEY)).toBe(false);
  });

  it('when Redis is down, skips the cache and calls GitHub directly', async () => {
    h.redisDown.value = true;
    h.fetchRepoPermission.mockResolvedValue('triage');
    await expect(getRepoPermission(input)).resolves.toBe('triage');
    await expect(getRepoPermission(input)).resolves.toBe('triage');
    expect(h.fetchRepoPermission).toHaveBeenCalledTimes(2);
  });
});

describe('invalidateRepoPermission', () => {
  it('drops the cached entry (case-insensitive login)', async () => {
    h.store.set(KEY, { value: 'write', ttl: 300 });
    await invalidateRepoPermission(42, 'OCTO');
    expect(h.store.has(KEY)).toBe(false);

    h.fetchRepoPermission.mockResolvedValue('none');
    await expect(getRepoPermission(input)).resolves.toBe('none');
    expect(h.fetchRepoPermission).toHaveBeenCalledTimes(1);
  });

  it('does not throw when Redis is down', async () => {
    h.redisDown.value = true;
    await expect(invalidateRepoPermission(42, 'octo')).resolves.toBeUndefined();
  });
});

describe('re-exports', () => {
  it('exposes permissionAtLeast from @/server/github', () => {
    expect(permissionAtLeast('write', 'read')).toBe(true);
    expect(permissionAtLeast('triage', 'write')).toBe(false);
  });
});
