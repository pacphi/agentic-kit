# ADR-0064 — Project-scoped management

- **Status:** Accepted (design approved 2026-10-01; not yet implemented — implementation starts in 4.0.0-beta.1)
- **Date:** 2026-10-03
- **Deciders:** agentic-kit maintainers
- **Related:** [design plan](../plans/2026-10-01-project-scope-only-design.md),
  [supersession ledger](../plans/2026-10-01-v4-supersession-ledger.md),
  [ADR-0020](0020-ga-stable-surfaces.md) (the GA surface freeze this must precede),
  [ADR-0063](0063-evidence-store-and-refresh-vocabulary.md)
- **Supersedes:**
  [ADR-0035](0035-managed-deja-vu-companion.md) in full (the companion is removed; the record is kept and marked Retired, not archived);
  [ADR-0008](0008-guidance-target-scope-split.md) user targets and machine retirement;
  [ADR-0015](0015-managed-codex-native-statusline.md) user-wide ownership;
  [ADR-0017](0017-opencode-host.md) user config, plugins, agents, skills, approvals and its guidance target;
  [ADR-0058](0058-managed-ruflo-components.md) §3 (user env), §4 (global typesafe install), §6 (funnel disable).
- **Amends:**
  [ADR-0025](0025-machine-footprint-metrics.md) and
  [ADR-0027](0027-shared-project-census.md) (footprint, census scopes, place kinds),
  [ADR-0048](0048-inventory-led-maintenance-resource-management.md) (Maintenance write gate),
  [ADR-0014](0014-dashboard-auth-and-remediation.md) (dashboard Refresh and Forget writes).
- **Withdrawn from v4, carried to v5 (not superseded):** ADR-0029 and ADR-0031, the external host-adapter contract.

## Context

Today `ak` writes user-level files (`~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.codex/`,
`~/.config/opencode/`), runs `npm install -g`, and reconciles whole machines. A user who never opted
a folder in still sees agentic-kit in every Claude Code, Codex and OpenCode session. The design plan
inventories each surface (`## What this replaces`).

deja-vu is the clearest case. It indexes every agent history on the machine into a user-level index,
so it cannot fit a kit whose reach stops at the project.

## Decision

**The blast radius of every `ak` command is the opted-in project.** Judged by effect, not only by
file location, exactly four kinds of write are allowed:

1. Inside the project root, in a git-ignored layer by default.
2. A kit-owned cache that does nothing on its own, under `$XDG_CACHE_HOME/agentic-kit/`
   (`%LOCALAPPDATA%\agentic-kit\cache` on Windows).
3. A host's own per-project record, written through the host's own command. The only one is
   Claude's local-scope MCP registration (`claude mcp add|remove -s local`).
4. The Codex exception register: a closed, coded list of Codex user-level settings with no
   project-level equivalent, each shown in the plan, receipted and reference-counted.

Reading is unrestricted. The dashboard observes all agent work on every readable host, and writes
nothing outside the cache except an explicit Refresh (project state and cache) and Forget (the
project index only).

Supporting decisions, from the design (numbers are the design's):

- **1, 7.** The cache under `~/.cache/agentic-kit` is approved. There is no migration code: the
  last release of the current line (`4.0.0-alpha.61`) makes `ak uninstall --purge` remove everything.
- **2, 3.** Claude MCP uses local scope in personal mode; team mode (`.mcp.json`) is opt-in.
- **4.** deja-vu is removed entirely.
- **5.** Superpowers guidance goes only into projects with evidence of prior use.
- **6.** Codex settings with no project home are managed under the register.
- **8.** Four lifecycle verbs: `init`, `status`, `sync`, `uninstall`.
- **9.** The dashboard covers all work, every host and place; management stays opt-in per project.
- **10.** The external host-adapter contract and Hermes leave v4 and are tagged
  `archive/v4-host-adapters`.
- **11.** `ak x harvest` is removed.

## Consequences

- Opted-out folders behave as if agentic-kit were not installed.
- Verbatim transcript recall (exact errors, commands and tool output from past sessions) is dropped
  with deja-vu. Curated memory in Ruflo and AgentDB records decisions and patterns, not transcripts
  ([ADR-0035](0035-managed-deja-vu-companion.md) Context), so it does not replace that capability.
- Several accepted ADRs describe behaviour that stops being true as each phase lands. The notes on
  the nine linked ADRs say which parts, and #380 and #381 add notes to the rest.
- Because nothing is implemented yet, the linked ADRs describe current behaviour until the matching
  phase ships. Each phase's pull request moves this ADR's status toward Implemented.
- Phasing (P0–P7) and the release each phase ships in are in the design's `## Phasing`.
