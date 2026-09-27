---
name: upstream-status
description: Report agentic-kit's outstanding upstream status from its upstream registry (threads filed, commented on or cited in Ruflo, Agentic QE, AgentDB, RuVector, RuvNet Brain, Codex and agent-browser). Use when the maintainer asks for an upstream report, upstream status, what is waiting on upstream, or which upstream fixes are ready.
---

# Upstream status

agentic-kit keeps one upstream registry, `src/lib/hook-audit/agentic-dependency-constraints.json`:
dependency policies, constraints, and the `watch` list of upstream threads.
`scripts/upstream-watch.mjs` checks the registry against GitHub and npm. It writes nothing.

## When asked for upstream status or a report

1. From the repository root, run:

   ```bash
   node scripts/upstream-watch.mjs report --json
   ```

   It exits 0 unless the command line is wrong.
   - If `registry.status` is not `valid`, report `registry.errors` and stop.
   - If `mode` is `offline`, say why (`offlineReason`, usually: run `gh auth login`) and that only
     what the registry records is shown.
2. Give the counts first, in plain language, from `counts`. Leave out groups with zero items.
3. Then list the action items with their links, one report group at a time, in this order
   (the report's group titles):
   - "Could not check" first, each thread with its error from `fetchErrors`: nothing about it
     is known;
   - "Needs our reply";
   - "Released and actionable";
   - "Released, fix not confirmed": offer to confirm by hand and record `minVersion`; never
     dispatch it;
   - "Fixed upstream, ak still carries the workaround";
   - "Reopened upstream after ak recorded a fix";
   - "Closed upstream as not planned";
   - "No upstream activity for the stale limit";
   - "Ready to retire";
   - "Constraints past their retest date";
   - "Tracking issues to migrate".

   For each item give the id, title, URL and a one-line reason: who replied and when, which
   release, or which ak change is pending. Give "Fixed upstream, not yet released",
   "Waiting on upstream" and "Unmapped (no ak change recorded)" as counts only, unless asked.
4. Offer the next actions that fit:
   - Draft a reply to an upstream thread. Show the draft; do not post it.
   - Dispatch a released item: branch `upstream/<id>` from `main`, make the entry's `adjustment`
     test-first, meet the dependency policy's `removalProof`, update the entry's `status` and
     `history`, and open a draft pull request.
   - Update the registry for items the report proposes to retire or move.

## Rules

- The registry's publication policy is `explicit-user-approval-required`. Never post upstream,
  comment on the ledger issue, push, open a pull request or merge without the maintainer's
  explicit confirmation of that specific action.
- Never merge a dispatch pull request. The maintainer merges.
- A release is actionable only when it contains the merged fixing pull request or commit
  (`release.basis` says which). An unconfirmed release is never dispatched.
- Issue closure alone does not prove a fix (ADR-0041 §7).
- For events since a date, run `node scripts/upstream-watch.mjs check --since <iso-date>`.
  Each line is a ledger line: `UPSTREAM-WATCH <id> <event> <date> …`.

Details: `docs/UPSTREAM-WATCH.md`.
