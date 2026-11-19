/* eslint-disable @typescript-eslint/no-explicit-any -- fake Octokit */
import { ACTION_PROMPT_PLACEHOLDERS } from '@app/providers';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  REMOVE_BRANCH,
  SETUP_BRANCH,
  SETUP_PR_TITLE,
  WORKFLOW_PATH,
  openWorkflowPR,
  removeWorkflowPR,
  renderWorkflow,
  type ActionProvider,
} from './index';

const PUBLIC_URL = 'https://review.example.com/';
const PROVIDERS: ActionProvider[] = ['claude_action', 'codex_action'];

describe('renderWorkflow', () => {
  it.each(PROVIDERS)('%s matches snapshot', (provider) => {
    expect(
      renderWorkflow(provider, { publicUrl: PUBLIC_URL, model: 'test-model' }),
    ).toMatchSnapshot();
  });

  it.each(PROVIDERS)('%s parses as YAML with the required shape', (provider) => {
    const wf = parse(renderWorkflow(provider, { publicUrl: PUBLIC_URL }));
    expect(wf.on.pull_request.types).toEqual(['opened', 'synchronize', 'reopened']);
    expect(wf.concurrency).toEqual({
      group: 'ai-review-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    });
    const [checkout, agent, send] = wf.jobs.review.steps;
    expect(checkout.uses).toMatch(/^actions\/checkout@/);
    expect(checkout.with['fetch-depth']).toBe(0);
    expect(checkout.with['persist-credentials']).toBe(false);

    // Prompt from buildActionPrompt with the placeholders replaced by GitHub expressions.
    const prompt: string = agent.with.prompt;
    for (const ph of Object.values(ACTION_PROMPT_PLACEHOLDERS)) expect(prompt).not.toContain(ph);
    expect(prompt).toContain('${{ github.repository }}#${{ github.event.pull_request.number }}');
    expect(prompt).toContain('review.json');

    expect(send.if).toBe('always()');
    expect(send.env.INGEST_URL).toBe('https://review.example.com/api/ingest/review');
    expect(send.env.PLATFORM_INGEST_TOKEN).toBe('${{ secrets.PLATFORM_INGEST_TOKEN }}');
    expect(send.run).toContain('no_output');
    // No GitHub expressions inside the shell script (script-injection safe).
    expect(send.run).not.toContain('${{');
    // The agent never gets write access to PRs or contents.
    expect(wf.permissions.contents).toBe('read');
    expect(wf.permissions['pull-requests']).toBe('read');
  });

  it('claude uses claude-code-action with the OAuth token secret', () => {
    const wf = parse(
      renderWorkflow('claude_action', { publicUrl: PUBLIC_URL, model: 'm-1', maxTurns: 12 }),
    );
    const agent = wf.jobs.review.steps[1];
    expect(agent.uses).toBe('anthropics/claude-code-action@v1');
    expect(agent.with.claude_code_oauth_token).toBe('${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}');
    expect(agent.with.claude_args).toContain('--max-turns 12');
    expect(agent.with.claude_args).toContain('--model m-1');
    expect(JSON.stringify(wf)).not.toContain('OPENAI_API_KEY');
  });

  it('codex uses codex-action with the OpenAI key secret', () => {
    const wf = parse(renderWorkflow('codex_action', { publicUrl: PUBLIC_URL, model: 'gpt-x' }));
    const agent = wf.jobs.review.steps[1];
    expect(agent.uses).toBe('openai/codex-action@v1');
    expect(agent.with['openai-api-key']).toBe('${{ secrets.OPENAI_API_KEY }}');
    expect(agent.with.model).toBe('gpt-x');
    expect(JSON.stringify(wf)).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('omits the model when not given', () => {
    const wf = parse(renderWorkflow('claude_action', { publicUrl: PUBLIC_URL }));
    expect(wf.jobs.review.steps[1].with.claude_args).not.toContain('--model');
    const cx = parse(renderWorkflow('codex_action', { publicUrl: PUBLIC_URL }));
    expect(cx.jobs.review.steps[1].with.model).toBeUndefined();
  });

  it('rejects unsafe options', () => {
    expect(() => renderWorkflow('claude_action', { publicUrl: 'not a url' })).toThrow();
    expect(() => renderWorkflow('claude_action', { publicUrl: 'ftp://x.example' })).toThrow();
    expect(() =>
      renderWorkflow('claude_action', { publicUrl: 'https://x.example/?a=1' }),
    ).toThrow();
    expect(() =>
      renderWorkflow('claude_action', { publicUrl: PUBLIC_URL, model: 'm --dangerously' }),
    ).toThrow(/model/);
    expect(() => renderWorkflow('claude_action', { publicUrl: PUBLIC_URL, maxTurns: 0 })).toThrow();
    expect(() => renderWorkflow('platform' as ActionProvider, { publicUrl: PUBLIC_URL })).toThrow();
  });
});

// ---------------------------------------------------------------- PR helpers

function fakeOctokit(opts: { branchExists?: boolean; fileOn?: string[]; openPr?: boolean } = {}) {
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  const calls = {
    createRef: vi.fn(async () => {
      if (opts.branchExists) throw Object.assign(new Error('exists'), { status: 422 });
      return { data: {} };
    }),
    getContent: vi.fn(async ({ ref }: any) => {
      if (opts.fileOn?.includes(ref)) return { data: { type: 'file', sha: `sha-${ref}` } };
      throw notFound();
    }),
    createOrUpdateFileContents: vi.fn(async (_a: any) => ({ data: {} })),
    deleteFile: vi.fn(async (_a: any) => ({ data: {} })),
    list: vi.fn(async () => ({
      data: opts.openPr ? [{ html_url: 'https://github.com/acme/web/pull/3', number: 3 }] : [],
    })),
    create: vi.fn(async (_a: any) => ({
      data: { html_url: 'https://github.com/acme/web/pull/9', number: 9 },
    })),
  };
  const octokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        getContent: calls.getContent,
        createOrUpdateFileContents: calls.createOrUpdateFileContents,
        deleteFile: calls.deleteFile,
      },
      git: {
        getRef: async () => ({ data: { object: { sha: 'base-sha' } } }),
        createRef: calls.createRef,
      },
      pulls: { list: calls.list, create: calls.create },
    },
  } as any;
  return { octokit, calls };
}

describe('openWorkflowPR', () => {
  const yaml = renderWorkflow('claude_action', { publicUrl: PUBLIC_URL });

  it('creates the branch, commits the file and opens the PR', async () => {
    const { octokit, calls } = fakeOctokit();
    const res = await openWorkflowPR(octokit, 'acme/web', 'claude_action', yaml);
    expect(res).toEqual({ prUrl: 'https://github.com/acme/web/pull/9', prNumber: 9 });
    expect(calls.createRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: `refs/heads/${SETUP_BRANCH}`, sha: 'base-sha' }),
    );
    const put = calls.createOrUpdateFileContents.mock.calls[0]![0];
    expect(put).toMatchObject({
      owner: 'acme',
      repo: 'web',
      path: WORKFLOW_PATH,
      branch: SETUP_BRANCH,
    });
    expect(put.sha).toBeUndefined();
    expect(Buffer.from(put.content, 'base64').toString('utf8')).toBe(yaml);
    const pr = calls.create.mock.calls[0]![0];
    expect(pr).toMatchObject({ title: SETUP_PR_TITLE, head: SETUP_BRANCH, base: 'main' });
    expect(pr.body).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(pr.body).toContain('PLATFORM_INGEST_TOKEN');
  });

  it('codex PR body lists the OpenAI secret', async () => {
    const { octokit, calls } = fakeOctokit();
    await openWorkflowPR(octokit, 'acme/web', 'codex_action', 'x: 1\n');
    expect(calls.create.mock.calls[0]![0].body).toContain('OPENAI_API_KEY');
  });

  it('is idempotent: existing branch, file and PR are reused', async () => {
    const { octokit, calls } = fakeOctokit({
      branchExists: true,
      fileOn: [SETUP_BRANCH],
      openPr: true,
    });
    const res = await openWorkflowPR(octokit, 'acme/web', 'claude_action', yaml);
    expect(res.prNumber).toBe(3);
    expect(calls.createOrUpdateFileContents.mock.calls[0]![0].sha).toBe(`sha-${SETUP_BRANCH}`);
    expect(calls.create).not.toHaveBeenCalled();
  });

  it('maps GitHub failures to github_error', async () => {
    const { octokit } = fakeOctokit();
    octokit.rest.pulls.create = async () => {
      throw Object.assign(new Error('boom'), { status: 403 });
    };
    await expect(openWorkflowPR(octokit, 'acme/web', 'claude_action', yaml)).rejects.toMatchObject({
      code: 'github_error',
    });
  });
});

describe('removeWorkflowPR', () => {
  it('deletes the workflow on a branch and opens the removal PR', async () => {
    const { octokit, calls } = fakeOctokit({ fileOn: [REMOVE_BRANCH, 'main'] });
    const res = await removeWorkflowPR(octokit, 'acme/web');
    expect(res.prNumber).toBe(9);
    expect(calls.deleteFile.mock.calls[0]![0]).toMatchObject({
      path: WORKFLOW_PATH,
      branch: REMOVE_BRANCH,
      sha: `sha-${REMOVE_BRANCH}`,
    });
    expect(calls.create.mock.calls[0]![0].title).toBe('Remove AI review workflow');
  });

  it('throws when the workflow does not exist', async () => {
    const { octokit } = fakeOctokit();
    await expect(removeWorkflowPR(octokit, 'acme/web')).rejects.toMatchObject({
      code: 'github_error',
    });
  });
});
