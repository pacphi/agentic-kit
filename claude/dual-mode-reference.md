<!-- BEGIN ruflo-dual-mode-reference -->
<!-- ruflo-dual-mode-reference: merged into the two MACHINE-scoped guidance files —
     ~/.claude/CLAUDE.md AND ~/.codex/AGENTS.md — ONLY when BOTH hosts (claude + codex)
     are enabled in kit.json (i.e. dual mode is on). This is machine state, so it never
     lands in a repo's checked-in AGENTS.md (ADR-0008). Managed by agentic-kit / `ak
     sync` — stripped automatically when either host is disabled. The ~/.codex/AGENTS.md
     copy only appears on machines where ~/.codex exists. Do not hand-edit between the
     sentinels. -->

## Ambidextrous dual-host mode (claude + codex)

Both frontier CLIs are enabled, so `ak` runs **ambidextrous**: the same tools, memory,
and quality gates are available whichever agent is in the driver's seat, and each host can
reach the other. Work flows complementarily — Claude and Codex are peers, not primary and
fallback.

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

### The Claude ↔ Codex bridge (bidirectional MCP)

The two hosts see each other as MCP servers, so either can delegate to the other mid-task:

- **Claude → Codex** — Codex is exposed as an MCP server (`codex mcp-server`); Claude
  reaches it through the **`mcp__codex__codex`** tool to hand a subtask to Codex.
- **Codex → ruflo** — Codex registers ruflo's MCP via `[mcp_servers.ruflo]` in
  `~/.codex/config.toml`, so Codex-driven sessions get the same memory, routing, and swarm
  tools Claude has.

Register (or repair) both directions with `ak sync`; inspect with `ak status`.

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
vendor proof.

<!-- END ruflo-dual-mode-reference -->
