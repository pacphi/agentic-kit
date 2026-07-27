# Verifying the Codex usage-scorecard fix on your own machine

**For:** anyone who uses Codex CLI and wants to check whether the two bugs
fixed on this branch affected their own numbers — without sharing any
transcript content, session ids, titles, or file paths with anyone.

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
session logs (`src/lib/usage-index.mjs`, function `parseCodex`) — nothing
wrong with Codex CLI itself, and nothing you did. Both are fixed on this
branch. This document lets you check, on your own machine, whether either
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
   documented bug signature (`tests/kit/usage-index.test.mjs`), currently
   passing 87/87.
3. **A before/after comparison you can run yourself**, on your own data,
   computed by code that does **not** import or reuse the fix — so it's an
   independent check, not a restatement of the same claim. That's the
   script below.

If you want the full engineering detail — exact formulas, file:line
citations, provider pricing sources — that's
[`docs/USAGE-SCORECARD-METRICS.md`](USAGE-SCORECARD-METRICS.md). You do not
need to read it to use this document.

## How to check your own numbers

You'll need Node.js 18 or newer (`node --version` to check) and a terminal.
Nothing else — no `npm install`, no cloning this repo, no network access
beyond the one download below, and nothing gets written to your disk except
the script file itself.

**1. Get the script.** If you already have this branch checked out:

```bash
node scripts/codex-usage-diagnostic.mjs
```

If you don't have the repo, just download the one file:

```bash
curl -fsSL https://raw.githubusercontent.com/pacphi/agentic-kit/fix/codex-usage-scorecard-metrics/scripts/codex-usage-diagnostic.mjs -o codex-usage-diagnostic.mjs
node codex-usage-diagnostic.mjs
```

**2. Read the output before sending anything.** The script prints a report
with two totals: **"before the fix"** (every session log counted — this
should be close to what you'd currently see if you ran the unpatched
dashboard) and **"after the fix"** (subagent-replay logs excluded). It also
tells you what percentage of tokens/cost, if any, is attributable to
subagent-replay logs.

The script's own source is short and readable — open it in an editor if
you want to confirm for yourself what it does before running it. In short:
it walks `~/.codex/sessions/**/rollout-*.jsonl`, reads exactly three kinds
of field per line (`type`, `session_meta.thread_source`, and the numeric
fields inside `token_count.info.total_token_usage`), and never touches,
stores, or prints anything else — no prompts, no titles, no session ids, no
file paths, no timestamps. There is no code path in the script that could
emit those even by accident, because it never reads them into a variable in
the first place.

## What to send back

**Just the printed output block, in full — nothing else.** That's the
complete, minimal report; there's no need to trim it further or describe
your sessions in your own words. If you'd rather have a copy-pasteable
single blob instead of the human-readable report, run it with `--json`
instead.

If "before" and "after" are close (a low or zero percentage excluded), this
fix doesn't materially change what you were seeing, and the earlier
discrepancy has a different explanation worth digging into further. If a
meaningful percentage is excluded, that's the concrete number behind it —
not a guess.

## Appendix — references

- Script: [`scripts/codex-usage-diagnostic.mjs`](../scripts/codex-usage-diagnostic.mjs)
- Full metrics reference: [`docs/USAGE-SCORECARD-METRICS.md`](USAGE-SCORECARD-METRICS.md) (its Appendix A covers these two bugs in full engineering detail)
- Design record: [`docs/adr/0009-usage-scorecard-local-transcript-analytics.md`](adr/0009-usage-scorecard-local-transcript-analytics.md)
