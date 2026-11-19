import { splitFullName, toGithubError, type Octokit } from '@app/github';
import { REQUIRED_SECRETS, WORKFLOW_PATH, type ActionProvider } from './render';

export const SETUP_BRANCH = 'ai-review/setup';
export const REMOVE_BRANCH = 'ai-review/remove';
export const SETUP_PR_TITLE = 'Add AI review workflow';
export const REMOVE_PR_TITLE = 'Remove AI review workflow';

export interface WorkflowPrResult {
  prUrl: string;
  prNumber: number;
}

function statusOf(err: unknown): number | undefined {
  return err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
    ? err.status
    : undefined;
}

/** Runs one GitHub call; any failure becomes `ProviderError('github_error')` (no tokens or bodies). */
async function gh<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toGithubError(err, what);
  }
}

/** Creates `branch` from the default branch, or reuses it if it already exists. */
async function ensureBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ base: string }> {
  const { data: info } = await gh('repos.get', () => octokit.rest.repos.get({ owner, repo }));
  const base = info.default_branch;
  const { data: ref } = await gh('git.getRef', () =>
    octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` }),
  );
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: ref.object.sha,
    });
  } catch (err) {
    // 422 "Reference already exists" → reuse the branch (e.g. a second click on "Commit workflow").
    if (statusOf(err) !== 422) throw toGithubError(err, 'git.createRef');
  }
  return { base };
}

/** Blob sha of `path` on `branch`, or undefined if the file does not exist there. */
async function fileSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
    return !Array.isArray(data) && data.type === 'file' ? data.sha : undefined;
  } catch (err) {
    if (statusOf(err) === 404) return undefined;
    throw toGithubError(err, 'repos.getContent');
  }
}

/** Reuses an open PR from `branch` if there is one, otherwise opens a new one. */
async function openOrReusePr(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  base: string,
  title: string,
  body: string,
): Promise<WorkflowPrResult> {
  const { data: open } = await gh('pulls.list', () =>
    octokit.rest.pulls.list({ owner, repo, state: 'open', head: `${owner}:${branch}`, base }),
  );
  const existing = open[0];
  if (existing) return { prUrl: existing.html_url, prNumber: existing.number };
  const { data: pr } = await gh('pulls.create', () =>
    octokit.rest.pulls.create({ owner, repo, title, head: branch, base, body }),
  );
  return { prUrl: pr.html_url, prNumber: pr.number };
}

export function setupPrBody(provider: ActionProvider): string {
  const secrets = REQUIRED_SECRETS[provider]
    .map((s) => `- \`${s.name}\` — ${s.how}`)
    .join('\n');
  return [
    `This PR adds \`${WORKFLOW_PATH}\`, which reviews every pull request with ${
      provider === 'claude_action' ? 'Claude Code' : 'Codex'
    } inside **your own** GitHub Actions and sends the result to the AI review platform.`,
    '',
    '### Before merging, add these repository secrets',
    'GitHub → **Settings → Secrets and variables → Actions → New repository secret**:',
    '',
    secrets,
    '',
    'Your Claude / OpenAI credentials stay in GitHub secrets; the platform never receives them.',
    'Only the review result (`review.json`) is sent, authenticated with `PLATFORM_INGEST_TOKEN`.',
    '',
    'Note: GitHub does not pass secrets to workflows triggered from forks, so PRs from forks are not reviewed.',
  ].join('\n');
}

/**
 * Commits `yaml` to `.github/workflows/ai-review.yml` on branch `ai-review/setup` and opens
 * (or reuses) the PR "Add AI review workflow". Safe to call twice.
 */
export async function openWorkflowPR(
  octokit: Octokit,
  fullName: string,
  provider: ActionProvider,
  yaml: string,
): Promise<WorkflowPrResult> {
  const { owner, repo } = splitFullName(fullName);
  const { base } = await ensureBranch(octokit, owner, repo, SETUP_BRANCH);
  const sha = await fileSha(octokit, owner, repo, WORKFLOW_PATH, SETUP_BRANCH);
  await gh('repos.createOrUpdateFileContents', () =>
    octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: WORKFLOW_PATH,
      branch: SETUP_BRANCH,
      message: 'ci: add AI review workflow',
      content: Buffer.from(yaml, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  );
  return openOrReusePr(octokit, owner, repo, SETUP_BRANCH, base, SETUP_PR_TITLE, setupPrBody(provider));
}

/**
 * Deletes `.github/workflows/ai-review.yml` on branch `ai-review/remove` and opens (or reuses)
 * the PR "Remove AI review workflow". Throws `github_error` if the file isn't there.
 */
export async function removeWorkflowPR(
  octokit: Octokit,
  fullName: string,
): Promise<WorkflowPrResult> {
  const { owner, repo } = splitFullName(fullName);
  const { base } = await ensureBranch(octokit, owner, repo, REMOVE_BRANCH);
  const sha = await fileSha(octokit, owner, repo, WORKFLOW_PATH, REMOVE_BRANCH);
  if (sha) {
    await gh('repos.deleteFile', () =>
      octokit.rest.repos.deleteFile({
        owner,
        repo,
        path: WORKFLOW_PATH,
        branch: REMOVE_BRANCH,
        message: 'ci: remove AI review workflow',
        sha,
      }),
    );
  } else {
    // Already deleted on this branch (earlier call) is fine if a PR exists; otherwise nothing to remove.
    const onBase = await fileSha(octokit, owner, repo, WORKFLOW_PATH, base);
    if (!onBase) throw toGithubError(new Error('not found'), `${WORKFLOW_PATH} not found`);
  }
  return openOrReusePr(
    octokit,
    owner,
    repo,
    REMOVE_BRANCH,
    base,
    REMOVE_PR_TITLE,
    `This PR removes \`${WORKFLOW_PATH}\`, turning off AI reviews in GitHub Actions for this repository.\n\nYou can also delete the \`CLAUDE_CODE_OAUTH_TOKEN\` / \`OPENAI_API_KEY\` and \`PLATFORM_INGEST_TOKEN\` secrets afterwards.`,
  );
}
