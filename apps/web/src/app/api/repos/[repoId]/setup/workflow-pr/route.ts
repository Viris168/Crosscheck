import { prisma } from '@app/db';
import { HttpError, RepoParams, WorkflowPrRequest, WorkflowPrResponse } from '@app/shared';
import { ADMIN_ROLES, requireRepoAccess } from '@/lib/server/access';
import { json, readJson, route } from '@/lib/server/http';
import { openWorkflowPR } from '@/lib/stubs';
import { requireSession } from '@/server/auth';

/** POST /api/repos/:repoId/setup/workflow-pr { provider, model? } — opens a PR adding the Action. */
export const POST = route<{ repoId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId } = RepoParams.parse(params);
  const body = WorkflowPrRequest.parse(await readJson(req));
  const repo = await requireRepoAccess(session.user.id, repoId, ADMIN_ROLES);

  const installation = await prisma.installation.findUnique({ where: { id: repo.installationId } });
  if (!installation) throw new HttpError('not_found', 'GitHub App installation not found');

  const pr = await openWorkflowPR({
    githubInstallationId: installation.githubInstallationId,
    repoFullName: repo.fullName,
    provider: body.provider,
    ...(body.model ? { model: body.model } : {}),
  });
  return json(WorkflowPrResponse, pr, { status: 201 });
});
