# How to run the agents

## Order
```
Phase 0 (1 agent)      00-foundation.md          → review → merge to main
Phase 1 (parallel)     A-github, C-providers, F-frontend
Phase 2 (parallel)     B-worker, D-ingest-actions, E-scoring-comments
Phase 3                G-infra, then integration (see bottom)
```
Run 3–4 agents at a time at most — you have to review every PR.

## Dependencies between lanes
| Lane | Needs (use mocks until merged) |
|---|---|
| A GitHub | Foundation |
| B Worker | Foundation, A (`@app/github`), C (`@app/providers`), E (`@app/scoring`, `@app/github-comments`) |
| C Providers | Foundation |
| D Ingest + Actions | Foundation, A (`@app/github`), C (prompt text) |
| E Scoring + comments | Foundation, A (`@app/github`) |
| F Frontend | Foundation, D (`@app/workflow-templates`) for the wizard, C for ChatGPT OAuth helpers |
| G Infra | Foundation (can start any time after) |

## Start a lane
```bash
# from the main repo, after Foundation is merged
git pull
git worktree add ../app-A -b feat/a-github
git worktree add ../app-C -b feat/c-providers
git worktree add ../app-F -b feat/f-frontend

cd ../app-A && claude
```
First message to each agent:
> Read CLAUDE.md and tasks/A-github.md. Do the task. Stay inside your owned paths. Open a PR when the
> "Done when" list is complete.

(Swap the file name per lane.)

## Review loop per PR
1. Agent opens PR.
2. Codex reviews (`@codex review`, or automatic reviews on).
3. Back in that agent's session: "Read the Codex review on PR #N and fix the issues."
4. You read the final diff, merge.
5. Other running agents: `git pull --rebase origin main` to pick up merged lanes.

## Contract changes
Agents write requests to `tasks/CONTRACT_REQUESTS.md` instead of editing `packages/shared` / `packages/db`.
You (or a short Foundation session) apply them on `main`, then other lanes rebase.

## Phase 3 — Integration (one agent, after all lanes merge)
> Read CLAUDE.md. Replace every remaining mock with the real package. Run the end-to-end path on a test
> repo: install GitHub App → open PR → review runs (platform default and Claude Action) → comments
> appear → dashboard shows completed state + risk score. Fix wiring bugs only; file anything bigger as a
> task. Add an e2e test script in `scripts/e2e.ts`.

## Clean up
```bash
git worktree remove ../app-A
```
