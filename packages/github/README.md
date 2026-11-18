# @app/github

GitHub App auth + fetch helpers (lane A). Server-only (uses `node:crypto`).

```ts
import {
  getInstallationOctokit,
  fetchPullRequest,
  fetchPullRequestFiles,
  fetchFileText,
  splitFullName,
} from '@app/github';

const octokit = await getInstallationOctokit(repo.installation.githubInstallationId);
const { owner, repo: name } = splitFullName(repo.fullName);
const pr = await fetchPullRequest(octokit, owner, name, 12);
const files = await fetchPullRequestFiles(octokit, owner, name, 12);
const rules = await fetchFileText(octokit, owner, name, 'AGENTS.md', pr.headSha);
```

## Config

Reads from `process.env`:

| Var | Notes |
|---|---|
| `GITHUB_APP_ID` | App id |
| `GITHUB_APP_PRIVATE_KEY` | PEM. A single line with literal `\n` escapes is accepted. |

The webhook secret is passed explicitly to `verifyWebhookSignature`.

## API

| Export | Description |
|---|---|
| `getInstallationOctokit(installationId): Promise<Octokit>` | Octokit authenticated as one installation. Cached per installation until 5 min before the token expires (tokens live 1 h). Concurrent callers share one token request; a failed request is not cached. |
| `getAppOctokit(): Octokit` | Octokit authenticated as the App (JWT), for `/app/*` endpoints. Singleton. |
| `fetchPullRequest(octokit, owner, repo, number): Promise<PrMeta>` | PR metadata: title, body (`''` if none), author, state, merged, draft, head/base sha + ref, additions/deletions/changedFiles. |
| `fetchPullRequestFiles(octokit, owner, repo, number): Promise<ReviewFile[]>` | Every changed file, 100 per page, capped at 3000 (GitHub's limit). Status is mapped to `added \| modified \| removed \| renamed` (`copied` → `added`, `changed` → `modified`). Files without a patch (binary / too large) get `patch: ''`. |
| `fetchFileText(octokit, owner, repo, path, ref): Promise<string \| null>` | UTF-8 text of one file at `ref`; `null` for 404, directories, and files > 1 MB. |
| `verifyWebhookSignature(rawBody, signatureHeader, secret): boolean` | Checks `X-Hub-Signature-256` (`sha256=<hex>`) with `crypto.timingSafeEqual`. `false` (never throws) for a missing/malformed header or empty secret. Pass the **raw** body bytes. |
| `splitFullName(fullName): { owner, repo }` | `"acme/web"` → `{ owner: 'acme', repo: 'web' }`; throws otherwise. |

Also exported: `Octokit` (class + type, REST + retry + throttling plugins), `createOctokit(options)`,
`PrMeta`, `MAX_PR_FILES`, `toGithubError`, `readAppCredentials`, `signWebhookBody` (tests/tooling), and
test helpers `resetGithubClients`, `setInstallationAuthForTesting`.

## Errors

Every GitHub API failure from the fetch helpers is thrown as `ProviderError('github_error', …)` from
`@app/shared`. Messages carry the HTTP status and the endpoint only — never tokens or response bodies.

## Retries + rate limits

`@octokit/plugin-retry` retries transient 5xx failures. `@octokit/plugin-throttling` waits and retries on
primary and secondary rate limits, up to 2 times, then fails (→ `github_error`).

## Tests

`pnpm turbo test --filter @app/github`. HTTP is mocked with msw.
