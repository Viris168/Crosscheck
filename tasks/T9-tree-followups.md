# T9 — Branch tree follow-ups (found while integrating, T7)

Not wiring, so left for a lane. Each item is independent.

| # | Lane | What | Why / evidence |
|---|---|---|---|
| 1 | owner of the GitHub App | Add **Commit statuses: Read** and the **Push, Check run, Check suite, Status** events to the App, then accept the review request on the installation (`docs/deploy.md` 3.3) | On 2026-11-22 the dev App had none of them. Until then: no live updates from pushes, no commit statuses in CI |
| 2 | F | `liveEvents` should look at push kinds only (`push`, `branch_created`, `branch_deleted`, `force_push`) | It is true after **any** `GitEvent`. GitHub delivers `check_suite` to Apps with Checks access without a subscription, and `pull_request` was already on, so the "No push events from GitHub yet" hint disappears while pushes still don't arrive. Seen on the deployed stack: `ci` events from GitHub, no push, no hint |
| 3 | B | `tree-sync`: write an early snapshot (`snapshotFirst`, as `tree-refresh` does) when there is none yet | First view of an 11-branch repo took 25 s; about 18 s of it was the content check before the first snapshot |
| 4 | F | GET `/tree`: decide 304 before reading `RepoGraph.snapshot` (select the metadata first) | A 304 still reads the whole JSON: 59 ms p50 for a 2.3 MB snapshot, every 3 s per open tab |
| 5 | B | `tree-refresh` on a repo without a snapshot requests a full sync, which clones it even if nobody ever opened its tree | Every push to any installed repo creates a clone; `tree-cleanup` deletes it after 30 days and the next push clones it again |
| 6 | A | Pass a silent `log` to Octokit | Its default logger prints failed requests (repo full name, login) to stdout, outside pino |
| 7 | F / Foundation | "Show in branch tree" for PRs from forks | The head branch is not in this repo, so the search is empty. `PullHeaderSchema` does not say whether the head is a fork |
