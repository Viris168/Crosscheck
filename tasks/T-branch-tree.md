# Task T — Branch tree

**Depends on:** Foundation, A, B, F, G, H (all merged) · **Split into agents:** see [Agent split](#agent-split)
at the bottom. Each agent gets its own file `tasks/T*-*.md`; this file is the shared spec they all read.

## Goal
A per-repo page that shows every branch as a tree: what each branch is compared with ("compare-with"), how
far ahead/behind it is, whether it is merged (and via which PR), and its CI state. It updates live from
webhooks. It never calls GitHub's compare API: the graph comes from a commits-only clone.

Page: `/repos/[repoId]/tree`, a **Branches** tab in `RepoHeader` (between Pull requests and Settings).

> **Source of truth for behavior:** the prototype, `docs/branch-tree/prototype.html` (open it in a browser).
> The compare-with and merged-state rules below are transcribed from its code (`chooseBase`, `inferBase`,
> `compareMap`, `prMerge`, `equivalence`, `contentMerged`); the function names are given so you can check.
> Where this spec and the prototype disagree on behavior, the prototype wins; on privacy and security, this
> spec wins. Demo-only parts are **not** built: the "Show real parents" toggle (`createdFrom`), committing,
> branching, opening/merging PRs and running CI from the page, and the "Acting as" picker.

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
enum MergedVia { pr rebased squashed }

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
  /// milestone 5: branches whose head was this branch's first commit when the push webhook saw it created
  recordedParents    String[] @default([])
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
  whyPr: number | null,                   // rule 'pr'
  ambiguous: number | null,               // rule 'recorded' with several candidates
  loop: boolean,                          // fell back to default because of a loop
  ahead: number, behind: number, mergeBase: string | null,
  merged: { via: MergedVia, prNumber: number | null, method: 'merge' | 'squash' | 'rebase' | null,
            into: string, newCommits: number } | null,
  pr: { number, state, baseRef } | null,  // newest PR whose head.ref is this branch
  ci: CiState,
  recorded: boolean,                      // milestone 5
}
CompareWhy = 'override' | 'pr' | 'recorded' | 'inferred' | 'default'
```

---

## Compare-with rules (prototype `chooseBase` + `inferBase` + `compareMap`)
`LONG_LIVED = /^(main|master|dev|develop|staging|release\/.+)$/`; a branch is long-lived if it matches or is the
default branch. For each non-default branch `B`, the first rule that matches wins (a target must exist and ≠ `B`):
1. **`override`** — a `CompareOverride` row for `B` whose target still exists. Label "set by hand".
2. **`pr`** — PRs with `head.ref = B` whose base still exists: the newest **open** one, else the newest
   **merged** one → its `base.ref`. Label "PR #n"; long form "Target of PR #n (open|merged)".
3. **`recorded`** — `Branch.recordedParents` (every branch whose head was `B`'s starting commit when the push
   webhook saw `B` created; T5b), filtered to existing branches. One → it. Several → the `closest` of them
   (below), with `ambiguous = count`; label "ambiguous".
4. **`inferred`** — candidates: every other branch `C` that is long-lived, **or** whose head ≠ `B`'s head and is
   contained in `B` (`B` was cut from `C` and `C` has not moved since). Pick the `closest`. Label "guess".
5. **`default`** — the default branch. Label "default".

`closest(B, candidates)`: the lowest score tuple, compared left to right:
`[ahead(B vs C), C is default ? 0 : 1, C is long-lived ? 0 : 1, behind(B vs C), C's name]`.

**Loops** (`compareMap`): after choosing for every branch, walk each branch's chain in name order; if it comes
back to itself, that branch gets `{ compareWith: default, why: 'default', loop: true }` ("The choices formed a
loop, so the default branch.").

## Merged-state rules (prototype `prMerge` + `contentMerged`; milestone 3)
For each non-default branch `B` with compare-with target `T`:
1. **PR record** (`prMerge`) — the newest merged PR with `head.ref = B`. `newCommits` = commits reachable from
   `B` but not from the PR's head SHA at merge time (`rev-list --count <pr.headSha>..B`). `newCommits = 0` →
   "merged via #n (merge commit|squash|rebase)"; `> 0` → "N new since #n" (warning colour). Merge method comes
   from the PR (see T2b: merge commit = 2 parents; squash/rebase told apart by comparing the PR's commit count
   with what landed — VERIFY in T2b). Content is never read.
2. **Content** (`equivalence` + `contentMerged`), only when there is no merged PR: take the commits in `T..B`
   (`ahead`). If `ahead` is empty → not marked (the row already shows ↑0). For each ahead commit: a merge
   commit counts as done; a commit whose patch-id matches a commit in `T` counts as `patch`; otherwise it counts
   as `content` if its change is already in `T`. All done and none `content` → **`rebased`**; all done with
   some `content` → **`squashed`**; any not done → not merged. Label "content in T (rebased|squashed)".
   Real-git mapping: patch matches = `git cherry T B` (`-` lines). For the rest, "change already in T" =
   `git merge-tree --write-tree T B` gives `T`'s own tree (checked once for the whole branch, not per commit).
   Both need contents → throwaway workspace. At most 50 branches per sync, 10 s each.

`MergedVia = 'pr' | 'rebased' | 'squashed'`. The compare panel's per-commit tags ("same patch as X",
"in squash Y") are out of scope until T6b (they need contents per request).

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
