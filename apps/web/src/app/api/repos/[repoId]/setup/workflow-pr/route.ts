import { RepoParams, WorkflowPrRequest, WorkflowPrResponse } from '@app/shared';
import { requireRepoWrite } from '@/lib/server/access';
import { getInstallationOctokit } from '@app/github';
import { openWorkflowPR, renderWorkflow } from '@app/workflow-templates';
import { json, readJson, route } from '@/lib/server/http';
import { requireSession } from '@/server/auth';
import { env } from '@/server/env';

/** POST /api/repos/:repoId/setup/workflow-pr { provider, model? } — opens a PR adding the Action.
 * Org owner/admin or GitHub `write`+. */
export const POST = route<{ repoId: string }>(async (req, params) => {
  const session = await requireSession(req);
  const { repoId } = RepoParams.parse(params);
  const body = WorkflowPrRequest.parse(await readJson(req));
  const repo = await requireRepoWrite(session.user.id, repoId);

  const yaml = renderWorkflow(body.provider, {
    publicUrl: env.PUBLIC_URL,
    ...(body.model ? { model: body.model } : {}),
  });
  const octokit = await getInstallationOctokit(repo.installation.githubInstallationId);
  const pr = await openWorkflowPR(octokit, repo.fullName, body.provider, yaml);
  return json(WorkflowPrResponse, pr, { status: 201 });
});
