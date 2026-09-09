# Verifying the Codex usage-scorecard fix on your own machine

**For:** anyone who uses Codex CLI and wants to check whether the two bugs
fixed in the usage parser affected their own numbers. Run the comparison locally
and review/redact its output before sharing it.

**You don't need to read the rest of this repo to use this document.**
Everything you need is below: what was wrong, why the fix can be trusted
without re-auditing the code yourself, how to run one script, and exactly
what to send back.

---

## The short version

A usage dashboard in this project ([`ak x dashboard`](../README.md), Usage
tab) reads local Claude Code and Codex CLI session logs and estimates what
they'd have cost at list-price API rates. On one real machine, the Codex
side of that estimate looked implausible — a single model row showing
roughly $935,000 and 1.46 trillion tokens, attributed to under 2,000
sessions, with **zero** recorded responses despite that volume.

Investigation found two real bugs in how this project's code parses Codex's
session logs (`src/lib/usage-parsers.mjs`, function `parseCodex`) — nothing
wrong with Codex CLI itself, and nothing you did. Both fixes are in the maintained
parser. This document lets you check, on your own machine, whether either
bug was actually inflating *your* numbers, and by how much.

## What was wrong

**Bug A — response counts were dropped for Codex.** Cosmetic only: every
Codex model row showed "0 responses" in the dashboard regardless of real
activity. Never affected any dollar or token figure.

**Bug B — subagent delegation could double-bill tokens.** This is the one
that matters for your numbers. Codex CLI's `thread_spawn` subagent
delegation writes a session-log file for the spawned subagent that
**replays its parent thread's entire prior token history** as duplicate
events, before the subagent's own new turns even begin. This is documented,
previously-reported Codex CLI behavior:

- [`openai/codex#14489`](https://github.com/openai/codex/issues/14489) —
  Codex re-emitting a stale cumulative token count on rate-limit-only
  updates, which a naive reader double-counts.
- [`ccusage/ccusage#884`](https://github.com/ccusage/ccusage/issues/884) —
  a different Codex usage-analytics tool (same job as this project's Usage
  tab) documenting that summing raw cumulative snapshots instead of taking
  the last one matched only 131 of 732 real sessions correctly.
- [`ccusage/ccusage#950`](https://github.com/ccusage/ccusage/issues/950) —
  the closest match to what was found here: a parent session that spawned
  12 subagents had its usage effectively counted 13 times over, because
  every subagent's log replayed the full parent history. Measured **91×**
  cost inflation in a real corpus (reported ~$9,041 against actual spend of
  ~$100).

This project's parser took each Codex log file's final cumulative token
count at face value, with no check for whether that file was a subagent
replaying its parent's history. The fix reads the field Codex CLI itself
writes to mark this (`session_meta.thread_source`) and excludes a
`"subagent"`-sourced file's tokens/cost from every total — while still
showing the session itself in the dashboard's session list, so nothing is
silently hidden.

## Why you can trust this without re-reading the diff

Three independent layers, so you don't have to take any single one on
faith:

1. **Prior art.** The three GitHub issues above describe this exact Codex
   CLI behavior, observed by other people, in other tools, before this
   project encountered it.
2. **Regression tests.** The fix is pinned by test cases built from the
   documented bug signature (`tests/kit/usage-index.test.mjs`). Run the tests from your checkout
   for its current result; the original pass count is not a release guarantee.
3. **A before/after comparison you can run yourself**, on your own data,
   computed by a separate cumulative-token parser. Pricing shares the
   maintained repository module; parsing does not import the dashboard
   implementation. This checks replay exclusion, not every dashboard path.

If you want the full engineering detail — exact formulas, file:line
citations, provider pricing sources — that's
[`docs/USAGE-SCORECARD-METRICS.md`](USAGE-SCORECARD-METRICS.md). You do not
need to read it to use this document.

## How to check your own numbers

Use a repository checkout and its supported Node runtime (Node 22.13.0 or a
maintained later release with unflagged `node:sqlite`). No dependency installation
is needed. The diagnostic itself makes no network requests and writes no files.

**1. Run the diagnostic from the checkout.**

```bash
node scripts/codex-usage-diagnostic.mjs
# Optional: another transcript root, with machine-readable output
node scripts/codex-usage-diagnostic.mjs --root /absolute/path/to/sessions --json
```

Keep the script with the repository: it imports `src/lib/pricing.mjs` so model
rates, aliases, and cache discounts cannot drift into a second embedded table.
Downloading the script alone is no longer supported.

**2. Read the two aggregate totals.** **ALL rollouts** includes every qualifying
session's last cumulative token record; **EXCLUDING explicitly marked subagent
rollouts** removes sessions whose first metadata record says `thread_source:
"subagent"`. The report gives the excluded token and estimated-cost percentages.
Historical `beforeFix_allSessions` and `afterFix_excludingSubagentReplays` JSON
keys remain for compatibility; they do not describe the current dashboard as buggy.

The script reads complete local rollout files into memory and parses their JSON
lines. It selects model, thread-source, cumulative token, and assistant-event
fields. Both legacy `agent_message` and newer `item_completed` / `AgentMessage`
responses qualify. First-session metadata takes precedence over later replayed
metadata, including when that first record has no thread source.

Reports contain numeric aggregates, not the scan root, transcript strings, prompts,
titles, session identifiers, timestamps, model names, or arbitrary thread-source
values. Unknown and other thread sources are counted separately. The default
scan root is `~/.codex/sessions`.

This remains an **independent cumulative snapshot comparison**, not a second
implementation of the dashboard. It does not read the Codex state ledger, split
cumulative tokens across models or days, or analyze context. A missing thread
source remains unknown and is included in totals. Both parsers currently use
string-valued `thread_source`; this script does not infer object-shaped sources.
Costs use the current maintained pricing snapshot, applied to each rollout's
last model, and represent API equivalents rather than actual subscription bills.
Use the dashboard and metrics reference for detailed current estimates.

## What to send back

Share the aggregate report only if you are comfortable sharing usage and estimated
cost totals. No transcript files or session descriptions are needed.

If the two totals are close, this comparison found little explicitly marked
subagent usage. It does not rule out a discrepancy in a parser path, ledger
classification, or historical model/day allocation that the diagnostic omits.
The excluded percentage measures usage in marked subagent rollouts, not a proof
that every excluded token was duplicated.

## Appendix — references

- Script: [`scripts/codex-usage-diagnostic.mjs`](../scripts/codex-usage-diagnostic.mjs)
- Full metrics reference: [`docs/USAGE-SCORECARD-METRICS.md`](USAGE-SCORECARD-METRICS.md) (its Appendix A covers these two bugs in full engineering detail)
- Design record: [`docs/adr/0009-usage-scorecard-local-transcript-analytics.md`](adr/0009-usage-scorecard-local-transcript-analytics.md)
