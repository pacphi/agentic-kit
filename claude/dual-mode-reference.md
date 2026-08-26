<!-- BEGIN ruflo-dual-mode-reference -->
<!-- ruflo-dual-mode-reference: merged into the two MACHINE-scoped guidance files —
     ~/.claude/CLAUDE.md AND ~/.codex/AGENTS.md — ONLY when BOTH hosts (claude + codex)
     are enabled in kit.json (i.e. ambidextrous dual-host mode is on). This is machine state, so it never
     lands in a repo's checked-in AGENTS.md (ADR-0008). Managed by agentic-kit / `ak
     sync` — stripped automatically when either host is disabled. The ~/.codex/AGENTS.md
     copy only appears on machines where ~/.codex exists. Do not hand-edit between the
     sentinels. -->

## Ambidextrous dual-host mode (claude + codex)

Both frontier CLIs are enabled, so `ak` runs **ambidextrous**: the same Ruflo/AQE tools,
memory, and quality gates are available whichever agent is in the driver's seat. Work flows
complementarily — Claude and Codex are peers, not primary and fallback.

### `ak run` — canonical activity pipelines

`ak run <template> "<task>"` materializes a multi-worker pipeline from your per-activity routing
policy (set via `ak host`) and runs it through supervised host adapters. Each worker is assigned a
host + model by the policy, so a single run can span Claude, Codex, and an explicitly routed
OpenCode worker.

```bash
ak run feature  "add token-bucket rate limiting"
ak run security "src/auth/" --route 'security-scan:opencode:provider/model'
ak run refactor "extract the payment module" --dry-run
```

- **Templates** — `feature` (architect → coder → tester → reviewer), `security`
  (scanner → analyzer → fixer), `refactor` (architect → coder → tester → reviewer),
  `packaging` (packager → reviewer), `release` (preparer → reviewer). Each step's
  host/model comes from your routing policy, not the template.
- **`--route 'act:host[:model]'`** — per-run routing override (repeatable, not persisted).
- **`--max-concurrent <n>` / `--timeout <ms>`** — bound parallel work and each worker.
- **`--dry-run`** — print the materialized plan and spawn nothing.
- **`--json`** — emit machine-readable output while executing; combine it with
  `--dry-run` for a machine-readable preview.

### Cross-host integration

Managed cross-host work uses one bounded path:

- **Claude-led or Codex-led execution** — use `ak run`; every worker has one absolute
  deadline and process-tree cleanup.
- **Codex → Ruflo/AQE tools** — Codex registers Ruflo's MCP via `[mcp_servers.ruflo]` in
  `~/.codex/config.toml`, so Codex-driven sessions get the same memory, routing, and swarm
  tools Claude has. Agentic-QE owns its separate Codex MCP/platform integration.
- **Optional Claude → Codex interactive delegation** — OpenAI's Claude Code plugin uses
  Codex App Server and remains user-owned. Agentic-kit never silently installs it.

OpenAI deprecated `codex mcp-server` on 2026-08-24. `ak sync` removes only the legacy
project registration that agentic-kit owns; user-owned entries are preserved and warned.
Inspect the effective topology with `ak status`.

### Per-activity routing + escalation ladders

Routing is **per activity**, not per session — coder/tester lean Codex, reviewer and
security-analysis lean Claude, and so on (`ak host` shows and edits the table).
`--escalate` walks the configured **cross-host** ladder. A failed step can retry on another
host/model, but host diversity is not vendor proof; provider evidence determines whether a
particular ladder is also cross-vendor.

**Which host leads.** The two are peers, but `ak host pick --primary-host claude|codex`
(default `claude`) picks which one leads: codex-primary **mirrors** the default table so Codex
takes the reasoning/review lead and Claude becomes the alternate/escalation target — the same
ambidextrous experience with the roles flipped. `ak status` marks the primary and **fails**
(not warns) if the primary host is missing.

### qe-court: evidence-backed vendor cross-check

Two enabled hosts do not by themselves prove two inference vendors. qe-court diversity must be
grounded in the providers that actually serve the selected roles. Prefer independently evidenced
providers for review/security activities and treat configured host/model routes as intent, not
vendor proof. `primaryHost` mirrors `ak run` activity routes; it does not reverse QE-Court seats.
Until Agentic-QE ships a host-neutral court runner and complete Codex projection, the reciprocal
live check is a **participant-transport regression**, not a court verdict.

<!-- END ruflo-dual-mode-reference -->
