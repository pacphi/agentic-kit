<!-- BEGIN ruflo-dual-mode-reference -->
<!-- Machine-scoped: ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md only when Claude + Codex
     are enabled in kit.json. Never project this machine fact into repository AGENTS.md.
     Managed by agentic-kit / ak sync; do not edit within sentinels. -->

## Claude + Codex dual-host mode

Claude and Codex are enabled peers. `ak run <template> "<task>"` materializes the
configured per-activity route and runs bounded workers through supervised adapters.
Use `--dry-run` to inspect a plan, `--route 'activity:host[:model]'` for a run-local
override, and `--max-concurrent` / `--timeout` to bound execution.

Each worker receives one host/model route and one absolute deadline. A failed attempt may
walk an explicitly configured escalation ladder, but it must be rematerialized for that
host's capability and context limits before launch. Coordination, routing, or MCP
registration does not expand authority or prove runtime health.

Codex accesses agentic-kit-owned Ruflo integration through its configured MCP entry; AQE
owns its separate Codex projection. OpenAI's optional Claude-to-Codex interactive plugin
is user-owned and is never installed silently. The retired `codex mcp-server` projection
must not be recreated; `ak sync` removes only legacy registration agentic-kit can prove it
owns.

`ak host pick --primary-host claude|codex` selects the routing lead, not a universal
primary/fallback relationship. Inspect effective routes and health with `ak status`.
Host diversity is not vendor diversity: review and qe-court claims require evidence for
the providers actually serving the selected roles.
<!-- END ruflo-dual-mode-reference -->
