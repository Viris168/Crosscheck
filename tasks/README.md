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

## Clean up
```bash
git worktree remove ../app-A
```
