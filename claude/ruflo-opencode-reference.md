<!-- BEGIN ruflo-opencode-reference -->
<!-- Included in ~/.config/opencode/AGENTS.md only when OpenCode is enabled. -->
<!-- Managed by agentic-kit; do not edit within sentinels. -->

## Ruflo for OpenCode

Agentic-kit projects Ruflo/AQE through compact lazy gateways. Search first, then call the
exact selected operation with `ak_ruflo_search` / `ak_ruflo_call` or
`ak_aqe_search` / `ak_aqe_call`; do not guess tool names or preload the direct catalogues.

Skills and specialists are also lazy. Use `ak_skill_search`, then the stock `skill` tool
with the exact result. Use `ak_agent_search`, then `task` with
`subagent_type="ak-specialist"` and `PROFILE: <exact name>` at the start of the prompt.
If a selected profile's dependency is unavailable, report that evidence rather than
inventing a call or result.

The managed OpenCode plugin maps lifecycle, command-safety, edit, and task events into
Ruflo hooks. Its presence does not expand authority. Use independently bounded parallel
subagents only when work is separable; OpenCode subagents return reports and do not have a
SendMessage channel.

Restart OpenCode after setup/sync changes because it loads configuration, plugins, MCP
servers, agents, and skills at startup. Inspect wiring with `ak status`; use `ruflo
<cmd> --help` for CLI details. Per-project Ruflo state may be initialized with `ruflo init
--codex`, whose AGENTS/.agents layout is OpenCode-compatible.

The daemon is host-independent and local-only by default. AI workers/spend are opt-in;
inspect them with `ruflo daemon budget show` and stop with `ruflo daemon stop --all`.
<!-- END ruflo-opencode-reference -->
