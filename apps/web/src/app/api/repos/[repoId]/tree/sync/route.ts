import { HttpError, SyncTreeResponse, TreeParams } from '@app/shared';
import { requireRepoAccess } from '@/lib/server/access';
import { json, route } from '@/lib/server/http';
import { requireSession } from '@/server/auth';
import {
  requestInSlot,
  requestTreeSync,
  SYNC_RATE_WINDOW_SECONDS,
  syncKey,
  takeSlot,
} from '../sync-request';

export const dynamic = 'force-dynamic';

/** POST /api/repos/:repoId/tree/sync — view access; 1 per minute per repo (429 otherwise). */
export const POST = route<{ repoId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId } = TreeParams.parse(params);
  const repo = await requireRepoAccess(session.user.id, repoId);

  if (!(await takeSlot(syncKey(repoId), SYNC_RATE_WINDOW_SECONDS))) {
    throw new HttpError(
      'rate_limited',
      'This repository was refreshed less than a minute ago. Try again soon.',
    );
  }
  await requestInSlot(syncKey(repoId), () => requestTreeSync(repoId, repo.orgId, 'manual'));
  return json(SyncTreeResponse, { queued: true });
});
