import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAuthenticated = vi.hoisted(() => vi.fn());
vi.mock('@app/github', () => ({
  getAppOctokit: () => ({ rest: { apps: { getAuthenticated } } }),
}));
vi.mock('@/server/logger', () => ({ logger: { warn: vi.fn() } }));

const { getInstallUrl, resetInstallUrlCache } = await import('./install-url');

beforeEach(() => {
  resetInstallUrlCache();
  getAuthenticated.mockReset();
});

describe('getInstallUrl', () => {
  it("builds GitHub's install page from the App slug, once", async () => {
    getAuthenticated.mockResolvedValue({ data: { slug: 'crosscheck-review' } });
    expect(await getInstallUrl()).toBe(
      'https://github.com/apps/crosscheck-review/installations/new',
    );
    await getInstallUrl();
    expect(getAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('returns null on failure and tries again next time', async () => {
    getAuthenticated.mockRejectedValueOnce(new Error('GITHUB_APP_ID must be set'));
    expect(await getInstallUrl()).toBeNull();
    getAuthenticated.mockResolvedValue({ data: { slug: 'app' } });
    expect(await getInstallUrl()).toBe('https://github.com/apps/app/installations/new');
  });

  it('returns null when GitHub sends no slug', async () => {
    getAuthenticated.mockResolvedValue({ data: null });
    expect(await getInstallUrl()).toBeNull();
  });
});
