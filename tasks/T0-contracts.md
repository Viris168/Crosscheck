# T0 — Contracts for the branch tree (Foundation)

**Wave 1** · **Branch:** `feat/t0-contracts` · **Lane:** Foundation · **Needs merged:** nothing
**Spec:** `tasks/T-branch-tree.md` → "Contracts", "Privacy rules", "Decisions".

## You own (edit only these)
- `packages/db/prisma/schema.prisma` + one migration `t_branch_tree` in `packages/db/prisma/migrations/`
- `packages/db/prisma/seed.ts`
- `packages/shared/src/events.ts` (+ test), `packages/shared/src/api/tree.ts` (new), `api/index.ts`,
  `src/index.ts`, `src/client.ts`, `src/enums.ts` (+ tests)
- `CLAUDE.md` (ownership table), `docs/essential-architecture.md` (invariant 4), `.env.example`
- `tasks/CONTRACT_REQUESTS.md` (one entry per change, status "applied")

## Do
1. **Prisma**: the models and enums under "Contracts → Prisma" exactly, plus `mergedAt`, `mergeCommitSha`,
   `baseSha` on `PullRequest`, and the back-relations on `Repo`. `pnpm db:migrate --name t_branch_tree`.
2. **Enums** in `enums.ts`: `TreeSyncStatus`, `CiState`, `MergedVia`, `CompareWhy` (zod enums matching Prisma).
3. **Events**: `tree/sync-requested` and `tree/refs-changed` in both `events` and `eventSchemas`.
4. **API** `api/tree.ts`: `TreeParams`, `BranchNodeSchema`, `TreeSnapshotSchema`, `GetTreeQuery`
   (`at` optional ISO), `GetTreeResponse`, `SyncTreeResponse`, `SetCompareWithBody`, `SetCompareWithResponse`,
   `CompareQuery`, `CompareResponse`. Cap arrays (`branches` ≤ 2000, `commits` ≤ 20 000, names ≤ 255).
   Export from `@app/shared` and `@app/shared/client` (no `node:` imports in this file).
5. **Seed**: on the seed repo add a `RepoGraph` (`ready`) with a small snapshot: `main`, `feat-a` (open PR,
   ahead 2), `feat-b` stacked on `feat-a`, `old-fix` merged via PR (squash), `same-as-main` (same commit).
   F uses this before the sync job exists.
6. **Env**: `REPO_CACHE_DIR=./.cache/repos` in `.env.example` (comment: commits-only clones, see T-spec).
   Add it to `apps/web/src/server/env.ts` as optional with that default. Add `.cache/` to `.gitignore`.
7. **CLAUDE.md**: ownership row `packages/git-graph/` → **T — Branch tree engine**. Under "Security
   non-negotiables" add one line: commits-only clones live in `REPO_CACHE_DIR`; file contents only in
   throwaway workspaces (see `tasks/T-branch-tree.md`).
8. **essential-architecture.md** invariant 4: add the clone exception from "Privacy rules", in two lines.

## Tests
- `events.test.ts`, `api.test.ts`, `enums.test.ts`: new schemas parse good input and reject bad (unknown
  `why`, oversize arrays, missing `compareWith` on a non-default branch is allowed only as `null`).
- `pnpm turbo lint typecheck test` passes; `pnpm db:migrate` and `pnpm db:seed` work on a fresh database.

## Not yours
Using any of these contracts. No route, job or page code.
