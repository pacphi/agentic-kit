<!-- BEGIN ruflo-reference -->
<!-- ruflo-version: 3.28.x | last-updated: 2026-07-14 -->
<!-- Compact pointer block. Full reference: ~/.config/ruflo/ruflo-reference-full.md -->
<!-- Refresh this block with: ruflo-reference-refresh -->

## Ruflo CLI Reference (compact)

Ruflo is an AI orchestration toolkit (memory, hooks, swarms, neural learning,
security). Two surfaces, same functionality:

- **CLI** — `ruflo <subcommand>` via Bash. Zero context cost; right for one-off calls.
- **MCP** — `mcp__claude-flow__*` tools (registered once at user scope; schemas are
  deferred and load on demand, so the old ~84k-token session tax no longer applies).
  Prefer MCP for tight, repeated, schema-typed integration; excluded tool families are
  blocked via permissions.deny (`ruflo-setup-machine` to revisit, `ruflo-remove-mcp`
  to opt out).

**Full reference** (every subcommand, flags, the Node/WASM gotchas, statusline internals):
read `~/.config/ruflo/ruflo-reference-full.md` on demand, or run `ruflo <cmd> --help`.
This compact block is auto-loaded each session; the full doc is read only when needed
(keeping the always-on per-session context small).

### When NOT to use ruflo

Single-file edits, trivial fixes, read-only questions, spawning ONE subagent (use the
native Agent tool). Reach for ruflo on: multi-file refactors, cross-session memory,
3+ agent swarms, security/perf audits, semantic search over prior decisions.

### Most-used commands

```bash
ruflo memory search -q "..." --smart -n patterns   # semantic recall across sessions
ruflo memory store -k KEY --value V -n patterns     # persist a decision/pattern
ruflo route "task description"                       # pick the right agent (Q-learning)
ruflo analyze boundaries src/                        # find natural refactor seams
ruflo security scan && ruflo security defend -i "…"  # code scan + prompt-injection check
ruflo doctor                                         # health check after install/upgrade
```

### Quick decision tree

```
Need to ... ?
├─ Search past work / decisions      → ruflo memory search -q "..." --smart
├─ Store a decision/pattern          → ruflo memory store -k K --value V -n patterns
├─ Pick the right agent for a task   → ruflo route "task description"
├─ Run a security audit              → ruflo security scan && ruflo hooks worker dispatch -t audit
├─ Check codebase health             → ruflo doctor && ruflo status
├─ Find natural refactor boundaries  → ruflo analyze boundaries src/
├─ Coordinate 3+ agents              → native Agent tool first; ruflo swarm if topology/consensus needed
├─ Scan untrusted text               → ruflo security defend -i "..."
├─ Activate + verify self-learning   → ruflo-enable-learning && ruflo-learning-verify
├─ Re-apply after a ruflo/aqe upgrade → ruflo-resync   (one command heals everything)
└─ Anything else                     → ruflo-reference-full.md  or  ruflo <cmd> --help
```

### Daemon (default-on, budget-governed)

`ruflo-setup-project` starts a background daemon with **local-only ($0) workers**; it
self-terminates after a 12h TTL and is auto-reaped on shell start as a backstop.
Token-spending **AI workers are opt-in** (`RUFLO_DAEMON_AI_WORKERS=1`) and governed by
ruflo's machine-wide launch budget — inspect/control with `ruflo daemon budget
show|pause|resume`; stop everything with `ruflo daemon stop --all`. One ⚙ daemon per
active project in the statusline is normal; yellow at ≥4 means inspect with
`ruflo-daemon-gc [--kill]`.

<!-- END ruflo-reference -->
