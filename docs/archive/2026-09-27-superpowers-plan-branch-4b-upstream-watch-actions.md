# Branch 4b: upstream watch on GitHub Actions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Run the upstream watch as a scheduled GitHub Actions workflow that posts a deterministic ledger comment on pacphi/agentic-kit#243, and reduce the cloud routine to dispatch only (decision 14).

**Why:** The routine's first run (session cse_01Xb8wcBL8h335pxUeQ9sbnQ) was blind: a cloud session's GitHub access covers only attached repositories (HTTP 403 on every upstream repository), the sandbox has no `gh`, apt's `gh` 2.45 lacks `--slurp`, `gh auth status` called the injected token invalid while `gh api user` worked, and the script printed "No new upstream events." although every fetch failed.

**Architecture:** The script owns everything deterministic: reading the ledger comments, choosing SINCE, the check, and the comment text (`comment` subcommand, read-only). The workflow runs it with the workflow token, posts the body, and (re)applies the `upstream-dispatch` label when a `released` line carries `branch=`. The routine fires on that label and only dispatches.

**Maintainer decisions (2026-09-27):** 4b-A schedule `0 14 * * *` ships in this PR, with `workflow_dispatch`; 4b-B zero events with fetch errors posts nothing, the job fails only when blind (gh unusable, or every thread failed), partial errors go to the job summary, `checked-at` does not advance; 4b-C the Action labels #243 when there is dispatch work and a webhook on that label fires the routine.

**Ruling:** ledger authors live in `watchPolicy.ledger.authors`, not `watchPolicy.ours` (`ours` decides "our last word" in `classify.mjs`).

## Tasks (one unit commit each, test-first)

- [ ] **1. `fix(upstream-watch): read comment pages without gh --slurp`.** `fetch.mjs` `thread()` uses `gh api --paginate --jq '.[]'` and parses one JSON value per line (works on gh 2.x before 2.48). Test: the recorded call has `--jq` and no `--slurp`; a two-page NDJSON answer yields every comment.
- [ ] **2. `fix(upstream-watch): probe gh with a call any token can make`.** `auth()` runs `gh api rate_limit`; ENOENT → "not installed"; non-zero → "cannot reach GitHub" with gh's first stderr line. Test flips the `gh auth status` fixture.
- [ ] **3. `fix(upstream-watch): never report a quiet day when a check failed`.** `renderEvents(events, fetchErrors)` prints "No new upstream events." only with no fetch errors; otherwise "No new events from the threads checked; could not check N: ids." `check --json` gains `blind`.
- [ ] **4. `feat(upstream-watch): ledger authors in the registry`.** `watchPolicy.ledger.authors` (`["pacphi", "github-actions[bot]"]`), validator + JSON schema; `ours` unchanged.
- [ ] **5. `feat(upstream-watch): render the ledger comment in the script`.** `comment [--now <iso>] [--json]`: reads #243 comments (paginated, no slurp), keeps authors in `ledger.authors`, SINCE = newest `checked-at` in them or now − 7 days, runs the check with their bodies as the ledger, renders: a `text` code block of the lines ending `checked-at NOW` (previous SINCE when anything failed), then one fixed sentence per line, then one sentence naming unchecked threads. Empty output when no events. JSON: `{ since, now, checkedAt, post, blind, dispatch[], events, fetchErrors, body }`. Exit 3 when blind. Tests: a stranger's comment with a later `checked-at` and matching lines is ignored for both SINCE and dedupe; fetch errors keep SINCE; sentences for every event type; blind exit.
- [ ] **6. `ci(upstream-watch): daily workflow posts the ledger comment`.** `.github/workflows/upstream-watch.yml`: `schedule 0 14 * * *` + `workflow_dispatch` (`post` boolean) → job `watch` (`contents: read, issues: write`, `concurrency: upstream-watch`, `GH_TOKEN: github.token`); `pull_request` on the watch's paths → job `preview` (read-only, never posts, proves the token reads upstream). Post step asserts the body is non-empty and starts with the code fence, posts with `--body-file`, reads the posted length back. Dispatch step: `gh label create upstream-dispatch --force`, remove then add the label on #243. Job summary lists events and fetch errors. A static test pins permissions, the paths, and that `preview` never posts.
- [ ] **7. `docs(upstream-watch): the watch runs on Actions; the routine only dispatches`.** UPSTREAM-WATCH.md (the check, the ledger, a "Daily workflow" section, a "Dispatch routine" section with the new prompt), ADR-0041 §7 note + Updated, audit record decision 14 (+ 4b-A..C), skill text if it names the routine; update the doc test that reads the prompt.

## Gate and verification

Full gate set from `briefs/common.md` in the worktree, then an adversarial reviewer. Locally: `node scripts/upstream-watch.mjs comment --json` against real GitHub (read-only). CI: the `preview` job on the PR proves `GITHUB_TOKEN` reads upstream threads and the ledger.

## Unproven until after merge (with go-ahead)

- Commenting on the locked #243 as `github-actions[bot]` — first `workflow_dispatch` run.
- A label applied with `GITHUB_TOKEN` reaching the routine's webhook (GitHub suppresses workflow triggers from that token, not app webhooks) — first dispatch.
- `create_webhook_trigger`'s filter grammar; routine prompt update; re-enabling the routine.
