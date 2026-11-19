import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAuthenticated = vi.hoisted(() => vi.fn());
const getAppOctokit = vi.hoisted(() => vi.fn());
vi.mock('@app/github', () => ({ getAppOctokit }));
vi.mock('@/server/logger', () => ({ logger: { warn: vi.fn() } }));

const { getInstallUrl, resetInstallUrlCache } = await import('./install-url');

beforeEach(() => {
  resetInstallUrlCache();
  getAuthenticated.mockReset();
  getAppOctokit.mockReset().mockReturnValue({ rest: { apps: { getAuthenticated } } });
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

  it('returns null when the App credentials are not configured', async () => {
    getAppOctokit.mockImplementationOnce(() => {
      throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set');
    });
    expect(await getInstallUrl()).toBeNull();
  });
});
