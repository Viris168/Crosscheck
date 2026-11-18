import { prisma } from '@app/db';
import {
  GetRepoSettingsResponse,
  PutRepoSettingsRequest,
  PutRepoSettingsResponse,
  RepoParams,
} from '@app/shared';
import { ADMIN_ROLES, requireRepoAccess } from '@/lib/server/access';
import { json, readJson, route } from '@/lib/server/http';
import { settingsOf } from '@/lib/server/serialize';
import { requireSession } from '@/server/auth';
import { logger } from '@/server/logger';

export const dynamic = 'force-dynamic';

/** GET /api/repos/:repoId/settings — any member. */
export const GET = route<{ repoId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId } = RepoParams.parse(params);
  const repo = await requireRepoAccess(session.user.id, repoId);
  return json(GetRepoSettingsResponse, {
    repoId: repo.id,
    provider: repo.provider,
    settings: settingsOf(repo.settings),
    hasIngestToken: repo.ingestTokenHash != null,
  });
});

/** PUT /api/repos/:repoId/settings — full replacement; owners and admins only. */
export const PUT = route<{ repoId: string }>(async (req, params) => {
  const { repoId } = RepoParams.parse(params);
  const body = PutRepoSettingsRequest.parse(await readJson(req));
  const session = await requireSession(req);
  await requireRepoAccess(session.user.id, repoId, ADMIN_ROLES);

  const repo = await prisma.repo.update({
    where: { id: repoId },
    data: { provider: body.provider, settings: body.settings },
  });
  logger.info({ repoId, provider: body.provider }, 'repo settings updated');
  return json(PutRepoSettingsResponse, {
    repoId: repo.id,
    provider: repo.provider,
    settings: settingsOf(repo.settings),
    hasIngestToken: repo.ingestTokenHash != null,
  });
});
