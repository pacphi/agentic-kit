<!-- BEGIN ruflo-reference -->
<!-- Compact Ruflo guidance; use ruflo <cmd> --help for commands and flags -->
<!-- Managed by agentic-kit. Refresh with: ak x reference sync -->

## Ruflo (on demand)

Ruflo coordinates memory, routing, hooks, and multi-agent work. Use the CLI for
one-off operations and discover MCP tools only when a typed, repeated integration is
needed. Registration alone does not prove configuration, reachability, health, or
authorization; verify the relevant state before relying on it.

Use Ruflo for cross-session recall, measured code analysis, security/performance work,
or genuinely multi-worker coordination. Prefer native tools for a question, trivial
edit, or one subagent. A coordination call records work; it never substitutes for the
implementation or tests.

```bash
ruflo memory search -q "..." --smart -n patterns
ruflo memory store -k KEY --value VALUE -n patterns
ruflo route "task description"
ruflo analyze boundaries src/
ruflo security scan
ruflo doctor
```

Project memory can be two stores: `ruflo memory ...` reads `.swarm/memory.db`, the MCP
`memory_*` tools use `.swarm/agentdb-memory.db` (native bridge active). A read covers one;
if a CLI search finds nothing, repeat with `--path <project>/.swarm/agentdb-memory.db` or
use MCP `memory_search`.

Run `ruflo <cmd> --help` for commands and flags. Reconcile upgrades with `ak sync`;
inspect effective health with `ak status`.

The daemon defaults to local-only workers with a bounded lifetime. AI workers and
other spend are opt-in and remain subject to user policy. Inspect or stop them with
`ruflo daemon budget show` and `ruflo daemon stop --all`.
<!-- END ruflo-reference -->
