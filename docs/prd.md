# PRD — AI Code Review Platform

| | |
|---|---|
| **Status** | Draft v1 |
| **Owner** | Product owner (you) |
| **Last updated** | 2026-11-18 |
| **Related** | `docs/tech-stack.md` (decided stack), `docs/architecture.md`, `docs/essential-architecture.md`, `tasks/` |

---

## 1. Summary
A web platform that connects to GitHub, reviews every pull request with the AI the user chooses
(Claude or Codex, running on the user's own plan or the platform's), and returns **one consistent
result**: a risk score, inline comments with suggested fixes in the PR diff, and a history across all
repos.

**Pitch:** *Any AI reviewer, on your own plan. One risk score and one history across every repo.
Checks that a change does what it was meant to do — not just that it compiles.*

## 2. Problem
- Teams use AI to write code (Claude Code, Codex, Cursor). Code is produced faster than humans can
  review it carefully.
- Built-in reviewers (Codex code review, Claude GitHub Action, CodeRabbit) each work in isolation:
  one provider, no shared score, no cross-repo history, no way to compare reviewers.
- Reviewers see the diff but not the **intent**, so they catch bugs but miss "this isn't what we asked for".
- Users already pay for Claude or ChatGPT plans and don't want to pay again for tokens.

## 3. Goals
1. Every PR on a connected repo gets an AI review automatically within ~3 minutes (typical PR).
2. Users choose the reviewer per repo, including running on their own Claude or ChatGPT plan.
3. One risk score (0–100) per review, computed the same way for every provider.
4. Issues appear inline in the GitHub diff with one-click suggested fixes.
5. A dashboard shows all repos, PRs, review states and risk history.
6. The product is sellable: multi-tenant, billing, secure, deployable on a VPS.

## 4. Non-goals (v1)
- GitLab, Bitbucket, Azure DevOps
- Auto-applying fixes or pushing commits
- Blocking merges (no required status check in v1; informational only)
- Storing customer source code beyond what's needed during a review
- Self-hosted / on-prem edition
- Our own model training or fine-tuning

## 5. Users
| Persona | Need |
|---|---|
| **Solo developer using AI coding agents** | "Claude writes the code, a second AI checks it before I merge." Wants to use their existing plan. |
| **Tech lead (5–30 dev team)** | Consistent review on every PR, risk visibility across repos, fewer bad merges. |
| **Engineering manager** | Trends: which repos/areas are risky, are things improving. |

## 6. Reviewer options (provider modes)
| Mode | Billed to | Runs where | User provides |
|---|---|---|---|
| **Claude (my Claude plan)** | User's Claude Pro/Max/Team/Enterprise | User's GitHub Actions (official Claude Code Action) | `CLAUDE_CODE_OAUTH_TOKEN` + `PLATFORM_INGEST_TOKEN` as **GitHub repo secrets** |
| **Codex (my ChatGPT plan)** | User's ChatGPT Plus/Pro | Our servers (background jobs), via Sign in with ChatGPT | Clicks "Sign in with ChatGPT" |
| **Codex (my OpenAI API key)** | User's OpenAI API account | User's GitHub Actions (official Codex Action) | `OPENAI_API_KEY` + `PLATFORM_INGEST_TOKEN` as **GitHub repo secrets** |
| **Platform default** | Us (included in subscription) | Our servers (background jobs) | Nothing |

**Policy constraint:** Claude consumer-plan credentials may only be used inside Anthropic's own tools.
The platform therefore **never receives or stores a Claude token**; Claude-plan reviews run in the
user's own GitHub Action and send only results to us.

## 7. User stories & requirements

### 7.1 Onboarding — P0
- As a user, I sign in with GitHub.
- I install the GitHub App on an org/account and choose repos.
- I pick a reviewer per repo and follow a wizard specific to that choice.
- I click "Test connection" and see a review run end to end.

**Acceptance:** new user reaches a first completed review in < 10 minutes following the wizard.

### 7.2 Automatic review — P0
- When a PR is opened, reopened, marked ready, or gets new commits, a review starts (or the user's
  Action runs). Drafts are skipped.
- Optional trigger mode: only when someone comments `/review`.
- Review uses the PR title/description, `CHANGE_NOTES.md` and `AGENTS.md` (if present) as intent and rules.
- Large PRs are split into chunks; riskiest files first; partial results allowed.

### 7.3 Review states — P0
The PR page shows exactly one of: **Queued, Reviewing (X of Y files), Waiting for your GitHub Action,
Completed, Failed** — plus a **Stale** label when new commits arrived after the review.
Each failure shows a specific reason and a fix (expired token, plan limit, PR too large, Action didn't
report, invalid AI output, timeout).

### 7.4 Results in GitHub — P0
- One GitHub review per run: summary comment (risk score, level, top factors, link to dashboard) and
  inline comments on changed lines.
- Suggested fixes use GitHub `suggestion` blocks where possible.
- Respects repo settings: minimum severity, max comments, ignored paths, language.
- Never @-mentions people; outdated reviews are marked outdated, not deleted.

### 7.5 Risk score — P0
- 0–100 with level (low / medium / high / critical) and the list of factors that contributed.
- Same formula for every provider (AI score is one input; size, sensitive paths, missing tests and issue
  severity are others).

### 7.6 Dashboard — P0 (basic), P1 (history)
- Repo list with provider and last status.
- PR list per repo with Open / Closed / All filter, risk badge, size, review status.
- PR page with **Reviews** and **Changed Files** tabs; clicking an issue jumps to the line.
- P1: org overview — open PRs by risk, risk over time (30/90 days), top issue categories.

### 7.7 Settings — P0
Provider, model, minimum severity, ignored paths, max issues, language, trigger, ingest token
(show once, rotate), disconnect ChatGPT.

### 7.8 Re-run & compare — P1
- Re-run on latest commit.
- Re-run with a different provider; P2: side-by-side "second opinion" showing agreement/disagreement.

### 7.9 Teams & billing — P1 (required to sell)
- Orgs with roles: owner, admin, member (Better Auth organization plugin).
- Stripe subscriptions; plans limit repos, reviews/month, history retention. We charge for the platform,
  not tokens (except platform-default usage limits).

## 8. Functional limits (v1 defaults)
| Item | Default |
|---|---|
| Max files reviewed per PR | 3000 fetched; ~400k tokens reviewed (riskiest first) |
| Chunk size | ~60k tokens |
| Max inline comments posted | 50 (rest listed in summary) |
| Action result timeout | 30 min → `action_missing` |
| Worker review timeout | 20 min → `timeout` |
| Ingest payload | ≤ 1 MB |

## 9. Non-functional requirements
- **Security:** webhook signatures verified; ingest tokens hashed; ChatGPT tokens encrypted at rest
  (AES-256-GCM); secrets never logged; AI output treated as untrusted (validated, escaped).
- **Privacy:** source code is processed in memory during review and not stored; we store findings,
  metadata and scores. Secret-like files are never sent to AI.
- **Reliability:** webhooks acknowledged < 1s; background jobs are durable Inngest functions (idempotent,
  step-level retries with backoff); daily DB backups.
- **Performance:** typical PR (< 30 files) completed < 3 min; dashboard pages < 1s p95.
- **Accessibility:** keyboard navigable; color never the only signal.

## 10. Success metrics
| Metric | Target (first 3 months) |
|---|---|
| Activation: signup → first completed review | ≥ 60% |
| Review success rate (completed / all) | ≥ 95% |
| Median time PR opened → review completed | < 3 min |
| Suggested fixes committed (accept rate) | ≥ 15% |
| Weekly active repos retained after 4 weeks | ≥ 50% |
| Paying orgs | first 20 |

## 11. Release plan
| Phase | Scope | Est. |
|---|---|---|
| **0 Foundation** | Monorepo, DB schema, shared contracts, Next.js skeleton (Better Auth, Inngest endpoint) | ~1 day |
| **1 MVP (internal)** | GitHub App, platform-default + Claude Action modes, scoring, inline comments, basic dashboard | ~3 weeks |
| **2 Multi-provider + history** | Codex (ChatGPT plan + Action), intent-aware prompts, risk history, org overview | ~2–3 weeks |
| **3 Sellable** | Teams, Stripe, plan limits, prod hardening, legal pages, Marketplace listing | ~3–4 weeks |

## 12. Risks
| Risk | Mitigation |
|---|---|
| Provider policy changes (subscription use) | Provider layer is swappable; always offer API-key and platform modes |
| Large PRs fail or cost too much | Chunking, prioritization, partial results, size warnings |
| Noisy reviews → users ignore them | P0/P1 focus, min severity, max comments, intent-aware prompt |
| Customer trust (code privacy) | Clear data policy, no code storage, BYO-plan modes |
| Competition (CodeRabbit, built-in reviewers) | Lead with provider choice, unified score/history, intent checks |

## 13. Open questions
1. Pricing: per seat, per repo, or per org tier?
2. Should high/critical risk optionally set a failing GitHub check in v2?
3. Which model is the platform default (cost vs quality)?
4. Do we support GitHub Enterprise Server later?
5. Retention for findings history per plan (30 / 90 / 365 days)?
