# ADR-0015 — Manage Codex's native user-wide status line without claiming rich-renderer parity

- **Status:** Accepted
- **Date:** 2026-07-28
- **Updated:** 2026-08-14
- **Update note:** The boolean `statuslineSupported` consumer this ADR's context
  describes was removed as dead code in the Phase 0 consistency pass (finding
  F-07): it had zero call sites. The registry capability `commandStatusline` is
  the surviving vocabulary for this distinction.
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0001](0001-one-routing-policy-many-projections.md),
  [ADR-0006](0006-primary-host-and-ambidextrous-mirroring.md),
  [ADR-0008](0008-guidance-target-scope-split.md),
  [ADR-0010](0010-provider-mediated-quota-reads.md)

## Context

Agentic-kit gives Claude Code a rich, project-scoped status display by repairing ruflo's
`.claude/helpers/statusline.cjs`, injecting `src/templates/statusline-footer.cjs`, and pointing
Claude Code's command-backed `statusLine` setting at that renderer. The footer can read local
ruflo, SONA, reinforcement-learning, daemon, RuvNet Brain, and agentic-qe state and render several
ANSI-styled lines.

Codex CLI has a different extension boundary. Codex 0.145.0 exposes `/statusline` and the
user-scoped `tui.status_line` array in `~/.codex/config.toml`. The array selects from native item
identifiers such as model, project, Git branch, run state, context remaining, five-hour and weekly
limits, token totals, and task progress. It is a single native line. Codex does not accept a
command-backed item, arbitrary text, custom ANSI output, or multiple renderer-owned lines.
OpenAI tracks command/plugin-backed status-line support as an upstream feature request.

The repository currently reduces this distinction to `statuslineSupported: false` for Codex and
reports that the statusline is Claude-only. That is accurate for the rich command-backed renderer
but no longer accurate for Codex's native declarative status line. It also leaves every Codex user
to configure the same useful baseline by hand.

`~/.codex/config.toml` is shared user state. It contains project trust, MCP registrations, user
preferences, and possibly fields introduced by newer Codex releases. Agentic-kit must not parse and
rewrite the whole document with an incomplete TOML model or silently seize a list the user already
curated.

## Decision

### 1. Model status-line capability, not a boolean

Host adapters distinguish three properties:

- whether the host has a status line;
- whether it accepts a command-backed custom renderer;
- whether its configuration is project- or user-scoped.

Claude remains `command` plus project scope. Codex becomes `builtin` plus user scope. User-facing
status output says that Codex supports a managed native line while rich ruflo/SONA/AQE segments
remain unavailable inside the Codex TUI.

### 2. Add explicit managed Codex presets

Agentic-kit provides an `ak x statusline` command with:

```text
ak x statusline status
ak x statusline codex native
ak x statusline codex extended
ak x statusline codex off
```

`native` is the recommended compact preset:

```text
model-with-reasoning, project-name, git-branch, run-state,
context-remaining, five-hour-limit, weekly-limit, task-progress
```

`extended` adds operational fields that are useful on wide terminals:

```text
permissions, approval-mode, used-tokens, fast-mode, thread-id, codex-version
```

The command is user/machine scoped because Codex reads `~/.codex/config.toml` for all sessions.
Changes apply to newly started Codex sessions; a running TUI need not hot-reload them.

### 3. Ownership is explicit and reversible

Selecting `native` or `extended` records the chosen preset in `kit.json`. Only then may `ak sync`
reconcile `tui.status_line` and `tui.status_line_use_colors`. `off` removes agentic-kit's ownership
and removes only the two managed keys when their values still equal the last managed projection.
It does not delete the `[tui]` table or unrelated user settings.

If Codex or the user changes the managed values, `ak status` reports drift and `ak sync` restores the
selected preset. If no preset is owned, status may describe the detected native configuration but
must not propose a mutating fix.

Uninstall follows the same ownership rule and never removes an unowned status line.

### 4. Patch only the owned TOML keys

The writer performs a narrow, backup-first, atomic textual merge of the two keys inside `[tui]`.
It preserves comments, ordering, newline style, every other table, and every unknown key. It must
recognize multiline arrays because `/statusline` may write one. It validates the resulting file
before replacement using Codex's own configuration loader when a safe non-interactive validation
path is available; otherwise structural tests and a rollback-on-write-failure boundary are
mandatory.

Agentic-kit remains zero-runtime-dependency. Adding a general TOML dependency solely for these two
keys is rejected.

### 5. Keep rich telemetry host-neutral, but outside this change

The existing ruflo/SONA/RL/daemon/Brain/AQE footer remains Claude-backed. A later change may extract
its filesystem probes into:

```text
ak statusline render --host codex --format ansi|json
```

for tmux, Zellij, shell prompts, an adjacent pane, or a future Codex command-backed item. This ADR
does not add a terminal wrapper, patch the Codex binary, claim hooks are persistent UI, or maintain
a private Codex fork.

## Consequences

- Codex users get a consistent, colored, machine-wide native status line through the same
  status/sync drift model as the rest of agentic-kit.
- The UI immediately exposes model, repository, execution state, context headroom, plan headroom,
  and task progress without an external process.
- Ruflo, SONA, RL, daemon, Brain, and agentic-qe telemetry cannot appear in Codex's native line until
  Codex adds an extension point. Documentation states that boundary directly.
- The implementation needs focused tests for absent `[tui]`, existing `[tui]`, multiline arrays,
  CRLF, comments, duplicate/invalid structures, ownership, drift, sync, off, and uninstall.
- Preset identifiers are version-sensitive. The compact preset uses fields verified in Codex
  0.145.0; future incompatible Codex changes surface as drift/validation failures rather than
  destructive fallback rewrites.

## Rejected alternatives

- **Reuse Claude's `statusline.cjs` directly.** Codex has no command-backed status-line item.
- **Configure every available native item.** Codex renders one width-constrained line; later fields
  become invisible on ordinary terminals.
- **Always overwrite `~/.codex/config.toml` during setup or sync.** That would convert a convenience
  into ownership of unrelated user state.
- **Use hooks or `notify` as the renderer.** They produce event notifications, not a persistent
  status surface.
- **Rewrite the entire TOML document.** It risks losing comments and newer Codex fields and violates
  the repository's merge-not-clobber rule.
