<!-- BEGIN ruflo-dual-mode-reference -->
<!-- ruflo-dual-mode-reference: merged into the guidance files (CLAUDE.md AND AGENTS.md)
     ONLY when BOTH hosts (claude + codex) are enabled in kit.json — i.e. dual mode is on.
     Managed by agentic-kit / `ak sync` — stripped automatically when either host is
     disabled. Do not hand-edit between the sentinels. -->

## Ambidextrous dual-host mode (claude + codex)

Both frontier CLIs are enabled, so `ak` runs **ambidextrous**: the same tools, memory,
and quality gates are available whichever agent is in the driver's seat, and each host can
reach the other. Work flows complementarily — Claude and Codex are peers, not primary and
fallback.

### `ak dual run` — Claude+Codex collaboration pipelines

`ak dual run <template> "<task>"` materializes a multi-worker pipeline from your
per-activity routing policy (set via `ak x provider`) and runs it through the
`claude-flow-codex` adapter. Each worker is assigned a host + model by the policy, so a
single run can span both vendors.

```bash
ak dual run feature  "add token-bucket rate limiting"
ak dual run security "src/auth/" --escalate
ak dual run refactor "extract the payment module" --dry-run
ak dual templates                     # list the pipelines
```

- **Templates** — `feature` (architect → coder → tester → reviewer), `security`
  (scanner → analyzer → fixer), `refactor` (architect → coder → tester → reviewer),
  `packaging` (packager → reviewer), `release` (preparer → reviewer). Each step's
  host/model comes from your routing policy, not the template.
- **`--route 'act:host[:model]'`** — per-run routing override (repeatable, not persisted).
- **`--parallel`** — run independent workers concurrently instead of sequentially.
- **`--escalate`** — on failure, retry once **up the escalation ladder** (see below).
- **`--dry-run` / `--json`** — print the materialized config + command, spawn nothing.

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
security-analysis lean Claude, and so on (`ak x provider` shows and edits the table).
`--escalate` walks a **cross-vendor** ladder: a failed step retries on the other vendor's
stronger model, so a Codex miss escalates into Claude (and vice-versa) rather than just
burning retries on the same engine.

**Which host leads.** The two are peers, but `ak x provider pick --primary-host claude|codex`
(default `claude`) picks which one leads: codex-primary **mirrors** the default table so Codex
takes the reasoning/review lead and Claude becomes the alternate/escalation target — the same
ambidextrous experience with the roles flipped. `ak status` marks the primary and **fails**
(not warns) if the primary host is missing.

### qe-court: ≥2-vendor cross-check

Because dual mode routes activities across **two vendors**, the qe-court diversity property
is satisfiable — a quality verdict backed by ≥2 distinct vendors is far harder to fool than
a single-model self-review. Prefer cross-vendor routing for review/security activities so
the court sees genuinely independent opinions.

<!-- END ruflo-dual-mode-reference -->
