<!-- BEGIN ruflo-opencode-reference -->
<!-- ruflo-opencode-reference: merged into ~/.config/opencode/AGENTS.md ONLY when the
     opencode host is enabled (kit.json integrations.hosts.opencode). Managed by ak.
     Source of truth: claude/ruflo-opencode-reference.md in the agentic-kit kit. -->

## Ruflo for opencode

Ruflo is an AI orchestration toolkit (memory, hooks, swarms, neural learning,
security). On this machine it is wired into opencode three ways (all managed by
`ak`, converged on every `ak sync`):

1. **MCP server `claude-flow`** — the full ruflo tool surface (300+ tools):
   memory, swarms, agents, hooks, routing, workflows. Tools appear with the
   `claude-flow_` prefix (e.g. `claude-flow_memory_store`,
   `claude-flow_memory_search`, `claude-flow_swarm_init`,
   `claude-flow_agent_spawn`, `claude-flow_hooks_route`). Pre-approved in
   `~/.config/opencode/opencode.json` (`permission`).
2. **Lifecycle hooks** — `~/.config/opencode/plugins/ruflo-hooks.js` maps
   opencode events to `ruflo hooks` verbs: session restore/end, bash safety
   screening, edit/task outcome recording for the learning substrate.
3. **Skills + agents** — ruflo's skill catalog is on the skills path
   (`skills.paths` in opencode.json), and ruflo's agent set is converted to
   opencode subagents under `~/.config/opencode/agents/` (re-converted on
   every `ak sync` after a ruflo upgrade).

**Restart after wiring.** opencode loads config, plugins, MCP servers, and
agents once at startup. After `ak setup --opencode` (or any `ak sync` that
updates the plugin), quit and restart opencode — a running session will not
see new hooks, tools, or agents.

### Most-used commands

```bash
ruflo memory search -q "..." --smart -n patterns   # semantic recall across sessions
ruflo memory store -k KEY --value V -n patterns     # persist a decision/pattern
ruflo route "task description"                       # pick the right agent (Q-learning)
ruflo analyze boundaries src/                        # find natural refactor seams
ruflo security scan && ruflo security defend -i "…"  # code scan + prompt-injection check
ruflo doctor                                         # health check after install/upgrade
```

### When NOT to use ruflo

Single-file edits, trivial fixes, read-only questions, spawning ONE subagent
(use the native task tool). Reach for ruflo on: multi-file refactors,
cross-session memory, 3+ agent swarms, security/perf audits, semantic search
over prior decisions.

### Quick decision tree

```
Need to ... ?
├─ Search past work / decisions      → ruflo memory search -q "..." --smart  (or claude-flow_memory_search)
├─ Store a decision/pattern          → ruflo memory store -k K --value V -n patterns
├─ Pick the right agent for a task   → ruflo route "task description"
├─ Run a security audit              → ruflo security scan && the security-auditor subagent
├─ Check ruv stack health            → ruflo doctor && ruflo status && ak status
├─ Coordinate 3+ subagents           → native task tool first; claude-flow_swarm_init if topology/consensus needed
├─ Scan untrusted text               → ruflo security defend -i "..."
├─ Re-apply after a ruflo upgrade    → ak sync   (one command heals everything)
└─ Anything rUv CLI                  → ruflo <cmd> --help
```

### Subagent coordination

opencode's native `task` tool spawns subagents (ruflo's converted agent set is
under `~/.config/opencode/agents/`, e.g. `coder`, `reviewer`, `tester`,
`planner`, `researcher`, `security-auditor`, swarm coordinators). Spawn
parallel subagents in ONE message whenever the work is independent. There is
no SendMessage equivalent — subagents return a single final report; design
prompts accordingly (self-contained context, explicit deliverable).

### Daemon (host-independent)

The ruflo daemon runs per-project background workers (default: local-only,
$0; 12h TTL). It serves every host equally — nothing opencode-specific to
set up. Inspect/control: `ruflo daemon budget show|pause|resume`,
`ruflo daemon status`, stop all with `ruflo daemon stop --all`.
AI workers are opt-in (`RUFLO_DAEMON_AI_WORKERS=1`) and spawn the `claude`
CLI — they are the only Claude-specific piece.

### Per-project ruflo init for opencode

In a project that should have its own ruflo runtime (`.swarm/memory.db`,
hooks, swarm state):

```bash
ruflo init --codex   # AGENTS.md + .agents/ layout — the closest fit for opencode
```

opencode reads project `AGENTS.md` natively (and `CLAUDE.md` as a fallback
when no `AGENTS.md` exists), so either mode works. The machine-wide MCP
registration above already covers every project; project init adds the
per-project memory DB and runtime state.

<!-- END ruflo-opencode-reference -->
