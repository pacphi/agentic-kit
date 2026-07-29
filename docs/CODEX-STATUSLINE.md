# Managed Codex status line

Codex has a native, user-wide status line. Agentic-kit can manage a useful
preset for every newly started Codex session while preserving the rest of
`~/.codex/config.toml`.

This is intentionally different from the rich Claude Code footer. Codex's
native line is single-line and accepts only Codex's built-in fields. Ruflo,
SONA, route-RL, daemon, RuvNet Brain, and Agentic QE segments cannot appear
inside it until Codex provides a command or plugin-backed extension point.

## Choose a preset

```bash
# Inspect agentic-kit's ownership and the current Codex configuration.
ak x statusline status

# Recommended: compact enough for an ordinary terminal.
ak x statusline codex native

# Add operational fields for a wide terminal.
ak x statusline codex extended

# Stop managing the Codex status line.
ak x statusline codex off
```

`native` selects:

```text
model-with-reasoning, project-name, git-branch, run-state,
context-remaining, five-hour-limit, weekly-limit, task-progress
```

`extended` adds:

```text
permissions, approval-mode, used-tokens, fast-mode, thread-id, codex-version
```

The setting is machine/user scoped rather than repository scoped. Start a new
Codex session after changing it; an already-running TUI may not reload the
configuration.

## Ownership and sync

Selecting `native` or `extended` records explicit ownership in agentic-kit's
machine configuration. From then on, `ak status` reports drift and `ak sync`
reconciles the selected preset.

Agentic-kit narrowly updates only these keys under `[tui]`:

```toml
[tui]
status_line_use_colors = true
status_line = [
  "model-with-reasoning",
  "project-name",
  "git-branch",
  "run-state",
  "context-remaining",
  "five-hour-limit",
  "weekly-limit",
  "task-progress",
]
```

Other tables, keys, comments, ordering, and newline style in
`~/.codex/config.toml` are preserved. A backup is made before a managed write.
If no preset is owned, `ak status` may describe a native configuration but
`ak sync` leaves it alone.

The narrow writer fails closed on TOML-equivalent quoted table/key syntax or
dotted `tui.status_line` keys instead of risking a duplicate semantic key.
Normalize those forms to the conventional `[tui]` table before opting in.

`off` relinquishes ownership. Each managed key is removed only when its value
still matches the last managed projection; an edited key is preserved as user
state. Uninstall follows the same rule.

## What each host can display

| Capability | Claude Code | Codex |
|---|---:|---:|
| Configuration scope | Project | User/machine |
| Native single-line fields | Host-dependent | Yes |
| Command-backed renderer | Yes | No |
| Multiple rich telemetry lines | Yes | No |
| Managed by `ak sync` | Yes | After explicit preset selection |

For Claude Code, agentic-kit continues to inject its rich renderer into the
project's ruflo status-line helper. The Codex preset complements that renderer;
it does not attempt to claim visual or telemetry parity.

## Troubleshooting

- **The line did not change:** exit and start a new Codex session.
- **The right side is missing:** use `native`, or widen the terminal. Codex
  renders one width-constrained line.
- **`ak status` reports drift:** run `ak sync` to restore the owned preset, or
  run `ak x statusline codex off` before maintaining the keys yourself.
- **You need the rich subsystem display:** use Claude Code's project footer for
  now. Hooks and notifications are event messages, not a persistent Codex UI.

The design and safety constraints are recorded in
[ADR-0015](adr/0015-managed-codex-native-statusline.md).
