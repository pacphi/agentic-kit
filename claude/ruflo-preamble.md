<!-- BEGIN ruflo-preamble -->
<!-- ruflo-preamble-version: 1.1.0 | last-updated: 2026-07-14 -->
<!-- Refresh this block with: ruflo-reference-refresh --sync-blocks -->

# Machine-wide Claude Code Reference

This file is loaded into every Claude Code session on this machine. It documents
generic operating rules + the `ruflo` CLI surface. Project-specific `CLAUDE.md`
files take precedence for anything domain-specific.

## Operating rules

- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary — prefer editing existing files
- NEVER create documentation files unless explicitly requested
- NEVER save working files or tests to root — use `/src`, `/tests`, `/docs`, `/config`, `/scripts`
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or `.env` files
- NEVER add a `Co-Authored-By` trailer to user commits unless the project's `.claude/settings.json` has `attribution.commit` set (ruflo #2078). The Bash tool's default commit-message template may suggest one — ignore it. `Co-Authored-By` is authorship attribution; the tool is the facilitator, not a co-author.
- Keep files under 500 lines where reasonable
- Validate input at system boundaries

## Codebase Stack Detection

Before running any performance or security analysis, first detect the actual tech stack (check for package.json, Cargo.toml, pom.xml, requirements.txt). Map requested analysis categories (e.g. N+1 queries, React re-renders) to the actual stack, and explicitly note which requested categories do not apply.

## Security Scans = Full Codebase, Not Git Diff

When asked for a 'full-codebase security vulnerability scan' with a JSON report, analyze ALL source files, NOT just uncommitted/branch-diff changes. Do not use a git-diff-based review skill for full-codebase requests.

## Output JSON Format

When a structured JSON report is requested, always emit the complete JSON object as the final deliverable, even for long reports. Confirm the schema before starting and stream the full result without truncation.

## Agent coordination (SendMessage-first)

When spawning a team of named agents via the native `Agent` tool, agents
coordinate via `SendMessage` to each other, not via polling or shared state.

```
Lead (you) ←→ architect ←→ developer ←→ tester ←→ reviewer
              (named agents message each other directly)
```

### Spawning a coordinated team

```javascript
// ALL agents in ONE message, each knows WHO to message next
Agent({ prompt: "Research the codebase. SendMessage findings to 'architect'.",
  subagent_type: "researcher", name: "researcher", run_in_background: true })
Agent({ prompt: "Wait for 'researcher'. Design solution. SendMessage to 'coder'.",
  subagent_type: "system-architect", name: "architect", run_in_background: true })
Agent({ prompt: "Wait for 'architect'. Implement it. SendMessage to 'tester'.",
  subagent_type: "coder", name: "coder", run_in_background: true })
Agent({ prompt: "Wait for 'coder'. Write tests. SendMessage results to 'reviewer'.",
  subagent_type: "tester", name: "tester", run_in_background: true })
Agent({ prompt: "Wait for 'tester'. Review code quality and security.",
  subagent_type: "reviewer", name: "reviewer", run_in_background: true })

// Kick off the pipeline
SendMessage({ to: "researcher", summary: "Start", message: "[task context]" })
```

### Coordination patterns

| Pattern | Flow | Use when |
|---------|------|----------|
| **Pipeline** | A → B → C → D | Sequential dependencies (feature dev) |
| **Fan-out** | Lead → A, B, C → Lead | Independent parallel work (research) |
| **Supervisor** | Lead ↔ workers | Ongoing coordination (complex refactor) |

### Coordination rules

- ALWAYS name agents — `name: "role"` makes them addressable
- ALWAYS include comms instructions in prompts — who to message, what to send
- Spawn ALL agents in ONE message with `run_in_background: true`
- After spawning: STOP, tell the user what's running, wait for results
- NEVER poll status — agents message back or complete automatically

## Task → agent routing

Default agent picks per task type (start here, adjust per project):

| Task | Agents | Topology |
|------|--------|----------|
| Bug fix | researcher, coder, tester | hierarchical |
| Feature | architect, coder, tester, reviewer | hierarchical |
| Refactor | architect, coder, reviewer | hierarchical |
| Performance | perf-engineer, coder | hierarchical |
| Security | security-architect, auditor | hierarchical |

**Recommended ruflo swarm defaults** (for 3+ file work):

- **Topology**: `hierarchical-mesh` (anti-drift — agents elect a queen but coordinate peer-to-peer)
- **Max agents**: 15 (V3 default)
- **Memory backend**: `hybrid` (sql.js + HNSW vector index)

Pass `--v3-mode` to `ruflo swarm init` to get all of these at once.

### When to swarm

- **YES**: 3+ files, new features, cross-module refactoring, API changes, security, performance
- **NO**: single file edits, 1-2 line fixes, docs updates, config changes, questions

### 3-tier model routing

Match work to model **before** picking up the task:

| Tier | Handler | When to apply |
|------|---------|---------------|
| 1 | Agent Booster (WASM) | Mechanical transforms (rename var, add types, format) → use `Edit` directly, no LLM call |
| 2 | Haiku | Simple, well-bounded work (small fix, single-file edit, mechanical refactor) |
| 3 | Sonnet / Opus | Architecture, security, multi-file reasoning, anything ambiguous |

You can ask ruflo what it would route a task to: `ruflo hooks model-route -t "task desc"`.

## Available agent types (Claude Code native)

**Core**: `coder`, `reviewer`, `tester`, `planner`, `researcher`
**Architecture**: `system-architect`, `backend-dev`, `mobile-dev`
**Security**: `security-architect`, `security-auditor`
**Performance**: `performance-engineer`, `perf-analyzer`
**Coordination**: `hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`
**GitHub**: `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`

Any string also works as a custom agent type — pick a name that signals the role.

For the authoritative live list as ruflo evolves, run `ruflo route list-agents`.

## Build & test (project-specific)

Most projects have their own commands; check `package.json`, `Cargo.toml`,
`pom.xml`, `pyproject.toml`, etc. before running. Defaults to assume nothing:

- ALWAYS run tests after non-trivial code changes
- ALWAYS verify build succeeds before committing
- Don't skip hooks (`--no-verify`) without explicit instruction
<!-- END ruflo-preamble -->
