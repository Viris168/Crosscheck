import { HttpError } from '@app/shared';
import { beforeEach, expect, it, vi } from 'vitest';

const requireRepoAccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/access', () => ({ requireRepoAccess }));
vi.mock('@/lib/server/dashboard', () => ({
  getDashboardContext: async () => ({ session: { user: { id: 'u1' } } }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const { loadRepoForPage } = await import('./repo-header');

beforeEach(() => {
  requireRepoAccess.mockReset();
});

it('returns id + name for someone with access', async () => {
  requireRepoAccess.mockResolvedValue({ id: 'r1', fullName: 'acme/web', ingestTokenHash: 'x' });
  expect(await loadRepoForPage('r1')).toEqual({ id: 'r1', fullName: 'acme/web' });
  expect(requireRepoAccess).toHaveBeenCalledWith('u1', 'r1');
});

it.each(['not_found', 'forbidden'] as const)('%s → the 404 page', async (code) => {
  requireRepoAccess.mockRejectedValue(new HttpError(code, 'x'));
  await expect(loadRepoForPage('r1')).rejects.toThrow('NEXT_NOT_FOUND');
});

it('GitHub did not answer → an error, never the page', async () => {
  requireRepoAccess.mockRejectedValue(new HttpError('github_error', 'x'));
  await expect(loadRepoForPage('r1')).rejects.toThrow(HttpError);
});
