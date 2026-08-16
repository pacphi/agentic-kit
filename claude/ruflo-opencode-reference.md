<!-- BEGIN ruflo-opencode-reference -->
<!-- ruflo-opencode-reference: merged into ~/.config/opencode/AGENTS.md ONLY when the
     opencode host is enabled (kit.json integrations.hosts.opencode). Managed by ak.
     Source of truth: claude/ruflo-opencode-reference.md in the agentic-kit kit. -->

## Ruflo for opencode

Ruflo is an AI orchestration toolkit (memory, hooks, swarms, neural learning,
security). On this machine it is wired into opencode through native host surfaces (all managed by
`ak`, converged on every `ak sync`):

1. **Connected MCP servers, compact provider projection** — `claude-flow` and
   `agentic-qe` stay connected in OpenCode, but their eager direct tool catalogues are
   blacklisted from model requests. Discover and invoke the full live surfaces through
   `ak_ruflo_search` / `ak_ruflo_call` and `ak_aqe_search` / `ak_aqe_call`.
   RuvNet Brain stays direct: search it before making a factual rUv capability claim and
   cite the returned source. Never substitute memory or model priors for Brain evidence.
2. **Lifecycle hooks** — `~/.config/opencode/plugins/ruflo-hooks.js` maps
   opencode events to `ruflo hooks` verbs: session restore/end, bash safety
   screening, edit/task outcome recording for the learning substrate.
3. **Lazy skills + specialists** — use `ak_skill_search`, then stock `skill` with the
   exact selected name. Use `ak_agent_search`, then stock `task` with
   `subagent_type="ak-specialist"` and a prompt beginning `PROFILE: <exact name>`.
   The specialist loads its receipt-owned profile with `ak_agent_load`. This preserves the
   complete catalogue without paying its descriptions on every initial provider request.
   If a profile names an external MCP dependency that is unavailable, report it; do not
   invent the tool call or its result.

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

```text
Need to ... ?
├─ Search past work / decisions      → ak_ruflo_search, then ak_ruflo_call(memory_search)
├─ Store a decision/pattern          → ruflo memory store -k K --value V -n patterns
├─ Pick the right specialist         → ak_agent_search, then task(ak-specialist)
├─ Run a security audit              → ak_agent_search for the security specialist
├─ Check ruv stack health            → ruflo doctor && ruflo status && ak status
├─ Coordinate 3+ agents              → ak_ruflo_search, then invoke the selected swarm operation
├─ Scan untrusted text               → ruflo security defend -i "..."
├─ Re-apply after a ruflo upgrade    → ak sync   (one command heals everything)
└─ Anything rUv CLI                  → ruflo <cmd> --help
```

### Subagent coordination

opencode's native `task` tool spawns the receipt-owned `ak-specialist` dispatcher.
Select the exact profile with `ak_agent_search`; do not guess profile names. Spawn parallel
specialists in one message only when work is genuinely independent. There is no SendMessage
equivalent — subagents return a final report, so give each a self-contained task and deliverable.

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
