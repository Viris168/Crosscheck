# T5a — Push / CI webhooks + event recording (Lane A, milestone 5)

**Wave 4** · **Branch:** `feat/t5a-webhooks` · **Lane:** A · **Needs merged:** T0, T2c
**Spec:** `tasks/T-branch-tree.md` → "Contracts" (`GitEvent`, `tree/refs-changed`), "GitHub App changes".

## You own (edit only these)
- `apps/web/src/server/github/webhook.ts` (HANDLERS map), `server/github/tree-events.ts` (new) + test,
  `server/github/payloads.ts`, `server/github/index.ts`, `server/github/__fixtures__/`

## Do
1. Handlers for `push`, `check_run`, `check_suite`, `status`; also extend the existing `pull_request`
   handler to send `tree/refs-changed` (don't change its review behavior).
2. Each handler: zod-parse only the fields needed (refs, SHAs, `created`, `deleted`, `forced`, PR number,
   CI state); **never** read `commits[].message`, `head_commit`, author emails or file lists. Find the
   `Repo` by `repository.id`; unknown or inactive repo → `{ handled: false }`.
3. Insert a `GitEvent` (`deliveryId` unique → idempotent): kinds `branch_created` (push `created`),
   `branch_deleted`, `force_push` (`forced`), `push`, `pull_request`, `ci`. Tag pushes (`refs/tags/`) are ignored.
4. For `branch_created`, store `before`/`after`; T5b decides the recorded parent.
5. For `ci` events, upsert `CommitCi` directly from the payload when it is a branch head (cheap), then send.
6. `inngest.send({ name: 'tree/refs-changed', data: { repoId, orgId, eventId } })`. Respond < 1 s.

## Tests
Fixtures for each event (strip messages from the fixtures too). Duplicate delivery → one `GitEvent`.
Tag push ignored. A payload with a commit message: assert it is not in the DB row or the event.

## Not yours
Fetching and snapshot updates (T5b). Subscribing the App to events (T2a doc; the user does it on GitHub).
