# Token Consumption — Findings & Mitigation (June 2026)

**Date:** 2026-06-11
**Trigger:** User observed Max-plan usage being exhausted in 1–2 days and asked whether
this was misuse or a sign the plan wasn't valuable.
**Outcome:** Root cause was six leaked `ruflo` background daemons (not interactive use).
Killed them, reaped 10 orphaned MCP servers, and changed the kit's daemon policy to
**opt-in + aggressive TTL reaper + statusline visibility** so it cannot recur.

---

## TL;DR

| | |
|---|---|
| **Symptom** | Max-plan quota burned in 1–2 days |
| **Root cause** | 6 immortal `ruflo daemon start` processes (1 per onboarded project), oldest running **19 days**, each spawning Haiku/Sonnet worker sessions 24/7 |
| **Scale** | ~10,100 sessions / 8.1B tokens in 7 days; ~94% background machinery, **~6% interactive Opus** |
| **Why invisible** | `ruflo daemon status` only checks the *current* workspace; the six were for *other* workspaces |
| **Fix** | Daemon now **opt-in**; `ruflo-daemon-gc` reaps by **TTL (12h)/orphan**; auto-reaper on shell start; `⚙ N daemons` statusline alarm |
| **Immediate cleanup** | 6 daemons killed + 10 orphaned `beads-mcp` servers reaped (~175 MB) |
| **Still open** | 87% of tokens were cache-reads of an oversized fixed per-session context (global `CLAUDE.md` + superpowers preamble) — next optimization |

---

## How the audit was done

Claude Code writes a full JSONL transcript of every session under
`~/.claude/projects/<encoded-cwd>/<session>.jsonl`. Each `assistant` line carries a
`message.usage` object: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`, plus per-tier cache-creation breakdown and `model`.

Two Python passes over all project dirs, filtered to the last 7 days by `timestamp`:
1. Aggregate tokens by **day / model / project**, with an Opus-equivalent cost weight
   (input $15, output $75, cache-write $18.75/$30, cache-read $1.50 per 1M).
2. Count **sessions/day**, the per-session **startup context tax** (cache-read on the
   first assistant message), and **sessions-per-project** (the automation tell).

> Reusable: the scripts live at `/tmp/token_audit.py` and `/tmp/token_audit2.py` during
> the session; the method is just "walk `~/.claude/projects/**/*.jsonl`, sum `message.usage`."

---

## Findings

### 7-day totals
```
Assistant API responses: 123,757   Active sessions: 10,106
TOTAL TOKENS: 8.1B   (input 203M | output 80M | cache-read 7,085M | cache-write 734M)
Cost-weighted (Opus-equiv): ~$9,327
```
**87% of all tokens are cache-reads** — the same large context re-read across thousands
of sessions.

### By day (cost-weighted $, total tokens, output)
```
2026-06-04   $ 410.68    396.0M   out=6.1M
2026-06-05   $1094.46   1281.3M   out=15.5M
2026-06-06   $  71.76    245.7M   out=2.0M
2026-06-07   $   0.00        0K   out=0K
2026-06-08   $1381.99   1080.5M   out=7.4M
2026-06-09   $3728.69   1222.4M   out=10.7M
2026-06-10   $1552.14   2353.9M   out=23.7M
2026-06-11   $1086.91   1523.4M   out=14.7M
```

### By model — the burn is NOT interactive Opus
```
haiku    total=4262.1M  out=35.6M  cache-read=3841.8M
sonnet   total=3157.2M  out=41.0M  cache-read=2794.7M
opus     total= 484.8M  out= 2.9M  cache-read= 449.5M   <- interactive work (~6%)
other    total= 199.1M
```

### Sessions/day — automation, not a human
```
06-04   661     06-08  2,842
06-05 1,202     06-09  1,769
06-06   504     06-10  1,831
06-07    67     06-11  1,243
```
~1,440 sessions/day average = one new session **every minute, around the clock**.

### Startup context tax (per session, before any real work)
```
sessions measured: 10,106
median: 38K   p90: 58K   max: 111K
sum of all startup loads: 288M tokens just to BOOT sessions
48% of sessions are tiny (<200K tokens) — hooks/workers/subagents
```

### Top projects — ~1,800 sessions each is a fingerprint
```
1,879  mario-kart-knockoff
1,800  spring-ai-openrouter-example
1,798  whetstone
1,797  kahoot-quiz-generator
1,567  ruvos
  858  emailibrium
```

### The smoking gun — six immortal daemons
```
PID    WORKSPACE                      SINCE     UPTIME
23966  kahoot-quiz-generator          May 23    19 days
24431  spring-ai-openrouter-example   May 26    16 days
55709  whetstone                      May 26    16 days
65255  mario-kart-knockoff            May 29    13 days
4711   ruvos                          Jun 5      6 days
89485  emailibrium                    Jun 8      3 days
```
Each is `node …/cli.js daemon start --foreground --quiet --workspace <project>`,
reparented to PID 1, dispatching background workers (audit/optimize/testgaps/map/
document) that each spin up Claude sessions. They map 1:1 to the top-burn projects.

---

## Root cause (policy-level, in our own kit)

```
ruflo-setup-project  ──starts──►  ruflo daemon start  ──►  daemon runs forever
   (per project)                                            (nothing stops it)
   × 6 projects                                             × weeks = token leak
ruflo-daemon-gc  ──only reaped──►  daemons whose workspace was DELETED  ✗ missed all 6
```

- `ruflo-setup-project` explicitly ran `ruflo daemon start` for every onboarded project.
- Per our own design spec: *"Nothing in the kit ever stops a daemon."*
- The existing `ruflo-daemon-gc` only reaped daemons whose **workspace folder was deleted**
  — all six projects still existed, so it skipped every one.
- `ruflo daemon status` reads only the current workspace's pidfile, so the six ran invisibly.

---

## Fix (chosen: "opt-in AND aggressive reaper")

Source changes in `shell/ruflo-functions.sh` + `shell/ruflo-lib.sh`, deployed to
`~/.config/ruflo/` (same `cp` that `install.sh` performs):

1. **Opt-in daemon.** `ruflo-setup-project` no longer auto-starts a daemon; it prints a
   hint (`ruflo daemon start` to opt in).
2. **TTL/idle reaper.** `ruflo-daemon-gc` now reaps a daemon if its workspace is gone
   **or** it has run longer than `RUFLO_DAEMON_TTL_SECS` (default `43200` = 12h). New
   helper `_ruflo_daemon_age_secs` parses `ps -o etime=` portably (macOS BSD + Linux).
3. **Auto-reaper on shell start.** `_ruflo_daemon_autoreap` runs when the functions file
   is sourced into an **interactive** shell, throttled to once per
   `RUFLO_DAEMON_AUTOREAP_THROTTLE` secs (default 300) via a tmp stamp; reaps stale
   daemons and warns about any still running. Opt out: `RUFLO_DAEMON_AUTOREAP=0`.
4. **Statusline visibility.** Footer gains `⚙ N ruflo daemon(s)` — absent at 0, dim at
   1–2, **yellow alarm at ≥3** (`— ruflo-daemon-gc --kill`). Global count, tmp-cached,
   one `pgrep` per 30s window. Opt out: `RUFLO_DAEMON_STATUSLINE=0`.

**New env knobs**

| Var | Default | Effect |
|---|---|---|
| `RUFLO_DAEMON_TTL_SECS` | `43200` (12h) | Max daemon age before reap (`0` = orphan-only) |
| `RUFLO_DAEMON_AUTOREAP` | `1` | `0` disables shell-start auto-reap |
| `RUFLO_DAEMON_AUTOREAP_THROTTLE` | `300` | Min secs between auto-reap scans |
| `RUFLO_DAEMON_STATUSLINE` | `1` | `0` hides the `⚙` segment |
| `RUFLO_DAEMON_STATUSLINE_TTL_MS` | `30000` | Statusline daemon-count cache window |

**Verification:** `bash -n` + `zsh -n` on both files; `node --check` on the embedded
statusline JS; age-parser checked against 5 `etime` formats; `ruflo-daemon-gc` dry-run
and deployed-copy source-test both clean.

---

## Immediate cleanup performed

- **6 rogue daemons** SIGTERM'd and verified dead. (Note: an initial "terminated cleanly"
  report was a false positive from zsh not word-splitting an unquoted PID list — caught
  and corrected by re-checking each PID individually before re-killing.)
- **10 orphaned `beads-mcp` servers** (PPID=1, leaked from dead sessions, oldest 13 days,
  ~175 MB total) reaped — only PPID=1 orphans, leaving this session's own context7 +
  playwright MCP servers untouched.
- Final census: **zero daemons, zero orphaned MCP servers**.

---

## Still open (next optimization)

87% of tokens were cache-reads of a **fixed per-session context** — median 38K, max 111K
tokens loaded *before any work* (large global `~/.claude/CLAUDE.md` + superpowers preamble
+ deferred tool defs). With thousands of sessions this compounds. Next lever: trim the
global `CLAUDE.md` (keep always-relevant rules; move the long ruflo reference to
on-demand). Every line removed has ~10,000× leverage across a week of sessions.

**Post-fix validation:** re-run the 7-day audit in a few days; expect sessions/day and
total tokens to drop sharply now that the daemons are gone.

---

## Session transcript

Verbatim user prompts; assistant turns summarized with the actions/data that mattered.

**User:** "I would really liek to know why I apper to be burning tokens hard and using up
my usage in like 1 or two days. Is there a way you could query across sessions for the
past week? It's genuinely making me think I am not using Claude right or that the Max plan
is just not going to be valuable for me going forward."

**Assistant:** Confirmed it's queryable — every session is a JSONL transcript with
per-message `usage`. Wrote two aggregation passes over `~/.claude/projects/**/*.jsonl`
(7-day window). Surfaced the totals above: 8.1B tokens, ~10,100 sessions, 87% cache-reads,
Haiku+Sonnet dominating, ~1,800 sessions each across four near-identical projects.
Diagnosis: not interactive misuse — an automation layer (background daemons/workers) plus
a heavy fixed per-session context tax. Offered to trace the spawner or trim the context.

**User:** "Oh my God! YEs, let's find these rogue processes and kill them/shut them down."

**Assistant:** Listed all `claude`/`ruflo` processes with lineage. Found six
`daemon start --foreground` processes (one per top-burn project, oldest 19 days), all
PPID=1, mapping 1:1 to the burn list. Identified the interactive session (PID 6883) and
the `beads-mcp` servers as not-to-kill. Confirmed no child workers and no launchd/cron
supervisor (won't respawn). SIGTERM'd the six — first verify pass was a zsh
word-splitting false positive; re-checked each PID, re-killed, confirmed all six dead.
No `daemon start` processes remained.

**User (mid-work):** "So how do we fix this so it never happens again?"

**Assistant:** Traced the cause to the kit itself: `ruflo-setup-project` auto-starts a
per-project daemon that nothing ever stops, and `ruflo-daemon-gc` only reaps
deleted-workspace orphans (missed all six). Presented three policy options.

**User (decision):** Chose **"Opt-in AND aggressive reaper."**

**User (mid-work):** "Let's cleanup orphaned processes too once done with this current set
of updates."

**Assistant:** Implemented all four source changes (opt-in, TTL reaper, shell-start
auto-reaper, statusline `⚙` segment), syntax/functionally verified, and deployed to
`~/.config/ruflo/` (also refreshing a stale installed copy). Then reaped the 10 orphaned
`beads-mcp` servers (PPID=1 only), leaving the live session's MCP servers intact. Final
census clean. Flagged that changes apply to new shells (`exec zsh`) and that the
statusline `⚙` appears after a project's `statusline.cjs` is re-injected.

**User:** "Ok, great, I need a transcription of this entire session … documented in
docs/usage/token-consumption-findings-and-mitigation-2026-06.md. Then, let's commit this
work and push. Then, let's work on the other optimizations you suggested."

**Assistant:** Wrote this document; committed and pushed the kit changes; proceeded to the
global `CLAUDE.md` context-tax optimization.
