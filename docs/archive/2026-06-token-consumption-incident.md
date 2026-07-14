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
| **2nd optimization** | Compacted the auto-loaded `ruflo-reference` block: global `CLAUDE.md` 728→294 lines, ~8,628→~3,889 tokens (**-55%/session**); full reference moved on-demand |
| **Tooling shipped** | `ruflo-token-audit` CLI + user-scope Claude skill so anyone can self-diagnose a recurrence |

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

## Second optimization — per-session context tax (DONE)

87% of tokens were cache-reads of a **fixed per-session context** — median 38K, max 111K
tokens loaded *before any work* (global `~/.claude/CLAUDE.md` + superpowers preamble +
deferred tool defs). The largest kit-controlled slice was the auto-loaded
`ruflo-reference` block: a ~5.6K-token, 499-line CLI manual needed in full only
occasionally.

**Fix (chosen: compact pointer):**
- `claude/ruflo-reference.md` → compact ~40-line pointer block (832 tokens): CLI-not-MCP
  principle, when-not-to-use, most-used commands, decision tree, daemon-hygiene safeguard,
  and a pointer to the full doc + `ruflo <cmd> --help`.
- `claude/ruflo-reference-full.md` → NEW: the complete reference, deployed to
  `~/.config/ruflo/ruflo-reference-full.md` but **not** injected into CLAUDE.md (read on
  demand). Nothing lost.
- `install.sh` deploys the full doc alongside the compact template;
  `ruflo-reference-refresh --regenerate` stays compact.

**Result:** live global `~/.claude/CLAUDE.md` **728 → 294 lines, ~8,628 → ~3,889 tokens
(-55%, ~4,740 tokens/session saved).** Out of scope (not kit-controlled): the base system
prompt, tool/skill manifests, and the superpowers SessionStart preamble.

**Post-fix validation:** re-run the 7-day audit in a few days; expect sessions/day and
total tokens to drop sharply now that the daemons are gone and the per-session block is
~4.7K tokens lighter.

---

## Tooling shipped — self-service token audit

So anyone can diagnose a recurrence (or any automation leak) without re-deriving the
method, the ad-hoc `/tmp` scripts were consolidated into a maintained tool + skill.

**`bin/ruflo-token-audit`** (deployed to `~/.local/bin`, stdlib-only Python, no network):
```bash
ruflo-token-audit                 # last 7 days, human report
ruflo-token-audit --days 14       # widen the window
ruflo-token-audit --json          # machine-readable (dashboards/CI)
ruflo-token-audit --top 20        # more projects
ruflo-token-audit --no-daemons    # skip the `ps` daemon cross-reference
```
Emits: total + cost-weighted (Opus-equivalent reference, **not** plan billing) tokens;
by-day / by-model / by-project; sessions/day; per-session startup context tax; session-size
distribution; and a **daemon cross-reference** that flags running `ruflo daemon start`
processes whose workspace is a top-burn project.

**`ruflo-token-audit` skill** (user-scope, deployed to `~/.claude/skills/`, `/`-invocable
in every project): runs the engine, interprets interactive-vs-automation signals, checks
the daemon cross-reference, and returns a ranked diagnosis with exact fix commands.

**Sample prompts**
- *"Audit my Claude Code token usage for the last 7 days — what's burning my tokens?"*
- *"I'm hitting my Max limit in a day. Run the token audit and tell me why."*
- *"Check for runaway ruflo daemons and show me my heaviest projects this week."*

**Kit wiring:** `install.sh` now also deploys every `claude/skills/<name>/` to
`~/.claude/skills/` (loop-driven — new skills auto-deploy); `uninstall.sh` removes them
plus the on-demand full reference. `bin/ruflo-token-audit` rides the existing `bin/*`
deploy loop (no extra wiring).

---

## Commit log (this work, branch `main`)

| Commit | Summary |
|---|---|
| `b168454` | Daemon opt-in + TTL/idle reaper + shell-start auto-reaper + `⚙` statusline alarm; this findings doc |
| `c48b708` | Compact `ruflo-reference` block (full reference moved to on-demand `~/.config/ruflo/ruflo-reference-full.md`) |
| `ede698a` | Doc: mark the context-tax optimization complete |
| `cb11189` | Remove repo-relative `docs/` references from home-assembled CLAUDE.md content (repo-independent after install) |
| _(this change)_ | `ruflo-token-audit` CLI + skill; install/uninstall skill wiring; README + this doc |

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

**Assistant:** Wrote this document; committed and pushed the kit changes (`b168454`);
then executed the global `CLAUDE.md` context-tax optimization — compacted the
`ruflo-reference` block from ~5.6K to ~0.8K tokens (full reference preserved on-demand),
cutting the live global CLAUDE.md by 55% (~4,740 tokens/session), committed and pushed
(`c48b708`).

**User:** "these files you updated reference this repo's docs directory. Assume … the user
… move or destroy the repo … not constructive to ref such files in the assembled
~/.claude/CLAUDE.md."

**Assistant:** Removed all repo-relative `docs/` pointers from content assembled into the
user's home (`ruflo-reference.md`, `ruflo-reference-full.md`, `superpowers-reference.md`),
made the rationale self-contained, redeployed, and verified zero `docs/` refs remain in
`~/.claude/CLAUDE.md` or `~/.config/ruflo/*.md` — the home config is now repo-independent
(`cb11189`). Left the pre-existing transient `docs/TROUBLESHOOTING.md` stderr hints in
`shell/ruflo-functions.sh` as out-of-scope.

**User:** "The /tmp py scripts … include those in this repo … What kind of Claude skill
could we craft and a sample prompt …?"

**Assistant:** Consolidated the two ad-hoc `/tmp` scripts into a maintained
`bin/ruflo-token-audit` (parameterized, `--json`, daemon cross-reference) and a user-scope
`ruflo-token-audit` skill, wired skill deploy/uninstall into the kit, added README + this
section, and provided sample prompts. Then (this turn) updated this document with
everything to date.
