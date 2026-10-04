---
name: ak-token-audit
description: Report where Claude Code tokens and usage are going from the local session transcripts, by day, model, project, tool, MCP server and subagent, with cache efficiency and a runaway-daemon cross-reference. Use when the maintainer says "where are my tokens going", "usage breakdown", "burning through my plan", or "hitting limits".
---

# Token audit

A standalone, offline picture of Claude Code usage, built from the local session transcripts in
`~/.claude/projects/**/*.jsonl` (each assistant message records its tokens, tool calls and model).
It is the maintainer's second opinion beside `ak usage` and the dashboard's Usage view, and it
answers two questions: where is the usage going, and is any of it runaway automation.

## When to use

The maintainer asks where tokens or usage are going, why usage is so high, what a week of Claude
Code activity looked like, or says the plan is being burned or limits are being hit.

## Steps

1. From the repository root, run the engine (stdlib-only Python 3; if `python3` is missing, say
   so and stop):

   ```bash
   python3 .claude/skills/ak-token-audit/scripts/ruflo-token-audit.py --days 7
   ```

   Use the window the maintainer gives ("past month" is `--days 30`). `--top N` widens each
   section, `--json` prints machine-readable output and `--no-daemons` skips the process list.
2. Read the whole report, then lead with the headline. Synthesize; do not echo the sections:

   | Section | Read it for |
   | ------- | ----------- |
   | BY MODEL | The model mix; a model name alone does not show whether work is interactive or automated |
   | SESSIONS PER DAY | Volume and bursts to investigate; counts alone do not prove automation |
   | ACTIVITY BY HOUR | Timing patterns to line up with the maintainer's own activity and with processes |
   | TOOL USAGE | What the work is (Bash, Read and Edit against Task and MCP calls) |
   | MCP USAGE | Calls per MCP server; the cost of loaded tool definitions depends on the host |
   | SUBAGENT FAN-OUT | Task spawns and the sidechain share: how much is delegated |
   | BUSIEST SESSIONS | A single runaway conversation shows up here by its token total |
   | CACHE EFFICIENCY | A high cache-read share is normal and cheap; flag it only with huge automated volume |
   | STARTUP CONTEXT TAX | The fixed per-session cost (`CLAUDE.md`, tool and skill manifests) times the session count |
   | RUNNING DAEMONS | Live `ruflo daemon start` processes mapped to the top-burn projects |

3. Check the daemon cross-reference, the most common automation leak. A daemon process alone does
   not prove model spend: Ruflo's daemon runs local-only workers by default, and AI workers are
   enabled and budgeted separately. Run `ruflo daemon status --all` and `ruflo daemon budget show`,
   then match the process and transcript evidence by project.
4. Report like a diagnosis, not a data dump: the verdict first (where the usage goes, interactive
   or automation, the single biggest driver), then a small supporting table, then ranked fixes with
   exact commands. The levers: stop a runaway daemon, trim an oversized global or project
   `CLAUDE.md`, gate a heavy always-on MCP server (its tool definitions are a per-session tax),
   cut hook or loop fan-out.

## Caveats

- The cost weight is an Opus-equivalent reference for comparing line items, not the plan's
  billing: never present it as dollars owed.
- A few hundred sessions or Task spawns from parallel subagent work is not a leak. Treat timing
  and naming as leads, and call something automation only when explicit session metadata, a known
  worker schedule or a running process backs it.

## Gates

- The engine reads only the `~/.claude/projects/**/*.jsonl` transcripts and, for the daemon
  cross-reference, the process list from `ps` (`--no-daemons` skips it). It writes nothing
  anywhere and posts nothing. Step 3 additionally runs the two read-only Ruflo reports named
  there.
- The output names projects and sessions: show it to the maintainer and never paste it into an
  issue, a pull request or any shared place without redacting the project names and paths first.
- Never stop a daemon or any other process from this skill: name the PIDs and their projects and
  leave the stop to the maintainer.

## Done

End with the verdict, the window it covers and the figures it rests on, the ranked fixes, and any
section that was empty or skipped (`--no-daemons`, no transcripts in the window).
