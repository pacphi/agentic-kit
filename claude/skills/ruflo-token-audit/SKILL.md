---
name: ruflo-token-audit
description: "Use when the user asks where their Claude Code usage/tokens are going, is burning through their plan unexpectedly fast, hitting limits, or wants a breakdown of their Claude Code activity. Produces a COMPREHENSIVE usage report from local session transcripts: tokens by day/model/project, tool usage, MCP usage, subagent fan-out, web-tool calls, cache efficiency, busiest sessions, hourly activity, and a runaway-daemon cross-reference — distinguishing interactive work from automation and recommending concrete fixes."
user-invocable: true
---

# Claude Code Usage Audit (ruflo-token-audit)

A **comprehensive** picture of Claude Code usage, built from the local session transcripts
in `~/.claude/projects/**/*.jsonl` (each assistant message records its token usage, tool
calls, model, and metadata). This is **not limited to "tokens ruflo burns"** — it covers
ALL Claude Code activity (interactive, subagents, hooks, MCP, web tools) and answers two
questions: *where is my usage going?* and *is any of it runaway automation?*

This skill is **self-contained** — it bundles its own engine, so it works even if the full
agentic-kit kit isn't installed.

## When to use

Trigger on: "where are my tokens/usage going", "why is my usage so high", "break down my
Claude Code activity", "I'm hitting my Max/Pro limit", "what am I spending tokens on",
"is the plan worth it". Also proactively if the user mentions surprising usage.

## Procedure

1. **Run the bundled engine.** Prefer the copy that ships *inside this skill* (works with
   no kit install); fall back to the PATH command if present:
   ```bash
   # self-contained (always available wherever this skill is installed):
   python3 ~/.claude/skills/ruflo-token-audit/scripts/ruflo-token-audit.py --days 7
   # …or, if the agentic-kit kit put it on PATH:
   ruflo-token-audit --days 7
   ```
   - Honor any window the user gives ("past month" → `--days 30`).
   - `--top N` widens each section; `--json` gives machine-readable output; `--no-daemons`
     skips the `ps` cross-reference.
   - If `python3` isn't found, say so — the engine is stdlib-only Python 3.

2. **Read the whole picture, then lead with the headline.** The report has many sections;
   synthesize, don't echo. Key sections and what they tell you:
   | Section | Read it for |
   |---|---|
   | BY MODEL | Opus = interactive; heavy Haiku/Sonnet = automation/subagents |
   | SESSIONS PER DAY | tens = human; hundreds–thousands = automation (≈one/min = robotic) |
   | ACTIVITY BY HOUR | a flat 24h histogram (busy at 3am) is automation, not a person |
   | TOOL USAGE | what the work actually *is* (Bash/Read/Edit vs Task/MCP) |
   | MCP USAGE | per-server call volume; heavy MCP also means big per-session tool-def tax |
   | SUBAGENT FAN-OUT | Task spawns + sidechain share — how much is delegated/parallel |
   | BUSIEST SESSIONS | a single runaway conversation surfaces here by token total |
   | CACHE EFFICIENCY | high cache-read% is normal/cheap; flag only with huge automated volume |
   | STARTUP CONTEXT TAX | fixed per-session cost (CLAUDE.md + tool/skill manifests) × many sessions |
   | RUNNING DAEMONS | live `ruflo daemon start` mapped to top-burn projects (the classic leak) |

3. **Check the daemon cross-reference** (most common automation leak). Each daemon spawns
   worker sessions continuously and is **invisible to `ruflo daemon status`** (that checks
   only the current workspace). If daemons are listed and the user authorizes:
   ```bash
   ruflo-daemon-gc            # preview stale daemons
   ruflo-daemon-gc --kill     # stop them
   ```
   Then re-run the audit to confirm. (These `ruflo-*` helpers exist only with the kit; if
   absent, fall back to `kill <pid>` on the daemon PIDs the report lists.)

4. **Report like a diagnosis, not a data dump.** Lead with the verdict (where usage is
   going + whether it's interactive or automation + the single biggest driver). Then a
   small supporting table, then ranked concrete fixes with exact commands. Levers worth
   naming: kill runaway daemons; trim an oversized global/project `CLAUDE.md`; drop or gate
   a heavy always-on MCP (its tool defs are a per-session tax); reduce hook/loop fan-out.

## Caveats (be honest)

- The cost-weight is an **Opus-equivalent reference** to compare line items — NOT the
  user's actual Max/Pro plan billing. Don't present it as dollars owed.
- High **cache-read** is normal and cheap; flag it only when it's huge *and* multiplied by
  thousands of automated sessions.
- A few hundred sessions (or Task spawns) from legitimate parallel subagent work is not a
  leak. The tell is *unattended, repeating* activity — flat overnight hours, near-identical
  session counts across projects, daemons running.

## Sample prompts the user can use

- "Audit my Claude Code usage for the last 7 days — where is it all going?"
- "Break down what I've been spending tokens on this week (tools, models, projects)."
- "I'm hitting my Max limit in a day. Run the usage audit and tell me why."
- "Check for runaway ruflo daemons and show me my heaviest sessions."

## Background

Built after a real incident: six leaked `ruflo daemon start` processes (one per onboarded
project, oldest running 19 days) produced ~10,100 sessions / 8.1B tokens in a week — ~94%
background machinery vs ~6% interactive Opus. The kit now makes the daemon opt-in and
auto-reaps stale ones; this audit is how you catch a recurrence or any other usage surprise.
