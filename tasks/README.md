# How to run the agents

Each agent gets its own git worktree, one task file, and its own folders (see the ownership table in
`CLAUDE.md`). Almost everything lives in one Next.js app (`apps/web`), so folder ownership matters.

## Order
```
Day 0      Step 0: docs updated to the new stack (done when this file says Inngest/Better Auth)
Day 1      00-foundation.md                    → review → merge to main
Days 2-4   Wave 1: A-github, C-providers, F-frontend
Days 4-7   Wave 2: B-jobs, D-ingest-actions, E-scoring-comments   (start once A and C are merged; F continues)
Day 8      Wave 3: G-infra, then one integration agent (see bottom)
           Hosting: free local demo for now (no VPS, no paid services). See tasks/G-infra.md "Scope now".
```
Run **3 agents at a time** at most — you have to review every PR.

## Who owns what
| Agent | Task file | Branch | Owns |
|---|---|---|---|
| Foundation | `00-foundation.md` | `feat/foundation` | root config, `packages/shared`, `packages/db`, `apps/web` skeleton (then only `src/server/{auth,env,redis}.ts`, `src/app/api/{auth,inngest,health}`) |
| A GitHub | `A-github.md` | `feat/a-github` | `packages/github`, `apps/web/src/server/github`, `apps/web/src/app/api/webhooks/github` |
| B Jobs | `B-jobs.md` | `feat/b-jobs` | `apps/web/src/server/jobs` (Inngest functions) |
| C Providers | `C-providers.md` | `feat/c-providers` | `packages/providers` |
| D Ingest | `D-ingest-actions.md` | `feat/d-ingest` | `apps/web/src/server/ingest`, `apps/web/src/app/api/ingest`, `packages/workflow-templates` |
| E Scoring | `E-scoring-comments.md` | `feat/e-scoring` | `packages/scoring`, `packages/github-comments` |
| F Frontend | `F-frontend.md` | `feat/f-frontend` | `apps/web/src/app` (pages + dashboard API routes, minus the API folders above), `components`, `hooks`, `lib` |
| G Infra | `G-infra.md` | `feat/g-infra` | `infra/`, `.github/workflows/`, `docs/deploy.md` |

## Dependencies between lanes
| Lane | Needs (use mocks until merged) |
|---|---|
| A GitHub | Foundation |
| B Jobs | Foundation, A (`@app/github`), C (`@app/providers`), E (`@app/scoring`, `@app/github-comments`) |
| C Providers | Foundation |
| D Ingest + Actions | Foundation, A (`@app/github`), C (prompt text) |
| E Scoring + comments | Foundation, A (`@app/github`) |
| F Frontend | Foundation, D (`@app/workflow-templates`) for the wizard, C for ChatGPT OAuth helpers |
| G Infra | Foundation (can start any time after) |

## Start Foundation
```bash
git worktree add ../app-foundation -b feat/foundation
cd ../app-foundation && claude
```
> Read CLAUDE.md, docs/tech-stack.md, docs/essential-architecture.md and tasks/00-foundation.md.
> Build the foundation. Don't build features.

## Start a lane (after Foundation is merged)
```bash
git pull
git worktree add ../app-A -b feat/a-github
git worktree add ../app-C -b feat/c-providers
git worktree add ../app-F -b feat/f-frontend
cd ../app-A && pnpm install && claude
```
First message to each agent (swap the task file):
> Read CLAUDE.md, docs/tech-stack.md and tasks/A-github.md. Do only your task, only inside your owned
> folders. Use mocks for anything not merged yet. Run the tests, then open a PR.

You can give a lane to **Codex** instead (`codex` in `../app-E`, same message); then have a Claude agent
review its PR, so each model checks the other.

## Review loop per PR
1. Agent opens PR.
2. Codex reviews (`@codex review`, or automatic reviews on).
3. Back in that agent's session: "Read the Codex review on PR #N and fix the issues."
4. You read the final diff, merge.
5. Every other running agent: "`git pull --rebase origin main`, then re-run the tests."

## Rules that prevent chaos
- **Shared contracts are locked.** Agents write requests to `tasks/CONTRACT_REQUESTS.md` instead of editing
  `packages/shared` / `packages/db`. You apply them on `main`, then everyone rebases.
- **`apps/web/package.json`** is the one file several lanes touch. Conflicts are small: keep the union of
  dependencies, then `pnpm install`.
- **Merge small and often.** One lane = one or a few small PRs, not one huge PR at the end.
- **Mocks first.** F uses seed data, B uses a mock provider, so nobody waits.

## Phase 3 — Integration (one agent, after all lanes merge)
> Read CLAUDE.md and docs/tech-stack.md. Replace every remaining mock with the real package. Run the
> end-to-end path on a test repo: install GitHub App → open PR → review runs (platform default and Claude
> Action) → comments appear → dashboard shows completed state + risk score; check the runs in the Inngest
> dashboard. Fix wiring bugs only; file anything bigger as a task. Add an e2e test script in `scripts/e2e.ts`.

## Task H — Members and repo access from GitHub
Spec: `tasks/H-repo-collaborators.md` (every H agent reads it). One task file per agent, three waves;
start a wave only when the previous one is merged.

| Wave | Agents (task files) |
|---|---|
| 1 | `H0-contracts.md` (Foundation) · `H1-permissions.md` (A) · `H6-app-permissions-docs.md` (G) |
| 2 | `H2-membership.md` (A) · `H3-repo-access.md` (F) · `H4-members-page.md` (F) |
| 3 | `H5a-signin-job.md` (B) · `H5b-check-again.md` (F), then one integration pass |

```bash
git pull
git worktree add ../app-H0 -b feat/h0-contracts
git worktree add ../app-H1 -b feat/h1-permissions
git worktree add ../app-H6 -b feat/h6-app-permissions-docs
cd ../app-H0 && pnpm install && claude
```
First message to each agent (swap the task file):
> Read CLAUDE.md, docs/tech-stack.md, tasks/H-repo-collaborators.md and tasks/H0-contracts.md. Do only your
> task, only inside the paths your task file lists. Run the tests, then open a PR listing your `// VERIFY:` items.

Integration pass (after wave 3): with the GitHub App's new permissions accepted on a test org, check every
item under "Done when" in `tasks/H-repo-collaborators.md` with real accounts.

## Task T — Branch tree
Spec: `tasks/T-branch-tree.md` (every T agent reads it). One task file per agent; start a wave only when
the previous one is merged. Before wave 1, save the prototype as `docs/branch-tree/prototype.html`.

| Wave | Milestone | Agents (task files) |
|---|---|---|
| 1 | 1 + groundwork | `T0-contracts.md` (Foundation) · `T1-graph-engine.md` (T) · `T2a-infra.md` (G) |
| 2 | 2 | `T2b-github-reads.md` (A) · `T2c-sync-job.md` (B) · `T2d-tree-page.md` (F) |
| 3 | 3 + 4 | `T3a-merged-detection.md` (T) · `T3b-merged-in-sync.md` (B) · `T4-compare-with.md` (F) |
| 4 | 5 | `T5a-webhooks.md` (A) · `T5b-live-sync.md` (B) · `T5c-live-page.md` (F) |
| 5 | 6 | `T6a-engine-scale.md` (T) · `T6b-page-scale.md` (F) |
| 6 | 7 | `T7-integrate-deploy.md` (integration) |
| 7 (optional) | 8 | `T8a-snapshots.md` (B) · `T8b-time-travel-ui.md` (F) |

```bash
cd "/home/viris/Documents/Claude Setup/AI github" && git pull
git worktree add ../app-t0 -b feat/t0-contracts
git worktree add ../app-t1 -b feat/t1-graph-engine
git worktree add ../app-t2a -b feat/t2a-infra
for d in t0 t1 t2a; do cp .env "../app-$d/.env"; done
cd "/home/viris/Documents/Claude Setup/app-t0" && pnpm install && claude
```
First message to each agent (swap the task file):
> Read CLAUDE.md, docs/tech-stack.md, tasks/T-branch-tree.md and tasks/T0-contracts.md. Do only your task,
> only inside the paths your task file lists. Run the tests, then open a PR listing your `// VERIFY:` items.

## Clean up
```bash
git worktree remove ../app-A
```
