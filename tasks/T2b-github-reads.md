# T2b — GitHub reads for the tree (Lane A, milestone 2)

**Wave 2** · **Branch:** `feat/t2b-github-reads` · **Lane:** A · **Needs merged:** T0
**Spec:** `tasks/T-branch-tree.md` → "CI state", "Merged-state rules" (VERIFY note), "Privacy rules" (token use).

## You own (edit only these)
- `packages/github/src/tree.ts` (new) + `tree.test.ts`, `packages/github/src/index.ts` (exports only)

## Do
Add and export from `@app/github`:
```ts
/** All branches (paginated): name, head sha, protected. Plus the repo's default branch. */
listBranches(octokit, fullName): Promise<{ defaultBranch: string; branches: { name: string; headSha: string }[] }>;

/** All PRs, newest first, state=all, paginated, stop after `maxPages` (default 10 = 1000 PRs). */
listPullRequestsForTree(octokit, fullName, opts?): Promise<TreePr[]>;
// TreePr = { number, state: 'open'|'closed'|'merged', headRef, headSha, baseRef, baseSha, mergedAt, mergeCommitSha, title, author, updatedAt }

/** Check runs + commit statuses for one SHA, combined per T-spec "CI state". */
fetchCiState(octokit, fullName, sha): Promise<{ state: CiState; counts: Record<string, number> }>;

/** Short-lived installation token + clone URL for git (no token in the URL). */
gitAuthForInstallation(installationId): Promise<{ url: string; env: Record<string, string>; expiresAt: Date }>;
```
- `gitAuthForInstallation` returns `env` with `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.https://github.com/.extraheader`,
  `GIT_CONFIG_VALUE_0=AUTHORIZATION: basic <base64(x-access-token:TOKEN)>`. The token never appears in `url`.
  Scope it to the one repo (`repository_ids`) with `contents: read` and `metadata: read` (VERIFY).
- `fetchCiState`: a 403 on statuses (permission not accepted yet) → treat statuses as empty and log once
  `{ fullName, reason: 'statuses_forbidden' }`. Same for checks.
- **No compare endpoints.** Add a test helper that fails any msw request to `/compare/`.
- Errors go through `toGithubError`.
- **VERIFY and write the answer in the PR:** what `merge_commit_sha` points to after a rebase merge (GitHub
  REST docs, "Get a pull request"). Add a JSDoc line on `mergeCommitSha` with the answer.

## Tests (msw)
Pagination of branches and PRs; PR state mapping (`merged_at` set → `merged`); every CI combination in the
T-spec table; 403 statuses fallback; token never in `url` and never in a thrown error message.

## Not yours
Cloning (T2c), webhooks (T5a), DB writes.
