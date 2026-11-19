import { ACTION_OUTPUT_FILE, ACTION_PROMPT_PLACEHOLDERS, buildActionPrompt } from '@app/providers';
import { Document } from 'yaml';

export type ActionProvider = 'claude_action' | 'codex_action';

export interface RenderOptions {
  /** Platform base URL, e.g. `https://review.example.com`. The Action POSTs to `/api/ingest/review`. */
  publicUrl: string;
  /** Model passed to the agent (Claude: `--model`, Codex: `model`). Omitted → the action's default. */
  model?: string;
  /** Claude only: `--max-turns`. Default 30. */
  maxTurns?: number;
}

export const WORKFLOW_PATH = '.github/workflows/ai-review.yml';
export const DEFAULT_MAX_TURNS = 30;

/** Secrets the user adds in GitHub → Settings → Secrets and variables → Actions. */
export const REQUIRED_SECRETS: Record<ActionProvider, readonly { name: string; how: string }[]> = {
  claude_action: [
    {
      name: 'CLAUDE_CODE_OAUTH_TOKEN',
      how: 'run `claude setup-token` locally (needs a Claude Pro/Max/Team/Enterprise plan) and paste the token',
    },
    { name: 'PLATFORM_INGEST_TOKEN', how: 'the ingest token shown once in the repo settings on the platform' },
  ],
  codex_action: [
    { name: 'OPENAI_API_KEY', how: 'an OpenAI API key from platform.openai.com' },
    { name: 'PLATFORM_INGEST_TOKEN', how: 'the ingest token shown once in the repo settings on the platform' },
  ],
};

// GitHub expressions substituted into the prompt. They go into an action *input* (not a shell
// `run:`), so a PR's branch name can't inject shell commands.
const EXPR = {
  repo: '${{ github.repository }}',
  prNumber: '${{ github.event.pull_request.number }}',
  headSha: '${{ github.event.pull_request.head.sha }}',
  baseRef: '${{ github.event.pull_request.base.ref }}',
} as const;

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

function validate(opts: RenderOptions): { ingestUrl: string; model?: string; maxTurns: number } {
  let url: URL;
  try {
    url = new URL(opts.publicUrl);
  } catch {
    throw new Error(`publicUrl is not a valid URL: ${JSON.stringify(opts.publicUrl)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('publicUrl must be http(s)');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error('publicUrl must not contain a query, fragment or credentials');
  }
  const base = url.toString().replace(/\/+$/, '');

  // Model ends up in CLI args; allow only plain model-id characters.
  if (opts.model !== undefined && !MODEL_RE.test(opts.model)) {
    throw new Error(`Invalid model id: ${JSON.stringify(opts.model)}`);
  }
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 200) {
    throw new Error('maxTurns must be an integer from 1 to 200');
  }
  return { ingestUrl: `${base}/api/ingest/review`, model: opts.model, maxTurns };
}

/** `buildActionPrompt()` (lane C) with its placeholders replaced by GitHub expressions. */
export function renderPrompt(): string {
  const p = ACTION_PROMPT_PLACEHOLDERS;
  return buildActionPrompt({ schemaVersion: 1 })
    .replaceAll(p.repo, EXPR.repo)
    .replaceAll(p.prNumber, EXPR.prNumber)
    .replaceAll(p.headSha, EXPR.headSha)
    .replaceAll(p.baseRef, EXPR.baseRef);
}

// The POST step. Values reach the script only through `env:` (never `${{ }}` inside `run:`).
// review.json missing / empty / not JSON → `{"error":"no_output", …}` so the review fails fast
// instead of waiting 30 minutes for the sweep.
const SEND_SCRIPT = `set -euo pipefail
if [ -z "\${PLATFORM_INGEST_TOKEN:-}" ]; then
  echo "::warning::PLATFORM_INGEST_TOKEN is not set (or this is a fork PR); result not sent."
  exit 0
fi
if [ -s ${ACTION_OUTPUT_FILE} ] && jq -e 'type == "object"' ${ACTION_OUTPUT_FILE} > /dev/null 2>&1; then
  payload=${ACTION_OUTPUT_FILE}
else
  echo "::warning::${ACTION_OUTPUT_FILE} missing or not valid JSON; reporting no_output."
  jq -n --arg repo "$REPO" --argjson pr "$PR_NUMBER" --arg sha "$HEAD_SHA" \\
    '{error: "no_output", repo: $repo, pr_number: $pr, head_sha: $sha}' > ai-review-no-output.json
  payload=ai-review-no-output.json
fi
curl --fail-with-body --silent --show-error --retry 3 --retry-all-errors --max-time 60 \\
  -X POST "$INGEST_URL" \\
  -H "Authorization: Bearer $PLATFORM_INGEST_TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary "@$payload"
`;

function agentStep(provider: ActionProvider, model: string | undefined, maxTurns: number) {
  const prompt = renderPrompt();
  if (provider === 'claude_action') {
    const args = [
      `--max-turns ${maxTurns}`,
      ...(model ? [`--model ${model}`] : []),
      // Read-only git/gh plus writing review.json. No Edit, no push, no comment tools.
      `--allowedTools "Read,Grep,Glob,Write,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(gh pr view:*)"`,
    ];
    return {
      name: 'Review with Claude',
      uses: 'anthropics/claude-code-action@v1',
      with: {
        claude_code_oauth_token: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
        prompt,
        claude_args: args.join('\n') + '\n',
      },
    };
  }
  return {
    name: 'Review with Codex',
    uses: 'openai/codex-action@v1',
    with: {
      'openai-api-key': '${{ secrets.OPENAI_API_KEY }}',
      prompt,
      ...(model ? { model } : {}),
      // Lets Codex write review.json in the checkout; no network.
      'permission-profile': ':workspace',
    },
  };
}

const HEADER: Record<ActionProvider, string> = {
  claude_action: 'Claude Code (your Claude plan)',
  codex_action: 'Codex (your OpenAI API key)',
};

const VERIFY_NOTES: Record<ActionProvider, string[]> = {
  claude_action: [
    'VERIFY: claude-code-action@v1 inputs `claude_code_oauth_token`, `prompt`, `claude_args`',
    '        (--max-turns / --model / --allowedTools), per its docs/usage.md.',
    'VERIFY: `id-token: write` is needed for the action to exchange an OIDC token for its GitHub App token.',
    'VERIFY: automation mode (a `prompt` is set) posts no tracking comment unless `track_progress: true`.',
  ],
  codex_action: [
    'VERIFY: codex-action@v1 inputs `openai-api-key`, `prompt`, `model`, `permission-profile`',
    '        (`:workspace` needs Codex CLI >= 0.138), per its action.yml.',
    'VERIFY: `:workspace` has no network, so `gh pr view` in the prompt fails; Codex still reviews the diff.',
  ],
};

/** The workflow YAML the user commits as `.github/workflows/ai-review.yml`. */
export function renderWorkflow(provider: ActionProvider, opts: RenderOptions): string {
  if (provider !== 'claude_action' && provider !== 'codex_action') {
    throw new Error(`Not an Action provider: ${String(provider)}`);
  }
  const { ingestUrl, model, maxTurns } = validate(opts);

  const permissions: Record<string, string> = { contents: 'read', 'pull-requests': 'read' };
  if (provider === 'claude_action') permissions['id-token'] = 'write';

  const workflow = {
    name: 'AI review',
    on: { pull_request: { types: ['opened', 'synchronize', 'reopened'] } },
    concurrency: {
      group: 'ai-review-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    },
    permissions,
    jobs: {
      review: {
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': 30,
        steps: [
          {
            uses: 'actions/checkout@v5',
            with: {
              ref: EXPR.headSha,
              'fetch-depth': 0,
              'persist-credentials': false,
            },
          },
          agentStep(provider, model, maxTurns),
          {
            name: 'Send result to the review platform',
            if: 'always()',
            env: {
              PLATFORM_INGEST_TOKEN: '${{ secrets.PLATFORM_INGEST_TOKEN }}',
              INGEST_URL: ingestUrl,
              REPO: EXPR.repo,
              PR_NUMBER: EXPR.prNumber,
              HEAD_SHA: EXPR.headSha,
            },
            run: SEND_SCRIPT,
          },
        ],
      },
    },
  };

  const doc = new Document(workflow);
  doc.commentBefore = [
    ` AI code review — ${HEADER[provider]}.`,
    ' Generated by the AI Code Review platform. The agent writes review.json only and never',
    ' comments on the PR; the platform posts the review. Your keys stay in GitHub secrets.',
    '',
    ' Required repository secrets:',
    ...REQUIRED_SECRETS[provider].map((s) => `   ${s.name}`),
    '',
    ...VERIFY_NOTES[provider].map((n) => ` ${n}`),
  ].join('\n');
  return doc.toString({ lineWidth: 0 });
}
