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
3. Then list the action items with their links, in this order: needs our reply; released and
   actionable; fixed upstream but ak still carries the workaround; reopened; closed not planned;
   no upstream activity for the stale limit; ready to retire; constraints past their retest
   date; tracking issues to migrate. For each item give the id, title, URL and a one-line
   reason: who replied and when, which release, or which ak change is pending. Give "waiting"
   and "unmapped" as counts only, unless asked.
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
- A "candidate" release is the first version published after the fix. Confirm the fix is in
  it before dispatching.
- Issue closure alone does not prove a fix (ADR-0041 §7).
- For events since a date, run `node scripts/upstream-watch.mjs check --since <iso-date>`.
  Each line is a ledger line: `UPSTREAM-WATCH <id> <event> <date> …`.

Details: `docs/UPSTREAM-WATCH.md`.
