# T2c — Clone + sync job (Lane B, milestone 2)

**Wave 2** · **Branch:** `feat/t2c-sync-job` · **Lane:** B · **Needs merged:** T0, T1, T2a
**Spec:** `tasks/T-branch-tree.md` → "Decisions", "Privacy rules", "CI state".
**Mocks until merged:** T2b's `@app/github` tree functions (use the signatures in `T2b-github-reads.md`).

## You own (edit only these)
- `apps/web/src/server/jobs/tree-sync.ts` (new) + test, `jobs/repo-cache.ts` (new) + test,
  `jobs/functions.ts`, `jobs/index.ts`, `jobs/deps.ts`

## Do
1. **`repo-cache.ts`** (clone management, Node only):
   - `ensureClone(repo, auth)`: if `${REPO_CACHE_DIR}/<githubRepoId>.git` is missing →
     `git clone --bare --filter=tree:0 --no-tags <url>`; then `git config remote.origin.promisor false` and
     `git config remote.origin.fetch '+refs/heads/*:refs/heads/*'`. Else `git fetch --prune --filter=tree:0 origin`.
     All via `runGit` from `@app/git-graph/git` with `auth.env`.
   - A per-repo lock (Redis `SET NX`, 10 min) so two syncs never touch one clone.
   - On a corrupt clone (`fsck`-style failure), delete the dir and clone again once.
   - `assertNoContents(gitDir)` → throws if `git cat-file --batch-all-objects --batch-check` lists any
     `tree` or `blob`. Called after every fetch in tests, and in prod behind `TREE_ASSERT_NO_CONTENTS=1`.
2. **`tree-sync` function** on `tree/sync-requested`, concurrency `{ key: event.data.repoId, limit: 1 }`,
   plus `{ key: event.data.orgId, limit: 2 }`:
   - step `load-refs`: `listBranches` + `listPullRequestsForTree` → upsert `Branch` rows (soft-delete gone
     ones with `deletedAt`), upsert `PullRequest` rows (`state`, `headSha`, `baseRef`, `baseSha`,
     `mergedAt`, `mergeCommitSha`; never touch `Review`s). Returns counts only.
   - step `fetch`: `ensureClone`. Returns `{ ok: true }`.
   - step `ci`: `fetchCiState` for each branch head not already terminal in `CommitCi` (max 200 per run,
     newest branches first). Returns counts.
   - step `snapshot`: `readCommitGraph` + `buildSnapshot` (from `@app/git-graph`) → write
     `RepoGraph { status: ready, syncedAt, defaultBranch, snapshot }`. Returns counts.
   - Set `status: syncing` at start, `failed` + `errorCode` on final failure.
   - **No step returns commits, branch names or PR titles** (Inngest stores step outputs).
3. **First view**: export `requestTreeSync(repoId, orgId, reason)` from `@/server/jobs` that sends the event;
   F calls it when `RepoGraph` is missing.

## Tests
- Against a local bare repo made by T1's fixture builder (file URL instead of GitHub): clone, fetch after a
  new commit, force-push, branch delete; `assertNoContents` passes after each.
- Step outputs contain no strings other than ids/status (snapshot test).
- Lock: two concurrent runs → one waits/skips.
- Token: a failing fetch's logged error has no `x-access-token`/`AUTHORIZATION`.

## Not yours
Merged-state fallbacks (T3b), webhooks (T5a/T5b), the page/API (T2d).
