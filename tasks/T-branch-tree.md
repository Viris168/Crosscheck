# Task T — Branch tree

**Depends on:** Foundation, A, B, F, G, H (all merged) · **Split into agents:** see [Agent split](#agent-split)
at the bottom. Each agent gets its own file `tasks/T*-*.md`; this file is the shared spec they all read.

## Goal
A per-repo page that shows every branch as a tree: what each branch is compared with ("compare-with"), how
far ahead/behind it is, whether it is merged (and via which PR), and its CI state. It updates live from
webhooks. It never calls GitHub's compare API: the graph comes from a commits-only clone.

Page: `/repos/[repoId]/tree`, a **Branches** tab in `RepoHeader` (between Pull requests and Settings).

> **Source of truth for behavior:** the prototype ("this demo"). Before wave 1, save it as
> `docs/branch-tree/prototype.html` (or link it here). Where this spec and the prototype disagree on UI
> behavior, the prototype wins; on privacy and security, this spec wins. The compare-with rule order below is
> reconstructed from the plan; **T1 checks it against the prototype and writes any difference into this file
> as its first commit.**

## Milestones → agents
| # | Milestone | Done when | Agents |
|---|---|---|---|
| 1 | Graph engine library | Engine output equals `git rev-list --count`, `git cherry` and `git merge-tree` on script-built test repos (merge, squash, rebase, stacked, two branches on one commit) | T1 |
| 2 | Read-only real data, signed in | A real private repo renders correctly with **no** compare API calls | T0, T2a, T2b, T2c, T2d |
| 3 | Merged-state detection | On a test repo merged once each way (merge commit, squash, rebase), every merged branch shows "merged via #n" | T3a, T3b |
| 4 | Compare-with on real data | On 2–3 real repos the team confirms most picks are right; a wrong one is fixed in one click | T4 |
| 5 | Live updates + recording | The tree updates within seconds of a push; new branches show "recorded" | T5a, T5b, T5c |
| 6 | Scale | 500 branches / 50k commits stay responsive (budget set in T6a) | T6a, T6b |
| 7 | Integrate and deploy | Deployed and linked | T7 |
| 8 | Time travel (optional) | Any two moments can be compared | T8a, T8b |

---

## Decisions (already made)
1. **Lives in this repo.** New lane **T — Branch tree engine** owns `packages/git-graph/`. Everything else
   maps onto existing lanes: A (GitHub reads, webhooks), B (clone/fetch jobs), F (page + API), G (image,
   volume, App permissions), Foundation (contracts + DB).
2. **Commits-only clone** (`git clone --bare --filter=tree:0`) in a cache volume, one per repo:
   `${REPO_CACHE_DIR}/<githubRepoId>.git`. It holds commits only: no trees, no blobs.
3. **No compare API.** Ahead/behind, merge-base and ancestry come from the clone. Branches, PRs and CI come
   from the REST API.
4. **Sign-in and access from day one.** Every tree route uses `loadRepoForPage` / `requireRepoAccess` like
   the other repo pages (view = collaborator rule from Task H; overrides = write rule).

## Privacy rules (extend invariant 4 in `docs/essential-architecture.md`)
- **Allowed on disk / in DB:** commit SHAs, parent SHAs, commit timestamps, ref names, PR numbers/state/SHAs,
  CI states. **Not stored:** commit messages, author emails, trees, blobs, diffs, patches.
  (A `tree:0` clone does keep commit messages in its commit objects on the cache volume. That volume is
  treated like Postgres: never logged, never exported, never sent anywhere. T0 writes this exception into
  `docs/essential-architecture.md`.)
- **File contents only in a throwaway workspace (milestone 3).** Patch-ID and test-merge need trees and
  blobs. They run in a temp dir made by `git clone --shared --bare <cache> <tmp>`, fetch the missing objects
  there, and `rm -rf` it in `finally`. Objects must never be lazily fetched into the cache clone: every git
  call on the cache sets `GIT_NO_LAZY_FETCH=1` (VERIFY: git ≥ 2.44) and the cache has
  `remote.origin.promisor=false` after clone. A test asserts the cache has zero `blob`/`tree` objects
  (`git cat-file --batch-all-objects --batch-check`).
- **Inngest event payloads and step outputs:** ids, counts and SHAs only. No commit lists, no file names.
- **Token use:** the installation token goes to git through `GIT_CONFIG_COUNT/KEY/VALUE` env
  (`http.https://github.com/.extraheader = AUTHORIZATION: basic <base64(x-access-token:TOKEN)>`). Never in the
  remote URL, never in `.git/config`, never in a log line or error message (scrub `stderr` before logging).

---

## Contracts (T0 applies these; everyone else reads them)

### Prisma (`packages/db/prisma/schema.prisma`, one migration `t_branch_tree`)
```prisma
enum TreeSyncStatus { idle syncing ready failed }
enum CiState { success failure pending neutral none }
enum MergedVia { pr ancestor patch_id content }

model RepoGraph {               // one per repo; status of the clone + last snapshot
  repoId        String  @id
  repo          Repo    @relation(fields: [repoId], references: [id], onDelete: Cascade)
  status        TreeSyncStatus @default(idle)
  errorCode     ErrorCode?
  defaultBranch String?
  syncedAt      DateTime?
  /// TreeSnapshot from @app/shared (no messages, no contents)
  snapshot      Json?
  updatedAt     DateTime @updatedAt
}

model Branch {
  id                 String   @id @default(cuid())
  repoId             String
  repo               Repo     @relation(fields: [repoId], references: [id], onDelete: Cascade)
  name               String
  headSha            String
  isDefault          Boolean  @default(false)
  /// milestone 5: parent seen when the branch was created (push event, created=true)
  recordedParent     String?
  recordedAt         DateTime?
  deletedAt          DateTime?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
  @@unique([repoId, name])
  @@index([repoId, deletedAt])
}

model CommitCi {               // CI per commit, only for branch heads and PR heads
  repoId    String
  sha       String
  state     CiState
  /// counts by state from check runs + commit statuses
  counts    Json
  updatedAt DateTime @updatedAt
  @@id([repoId, sha])
}

model CompareOverride {
  repoId      String
  branchName  String
  compareWith String
  setByUserId String
  createdAt   DateTime @default(now())
  @@id([repoId, branchName])
}

model GitEvent {                // milestone 5 + 8; refs and SHAs only
  id         String   @id @default(cuid())
  repoId     String
  deliveryId String   @unique
  kind       String   // 'push' | 'branch_created' | 'branch_deleted' | 'force_push' | 'pull_request' | 'ci'
  ref        String?
  before     String?
  after      String?
  prNumber   Int?
  receivedAt DateTime @default(now())
  @@index([repoId, receivedAt])
}
```
`PullRequest` gains `mergedAt DateTime?`, `mergeCommitSha String?`, `baseSha String?`. (`headSha`, `baseRef`,
`state: merged` already exist.)

### Events (`packages/shared/src/events.ts`)
- `'tree/sync-requested': { repoId, orgId, reason: 'manual' | 'first_view' | 'webhook' | 'cron' }`
- `'tree/refs-changed': { repoId, orgId, eventId }` (eventId = `GitEvent.id`)

### API (`packages/shared/src/api/tree.ts`, browser-safe parts in `@app/shared/client`)
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/repos/:repoId/tree` | `?at=<ISO>` (milestone 8 only) | `GetTreeResponse { status, syncedAt, errorCode, snapshot: TreeSnapshot \| null, canEdit }` |
| POST | `/api/repos/:repoId/tree/sync` | — | `{ queued: true }` (view access; Redis rate limit 1/min/repo) |
| PUT | `/api/repos/:repoId/tree/compare-with` | `{ branch, compareWith: string \| null }` (null = clear) | `{ branch: BranchNode }` (write access) |
| GET | `/api/repos/:repoId/tree/compare` | `?a=<branch>&b=<branch>` (milestone 6) | `{ ahead, behind, mergeBase }` |

```ts
TreeSnapshot = {
  defaultBranch: string,
  branches: BranchNode[],
  commits: { sha: string, parents: string[], committedAt: string }[],   // only what the page draws
  truncated: boolean,
}
BranchNode = {
  name, headSha, isDefault,
  compareWith: string | null,            // null only for the default branch
  why: CompareWhy,                        // see "Compare-with rules"
  ahead: number, behind: number, mergeBase: string | null,
  merged: { via: MergedVia, prNumber: number | null, into: string, newCommits: number } | null,
  pr: { number, state, baseRef } | null,  // newest PR whose head.ref is this branch
  ci: CiState,
  recorded: boolean,                      // milestone 5
}
CompareWhy = 'override' | 'open_pr' | 'merged_pr' | 'recorded' | 'nearest' | 'same_commit' | 'default'
```

---

## Compare-with rules (milestone 1 engine; milestone 4 adds overrides; check against the prototype)
For each non-default branch `B`, the first rule that matches wins:
1. **`override`**: a `CompareOverride` row exists and its target branch still exists.
2. **`open_pr`**: the newest open PR with `head.ref = B` → its `base.ref`.
3. **`merged_pr`**: the newest merged PR with `head.ref = B` → its `base.ref`.
4. **`recorded`**: `Branch.recordedParent` is set and still exists (milestone 5).
5. **`nearest`**: candidates are the other branches `C`, excluding any `C` whose head equals `B`'s head and
   any `C` built on top of `B` (`B`'s head is an ancestor of `C`'s head). Pick the `C` with the smallest
   `rev-list --count C..B` (commits `B` has that `C` lacks). Ties: default branch, then the `C` that `B` is
   least behind, then name order. This makes `feat-2` (stacked on `feat-1`) point at `feat-1`, and keeps
   `feat-1` from pointing at its own child `feat-2`.
6. **`same_commit`**: `B`'s head equals another branch's head and no rule above matched → compare with the
   default branch, label "same commit as X".
7. **`default`**: the default branch.

Never pick a target that would create a cycle (`B → C → B`); skip it and keep going.

## Merged-state rules (milestone 3)
For each branch `B` with compare-with target `T`, the first that matches wins:
1. **`pr`** — a merged PR with `head.ref = B`. If `B`'s head is still the PR's `head.sha`, `newCommits = 0`;
   if `B` moved on, `newCommits = rev-list --count <pr.headSha>..B` ("merged via #n, then 3 new commits").
   Works for merge commit, squash and rebase because it never looks at content.
2. **`ancestor`** — `B`'s head is an ancestor of `T` (fast-forward or merge without a PR). Graph only.
3. **`patch_id`** — every commit in `T..B` has a patch-id equal to a commit in `B..T` (`git cherry T B` shows
   only `-`). Rebase without a PR. Needs contents → throwaway workspace.
4. **`content`** — `git merge-tree --write-tree T B` yields `T`'s tree. Squash without a PR. Throwaway
   workspace.
Rules 3–4 run only for branches not matched by 1–2, at most 50 branches per sync, each with a 10 s timeout.

**VERIFY (T2b):** what `merge_commit_sha` is after a rebase merge (expected: the last rebased commit on the
base). Rule 1 does not depend on it; it is stored for the UI link only.

## CI state
Combine check runs (`GET /repos/{r}/commits/{sha}/check-runs`) and commit statuses
(`GET /repos/{r}/commits/{sha}/status`) for each branch head: any failure/cancelled/timed_out/error → `failure`;
else any queued/in_progress/pending → `pending`; else any success → `success`; only neutral/skipped →
`neutral`; nothing → `none`. Cache in `CommitCi` by SHA; a SHA in a terminal state is not re-fetched.

## GitHub App changes (T2a writes them into `docs/deploy.md`)
- Permissions: **Commit statuses: Read** (new). Checks and Contents are already granted.
- Events: **Push, Check run, Check suite, Status** (new). Pull request is already on.
- Existing installations must accept the new permissions; until then CI shows `none` and live updates fall
  back to the 15-minute cron (T5b).

---

## Agent split
| Wave | Agents (task files) | Lane |
|---|---|---|
| 1 | `T0-contracts.md` · `T1-graph-engine.md` · `T2a-infra.md` | Foundation · T · G |
| 2 | `T2b-github-reads.md` · `T2c-sync-job.md` · `T2d-tree-page.md` | A · B · F |
| 3 | `T3a-merged-detection.md` · `T3b-merged-in-sync.md` · `T4-compare-with.md` | T · B · F |
| 4 | `T5a-webhooks.md` · `T5b-live-sync.md` · `T5c-live-page.md` | A · B · F |
| 5 | `T6a-engine-scale.md` · `T6b-page-scale.md` | T · F |
| 6 | `T7-integrate-deploy.md` (one integration agent, all lanes) | — |
| 7 (optional) | `T8a-snapshots.md` · `T8b-time-travel-ui.md` | B · F |

Start a wave only when the previous one is merged. Each wave ends with the "Done when" check of its
milestone on a real test repo.
