# Token Consumption — Recurrence & Cleanup (2026-06-11)

**Date:** 2026-06-11
**Trigger:** User ran the `ruflo-token-audit` skill and saw usage still dominated by
automation, then asked to confirm there were no runaway processes, prune always-on MCP
plugins, and find out what was scheduled.
**Outcome:** Found a **recurrence** of the June daemon leak — 17 per-project `ruflo`
headless-worker daemons — but this time the **TTL auto-reaper (shipped in the prior fix)
had already killed every one** ~1–2h before the audit. Cleaned up the litter they left:
removed 20 stale daemon-state files, disabled the `playwright` + `context7` plugins, and
cleared a 598 MB / ~35K-file headless-log backlog.

> Companion to [`token-consumption-findings-and-mitigation-2026-06.md`](2026-06-token-consumption-incident.md),
> which documents the original incident and the opt-in-daemon + TTL-reaper policy that
> caught this recurrence.

---

## TL;DR

| | |
|---|---|
| **Symptom** | Token audit still showed ~93% automation, 10,112 sessions / 8.2B tokens in 7 days |
| **Root cause** | **17** `ruflo` per-project headless-worker daemons (`@claude-flow` `headless-worker-executor.js`) running interval `claude --print` sweeps — a recurrence of the June leak across more projects |
| **What was scheduled** | NOT cron/launchd. Daemon interval workers: `audit` (30 min), `optimize` (60 min), `testgaps` (60 min), + `map`/`consolidate`/etc. (5/10/15/120 min), each spawning a headless Claude session |
| **Scale** | **34,533** total worker runs all-time; ~80 enqueues/hr, dead-flat 24/7 |
| **The good news** | Every daemon was **already dead** — the shell-start **TTL auto-reaper** (12h) from the prior fix reaped them ~1–2h before the audit. The safety net worked. |
| **Cleanup 1** | Removed **20 stale daemon-state files** (`daemon-state.json`/`daemon.pid`/`daemon-children.json`) across 17 projects |
| **Cleanup 3** | Disabled `playwright` + `context7` **plugins** (per-session MCP tool-def tax; only 94+24 calls in 7 days) |
| **Cleanup 2** | Cleared **~35,300 files / 598 MB** of headless worker logs across 15 dirs |
| **Net** | No live runaway processes; automation machinery stopped, state + logs gone; two always-on MCP plugins off |

---

## How the audit was done

Same method as the original: walk `~/.claude/projects/**/*.jsonl`, sum each assistant
message's `message.usage`. This session used the shipped self-service tool:

```bash
python3 ~/.claude/skills/ruflo-token-audit/scripts/ruflo-token-audit.py --days 7
```

This time the investigation went **past** the aggregate numbers into *what was generating
the sessions*, by decoding the transcripts' leading `queue-operation` records and tracing
them to the daemon that produced them.

---

## Findings

### 7-day audit totals
```
Assistant API responses: 124,231   Active sessions: 10,112
TOTAL TOKENS: 8,228.9M  (input 203.1M | output 80.7M | cache-read 7,208.9M | cache-write 736.2M)
cache efficiency: 88% cache-reads
Cost-weighted (Opus-equivalent reference): ~$9,631
```

### By model — still not interactive Opus
```
haiku    total=4263.9M  out=35.6M  cache-read=3843.3M
sonnet   total=3153.8M  out=40.9M  cache-read=2792.0M
opus     total= 612.1M  out= 3.6M  cache-read= 573.6M   <- interactive (~7%)
other    total= 199.1M
```

### Activity by hour — flat 24/7 = automation
~4,000 sessions/hr at 3am–5am, same as midday. A human doesn't do that. The enqueue
cadence held **~80/hr around the clock**, then collapsed (80 → 4) at ~23:00 UTC when the
auto-reaper killed the daemons.

### The smoking-gun chain (how it was traced)

1. **Every recent transcript starts with `queue-operation` `enqueue`** carrying a prompt —
   programmatic, not typed.
2. **Only 4 distinct enqueued prompts**, three on a steady cadence:
   ```
   1,621  Analyze this codebase for security vulnerabilities: ...
   1,068  Analyze this codebase for performance optimizations: ...
     812  Analyze test coverage and identify gaps: ...
      17  Review this change for security vulnerabilities. ...
   ```
3. **No cron, no launchd, no tmux/screen, no shell-rc auto-start.** The only rc hook is
   `~/.zshrc` sourcing `ruflo-functions.sh` — which **reaps**, never starts.
4. **Exact-phrase grep** located the templates in
   `…/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/services/headless-worker-executor.js`,
   which defines interval workers that `spawn('claude', ['--print'])`:

   | Worker | Interval | Prompt |
   |---|---|---|
   | `audit` | 30 min | "Analyze this codebase for security vulnerabilities…" |
   | `optimize` | 60 min | "Analyze this codebase for performance optimizations…" |
   | `testgaps` | 60 min | "Analyze test coverage and identify gaps…" |
   | `map`, `consolidate`, … | 5/10/15/120 min | metrics/context housekeeping |

5. **Per-project daemon state** in `<project>/.claude-flow/daemon-state.json` confirmed it:
   17 projects, all `"running": true`, with per-worker `runCount`s. **34,533 total runs.**

### Daemon census (all dead at audit time)
```
running  pid      alive   totalRuns   project
True     -        no-pid       7,361   ai/kahoot-quiz-generator
True     -        no-pid       6,154   ai/whetstone
True     -        no-pid       6,126   ai/spring-ai-openrouter-example
True     -        no-pid       5,044   ai/mario-kart-knockoff
True     -        no-pid       3,212   ai/sindri
True     -        no-pid       2,424   ai/ruvos
True     -        no-pid       1,283   ai/emailibrium
True     91254    dead           556   ai/viral-coach
True     98277    dead           563   ai/ruflo-machine-ref
True     65255    dead            37   ai/neon-drift
True     -        no-pid     249..529   cf-toolsuite/* (6 projects), agentic-incubator/*
```
Every recorded PID was dead; `ps` showed **zero** live ruflo/claude-flow/worker processes
and only one `claude` (this interactive session). The `"running": true` flags were stale
litter — the daemons died without updating their own state.

### Why it recurred but didn't run for weeks
The June fix made daemons opt-in and added a **12h TTL auto-reaper** on interactive shell
start (`_ruflo_daemon_autoreap` in `ruflo-functions.sh`). Daemons still got started again
(likely via `ruflo daemon start` / onboarding across more projects), but the reaper killed
each once it exceeded TTL — capping the damage at hours instead of the original 19 days.
**The prior mitigation did its job;** what remained was cleanup of stale state + logs.

### Playwright + context7 are plugins, not global MCP
- `~/.claude.json` has **no** top-level `mcpServers`.
- Both come from `enabledPlugins` in `~/.claude/settings.json`
  (`playwright@claude-plugins-official`, `context7@claude-plugins-official`), each shipping
  an MCP server that loads **every session** as a tool-def tax.
- 7-day usage: **94 playwright + 24 context7** calls — tiny vs. the per-session tax across
  10K sessions. Safe to disable (kept installed for re-enable).

---

## Actions performed

### 1 — Stale daemon-state cleanup
- Safety-verified every daemon PID dead; `ruflo-daemon-gc` confirmed "no stale daemons".
- Removed **20 files** (`daemon-state.json` / `daemon.pid` / `daemon-children.json`) across
  17 projects. 0 remaining. Nothing can falsely report `running: true` or resume from old
  state. Worker logs left for step 2.

### 3 — Plugin prune
- Backed up `~/.claude/settings.json` → `settings.json.bak`.
- Flipped `context7` and `playwright` to `false` in `enabledPlugins`; JSON re-validated.
- Plugins stay installed; flip back to `true` to re-enable. **Effective next session.**

### 2 — Headless log backlog
- Measured **~35,300 files / 598 MB** across 15 `.claude-flow/logs/headless` dirs
  (largest: kahoot 163 MB, spring-ai-openrouter 110 MB, whetstone 107 MB, sindri 71 MB).
- Cleared all contents (empty dirs left in place; recreated only on an explicit daemon
  start). Verified **0 files / 0 MB** remaining.

### Cleanup summary
| Action | Result |
|---|---|
| 1 — stale daemon state | 20 files removed across 17 projects; 0 daemons live |
| 3 — plugin prune | context7 + playwright disabled (next session); `settings.json.bak` saved |
| 2 — headless log backlog | 35.3K files / 598 MB cleared |

---

## Recommendations / open items

- **Decide on the daemon going forward.** It's opt-in and won't restart on its own. If the
  scheduled `audit`/`optimize`/`testgaps` sweeps are never wanted, simply never run
  `ruflo daemon start`; the TTL reaper covers accidental starts. (Worth checking whether an
  onboarding path — e.g. `ruflo-onboard` / `ruflo-resync` — is what re-started them across
  these 17 projects, and gating it.)
- **Re-run the audit in a day or two** to confirm sessions/day collapses to interactive-only
  levels now that the daemons are gone and two MCP plugins are off.
- The empty `.claude-flow/logs/headless` dirs and `.claude-flow/` folders were left in
  place (non-destructive); they can be removed per-project if desired.

---

## Session transcript

Verbatim user prompts; assistant turns summarized with the actions/data that mattered.

**User:** "Run the ruflo token audit skill"

**Assistant:** Ran the bundled `ruflo-token-audit.py --days 7`. Reported the diagnosis:
~93% automation (Haiku+Sonnet 7.4B vs Opus 612M), 10,112 sessions, flat 24/7 hourly
histogram, 48% tiny sessions, 288M-token startup tax, six projects each ~1,800
sessions/wk. Noted no daemons were *currently* running and offered to find the scheduler.

**User:** "Can you make sure we don't have any runaway processes in sessions? If playwright
and context7 are installed globally, maybe we should prune them away? And yes, find out
what is scheduled. I want the findings first, then we can act upon them."

**Assistant (findings-only):** Live-process sweep — only this session's `claude` (pid 6883);
playwright/context7 are its children, not orphans. No cron/launchd/tmux. Decoded the
transcripts' leading `queue-operation` records → 3 templated "Analyze this codebase…"
prompts at ~80/hr → exact-phrase grep → `@claude-flow` `headless-worker-executor.js` →
17 per-project `daemon-state.json` files (34,533 total worker runs), all `running:true`
but every PID dead, reaped ~1–2h earlier by the `~/.zshrc` TTL auto-reaper. Established
playwright/context7 are **plugins** (not global MCP) with tiny usage. Presented 3 proposed
actions.

**User:** "Let's take action on 1 and 3."

**Assistant:** Safety-verified all daemon PIDs dead + `ruflo-daemon-gc` clean. Removed 20
stale daemon-state files across 17 projects (0 remaining). Backed up `settings.json` and
disabled the `context7` + `playwright` plugins; JSON validated. Flagged plugin change takes
effect next session. Surfaced action 2 (headless log backlog) as still open.

**User:** "Clear them too"

**Assistant:** Measured ~35,300 files / 598 MB across 15 headless log dirs, cleared all
contents (empty dirs retained), verified 0 remaining. Gave the full cleanup summary and net
state: no live runaway processes, automation machinery stopped, state + logs gone, two
always-on MCP plugins off.

**User:** "Let's log this session from start to finish similar to what we had done here,
@docs/usage/token-consumption-findings-and-mitigation-2026-06.md. I want to colocate this
in a file in same directory."

**Assistant:** Wrote this companion document.
