import { prisma } from '@app/db';
import { generateIngestToken, hashToken, RepoParams, RotateIngestTokenResponse } from '@app/shared';
import { requireRepoWrite } from '@/lib/server/access';
import { route } from '@/lib/server/http';
import { requireSession } from '@/server/auth';
import { logger } from '@/server/logger';

/**
 * POST /api/repos/:repoId/ingest-token/rotate — org owner/admin or GitHub `write`+.
 * Only the hash is stored; the plain token is returned once and invalidates the previous one.
 */
export const POST = route<{ repoId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId } = RepoParams.parse(params);
  await requireRepoWrite(session.user.id, repoId);

  const token = generateIngestToken();
  await prisma.repo.update({ where: { id: repoId }, data: { ingestTokenHash: hashToken(token) } });
  logger.info({ repoId }, 'ingest token rotated');
  return Response.json(RotateIngestTokenResponse.parse({ token }), {
    headers: { 'cache-control': 'no-store' },
  });
});
