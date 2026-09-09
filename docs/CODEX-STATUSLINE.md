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

## Native context capacities

`context-remaining` uses Codex's active session allocation. The API model's
advertised context capacity is a separate measurement. On Codex 0.153.4,
Astra and Sol default to 272,000 tokens with a 95% effective allocation
(258,400 tokens). Their native catalog maximum is 872,000, giving 828,400
effective tokens when explicitly requested. A fresh session with a 1,050,000
request still reports 828,400. GPT-5.5 remains at 258,400 under that same
request: Codex caps the allocation for each selected model.

Agentic-kit can maintain the native maximum preference:

```bash
ak x codex-context max --dry-run
ak x codex-context max
ak x codex-context status --json
ak sync --no-upgrade
# Restore the original setting while the owned value is unchanged:
ak x codex-context off
```

This is an explicit opt-in independent of the status-line preset. Setup and
sync reconcile the persisted preference; uninstall restores the original scalar
only if the current value matches a successful or pending owned projection.
User-modified values survive removal. Recovery receipts retain both projections
across interrupted writes, and every changed configuration gets a backup.

The request comes from a fresh native model cache, with a verified per-model
clamp profile for Codex 0.153.4. Unknown versions, stale or malformed caches,
custom providers/catalogs, ambiguous TOML, and mismatched `CODEX_HOME` ownership
prevent writes. Refresh stale metadata with `codex debug models`; a new Codex
version needs its own conformance evidence. The native cache is never patched.

The new command and model inventory honor absolute `CODEX_HOME`. The projection
owns only the top-level `model_context_window` scalar. Profile, project, managed,
or command-line overrides may supersede it. Status labels catalog/config
estimates separately from runtime observations; restart existing Codex clients
and verify the window in a fresh session. Auto-compaction settings remain owned
by Codex or the user and are reported when explicitly configured.

The opt-in `tests/live/codex-context-contract.test.mjs` checks fresh Astra/Sol
and GPT-5.5 sessions under `AK_CODEX_CONTEXT_CONFORMANCE=1`. It makes three short
model requests and inspects their recorded effective windows; it does not
claim that a near-limit input was processed successfully.

See the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
for native settings and the [capacity evidence](evidence/codex-context-0.153.4.md)
for the initial conformance observations.

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
| Native configuration scope | User or project; kit footer is project-scoped | User/machine |
| Native single-line fields | Host-dependent | Yes |
| Command-backed renderer | Yes | No |
| Multiple rich telemetry lines | Yes | No |
| Managed by `ak sync` | Yes | After explicit preset selection |

Claude supports user and project `statusLine` settings and sends session context data to
the configured command ([official status-line reference](https://code.claude.com/docs/en/statusline)).
That live input is a separate source from the historical transcript-based Usage dashboard.

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
