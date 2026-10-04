---
name: akm-upstream-status
description: Report agentic-kit's outstanding upstream status from its upstream registry (threads filed, commented on or cited in Ruflo, Agentic QE, AgentDB, RuVector, RuvNet Brain, Codex, Claude Code, OpenCode and agent-browser). Use when the maintainer asks for an upstream report, upstream status, what is waiting on upstream, or which upstream fixes are ready.
---

# Upstream status

agentic-kit keeps one upstream registry, `src/lib/hook-audit/agentic-dependency-constraints.json`:
dependency policies, constraints, and the `watch` list of upstream threads.
`scripts/upstream-watch.mjs` checks the registry against GitHub and npm. `report`, `check` and
`ledger` only read. `record` fires the paid dispatch routine and builds a local ledger commit; it
is the daily workflow's command, so never run it without `--dry-run`.

## When asked for upstream status or a report

1. From the repository root, run:

   ```bash
   node scripts/upstream-watch.mjs report --json
   ```

   It exits 0 unless the command line is wrong.
   - If `registry.status` is not `valid`, report `registry.errors` and stop.
   - If `mode` is `offline`, say why (`offlineReason`, usually: run `gh auth login`) and that only
     what the registry records is shown.
2. Give the counts first, in plain language, from `counts`. Leave out groups with zero items. Then
   say when the scheduled watch last succeeded (`lastRun`); say so plainly when it is more than
   48 hours ago, unknown, or there is none (`lastRun` is null).
3. Then list the action items with their links, one report group at a time, in this order
   (the report's group titles):
   - "Could not check" first, each thread with its error from `fetchErrors`. When the thread
     itself could not be read nothing about it is known; when only its release could not be
     confirmed, its other groups still hold;
   - "Needs our reply";
   - "Released and actionable";
   - "Released, fix not confirmed": offer to confirm by hand and record `minVersion`; never
     dispatch it;
   - "Fixed upstream, ak still carries the workaround";
   - "Reopened upstream after ak recorded a fix";
   - "Closed upstream as not planned";
   - "No upstream activity for the stale limit";
   - "Waiting on upstream": every thread, never a count alone. Group them by repository,
     largest first, and give each as `#number, title (relation, last upstream update)` with its
     link. The relation is `filed`, `commented` or `referenced`, from the item's `relation`; the
     date is `upstream.updatedAt`, which can include our own comments or bots, so say so and
     offer to pull the latest comments when asked who replied last. The maintainer uses this
     list to pick threads to fix in a fork and open a pull request against, or to prod;
   - "Ready to retire";
   - "Constraints past their retest date";
   - "Our tracking issues".

   For each item give the id, title, URL and a one-line reason: who replied and when, which
   release, or which ak change is pending. Give "Fixed upstream, not yet released",
   "Released, waiting for the support window" and "Unmapped (no ak change recorded)" as counts
   only, unless asked. A held item is not
   dispatched: the oldest Ruflo in the support window (`supportWindow.floor`) predates its fix.
4. Offer the next actions that fit:
   - Draft a reply to an upstream thread. Show the draft; do not post it.
   - Dispatch a released item: branch `upstream/<id>` from `main`, make the entry's `adjustment`
     test-first, meet the dependency policy's `removalProof`, update the entry's `status` and
     `history`, and open a draft pull request.
   - Fix an open "Waiting on upstream" or stale thread: fork the upstream repository, branch,
     make the fix test-first there and prepare the pull request text. Show it; do not push or
     open the pull request.
   - Draft a friendly prod for a stale or unanswered thread that follows the upstream issue
     standard (problem, system info, repro, proposed fixes, impact for upstream's users). Show
     it; do not post it.
   - Update the registry for items the report proposes to retire or move.

## Rules

- The registry's publication policy is `explicit-user-approval-required`. Never post upstream,
  comment on a ledger commit, push, open a pull request or merge without the maintainer's
  explicit confirmation of that specific action.
- Never merge a dispatch pull request. The maintainer merges.
- A release is actionable only when it contains the merged fixing pull request or commit
  (`release.basis` says which). An unconfirmed release is never dispatched.
- Issue closure alone does not prove a fix (ADR-0041 §7).
- For events since a date, run `node scripts/upstream-watch.mjs check --since <iso-date>`.
  Each line is a ledger line: `UPSTREAM-WATCH <id> <event> <date> …`.
- For what the ledger recorded (history questions), run `node scripts/upstream-watch.mjs ledger [--id <owner/repo#n>] [--since <iso-date>]`.
  `--since` selects by the event's date; `--recorded-since <iso-time>` selects what the runs since
  then recorded (a notice's last line gives its run's time).

Details: `docs/upstream-watch.md`.
