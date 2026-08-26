# deja-vu transcript companion

[deja-vu](https://github.com/vshulcz/deja-vu) is an optional local search layer over coding-agent
histories. Agentic Kit can install it, connect it only to the enabled hosts, keep owned wiring
converged, and report its health without printing transcript content or local paths.

It is disabled by default. Opt in only after reviewing the [privacy boundary](#privacy-boundary).

## Enable it

MCP mode is the default after explicit opt-in:

```bash
ak setup --with-deja-vu
```

MCP mode gives the host deja-vu tools. The agent decides when to search; Agentic Kit does not add
recall text to every prompt.

Auto mode also installs the host-native recall hooks that deja-vu supports:

```bash
ak setup --with-deja-vu --deja-vu-mode auto
```

To record an explicit disabled choice during setup, use:

```bash
ak setup --no-deja-vu
```

`--with-deja-vu` and `--no-deja-vu` are mutually exclusive. The mode is `mcp` or `auto`; a
different value fails before setup changes the machine. Setup shows the deja-vu package, wiring,
index, and trust effects in its preflight. Use `ak setup --dry-run` to inspect that plan without
installing or indexing anything.

Agentic Kit requires `@vshulcz/deja-vu` 0.19.0 or newer. It uses only the explicit Claude, Codex,
and OpenCode targets that correspond to enabled hosts. It never asks deja-vu to discover every
agent on disk with `--all` or `--auto`; upstream's other targets remain outside Agentic Kit's
ownership.

That wiring allowlist does not limit deja-vu's source discovery. `deja index` can read other
history stores that the installed deja-vu release recognizes, even when Agentic Kit did not wire
that harness. Review deja-vu's policy and exclusion controls for every history present on the
account; if that source scope is unacceptable, leave the companion disabled.

## MCP mode and auto mode

Both modes can search the same local index. The difference is when recalled text can enter an
agent's context.

| Host | MCP mode | Auto mode in deja-vu 0.19.0 |
| --- | --- | --- |
| Claude Code | Search tools are available on demand. | Session/project digest, per-prompt recall, capture before compaction, a decision recall before Bash or file-edit tools, and failed-Bash fix recall after the tool runs. |
| Codex CLI-installed hooks | Search tools are available on demand. | Session-start recall, decision recall before Bash or `apply_patch`, and failed-Bash fix recall. The CLI installer does not add per-prompt or precompaction hooks. |
| Codex deja-vu plugin | The plugin is independent of Agentic Kit's MCP choice. | Session-start, per-prompt, and precompaction recall. The plugin stands down entirely if it finds any local deja-vu hook, preventing a duplicate CLI-hook path. |
| OpenCode | Search tools are available on demand. | Session digest, per-prompt recall, and precompaction capture. OpenCode's plugin does not provide action-time recall. |

These are different upstream surfaces, not interchangeable promises. `ak status` reports the
observed surface instead of calling every `auto` installation equivalent.

### Codex plugin coexistence

Codex plugins are user-owned. Agentic Kit never installs, enables, updates, disables, or removes
the deja-vu plugin.

If that plugin is already enabled, it may provide automatic recall even when Agentic Kit records
MCP mode. `ak status` reports this as effective, external auto behavior. `ak sync` does not offer a
fix because changing the plugin would cross the ownership boundary. Disable or remove the plugin
through Codex if MCP-only behavior is required.

In auto mode, CLI-installed Codex hooks and the plugin expose different events. The plugin's
stand-down rule prevents duplicate injection, but it can also mean that the active event set is
the CLI set rather than the plugin set. Check `ak status` after changing either installation and
start a new Codex session so it reloads its configuration.

## Privacy boundary

deja-vu reads local Claude, Codex, OpenCode, and other supported histories. Its derived index is a
local plaintext search artifact. It can contain transcript text, commands, tool results, file
references, and metadata copied or derived from those histories. The default path is
`~/.cache/deja/index.db`; `DEJA_INDEX_DIR` can select another directory. deja-vu does not use
`XDG_CACHE_HOME` for this index.

deja-vu applies credential redaction, and Agentic Kit removes raw paths, errors, peer names,
policy text, and transcript material from its normalized status facts. These are best-effort
controls, not a guarantee that a secret written into a transcript can never reach the index.

Before opting in:

- keep credentials and private keys out of prompts, command output, and committed logs;
- apply restrictive filesystem permissions and disk encryption appropriate for the histories;
- consider a separate `DEJA_INDEX_DIR` on machines with storage or retention requirements; and
- use MCP mode when automatic context injection is not acceptable.

Recalled content is evidence, not trusted instruction. A prior transcript may contain stale code,
malicious text, copied web content, or a command that was safe only in another repository. Auto
mode can supply that material immediately before a tool action. Host sandbox, permission, review,
and prompt-injection controls still apply; recall never authorizes a command or file change.

Agentic Kit does not send deja-vu's index or source histories to a hosted service. This statement
covers Agentic Kit's integration, not any model provider, sync peer, plugin, or command the
operator separately configures.

## Transcript evidence is not AgentDB memory

The two stores have different jobs:

| Store | Intended content | How content gets there |
| --- | --- | --- |
| deja-vu | Searchable evidence from agent histories: what was asked, attempted, observed, or failed. | Source histories are indexed; auto mode may recall matching evidence. |
| AgentDB | Curated operational memory and learned state: decisions, patterns, skills, and task outcomes chosen for reuse. | Ruflo, Agentic QE, and explicit learning workflows write structured memory. |

A transcript is not promoted into AgentDB merely because deja-vu indexed or recalled it. A recall
also does not prove that a prior conclusion is current or correct. Keep durable decisions in the
curated memory path and use deja-vu to find the evidence behind them.

## Index lifecycle

Agentic Kit installs each selected target with `--no-guidance --no-index`, then runs one explicit:

```bash
deja index
```

This avoids rebuilding once per host. Do not describe this step as `warmup`: `deja index` is the
v0.19.0 indexing contract.

Later syncs run `deja index` only when the observed index is missing or stale, or when an explicit
repair requires it. `ak status`, dashboard reads, and a converged `ak sync` do not rebuild it.

Agentic Kit takes the active index location from `deja doctor` rather than deriving it from XDG
settings. Before an index can be purged, the path must be absolute, canonical, named `index.db`,
inside an approved data root, and separate from host configuration and transcript-source roots.
Broad paths, traversal, unresolved variables, and symlink escapes are refused.

## Observe, repair, and verify

```bash
ak status
ak status --json
ak sync --dry-run
ak sync
ak x verify deja-vu
```

- `status` is read-only. It runs the v0.19.0 offline doctor contract, inspects host wiring
  separately, and reports compatible, degraded, external, or disabled state without printing raw
  doctor strings or paths.
- `status --json` exposes the same sanitized Agentic Kit facts. It does not copy deja-vu's raw
  doctor document into the response.
- `sync --dry-run` shows owned package, wiring, and index repairs without applying them.
- `sync` updates an Agentic Kit-owned npm installation through npm, never through `deja update`.
  It changes only receipt-owned wiring and verifies observed state afterward.
- `ak x verify deja-vu` performs the deeper companion proof. It checks the compatible package and
  CLI, doctor schema and health, selected host wiring and auto capabilities, and index state. It
  does not issue a recall/search query or retrieve transcript-derived content. Any deep index
  damage check remains bounded and content-free.

deja-vu 0.19.0 added `schema_version: 2` to object-shaped JSON responses. Agentic Kit requires
schema 2 for doctor facts, accepts additive fields within it, and fails closed on a missing,
malformed, or future schema. That state appears as degraded rather than as a healthy or absent
installation. The offline doctor reports the installed version without contacting the release
service; npm version drift uses Agentic Kit's normal cached npm checks.

Doctor is diagnostic: many unhealthy states still exit zero. Agentic Kit reads the reported
component states instead of treating exit zero as proof of health.

## Ownership and external installations

Agentic Kit records exact package and wiring values that it creates. That receipt is the authority
for later repair and removal.

- An npm package installed by Agentic Kit can be updated or removed by Agentic Kit.
- A compatible package installed by you, another package manager, or a native installer is
  reported as external. Agentic Kit can use it after opt-in but does not adopt its update or
  removal lifecycle.
- Matching pre-existing host wiring remains external unless the lifecycle explicitly records a
  safe adoption. Foreign and user-edited values are preserved.
- Partial repair retains the receipts for operations that still need recovery. It never reports a
  failed repair as green merely because an older executable remains usable.

## Disable and remove it

Preview removal first:

```bash
ak uninstall --dry-run
```

The scopes are deliberately independent:

| Command or flag | Removed | Preserved |
| --- | --- | --- |
| `ak uninstall` | Exact Agentic Kit-owned deja-vu host wiring. | Package, derived index, source histories, deja-vu configuration, policy, notes, exclusions, imports, and external plugins/wiring. |
| `ak uninstall --remove-deja-vu` | Owned wiring and the npm package, but only when Agentic Kit has the install receipt. | All deja-vu data and every source history. External package installations are preserved. |
| `ak uninstall --purge-deja-vu-data` | Owned wiring and the validated derived `index.db` after a separate confirmation. | Package, source histories, configuration, policy, notes, and external state. |
| Both deja-vu flags | Owned wiring, receipt-owned npm package, and the confirmed derived index. | Source histories and external/user-owned state. |
| `ak uninstall --purge` without either deja-vu flag | Agentic Kit's ordinary purge scope. | The deja-vu package and all deja-vu data. |

`--yes` can satisfy the ordinary uninstall confirmation, but destructive index removal remains a
separately disclosed scope. A rejected or unsafe path is not deleted. No Agentic Kit removal path
deletes Claude, Codex, OpenCode, or another harness's source transcripts.

To keep the integration disabled after teardown, record the choice with `ak setup --no-deja-vu`
or leave `integrations.tools.dejaVu.enabled` false in Agentic Kit's configuration.

## Common degraded states

| Status | Meaning | Operator action |
| --- | --- | --- |
| Doctor schema missing, malformed, or unsupported | Agentic Kit cannot safely interpret the installed CLI. | Install or update to a supported deja-vu release, then run `ak sync`. Do not hand-edit doctor JSON. |
| Required host target unavailable | The installed CLI does not advertise the explicit target Agentic Kit needs. | Update deja-vu through npm or keep the integration disabled. Agentic Kit will not guess another target. |
| Index `missing` or `stale` | Histories are not indexed or have changed. | Preview with `ak sync --dry-run`, then run `ak sync` or `deja index`. |
| Index `stale-readonly` | The index is usable for reads but cannot be refreshed. | Repair ownership/permissions on the reported data directory outside Agentic Kit, then sync. |
| Store `unreadable`, `denied`, `needs-sqlite3`, or `needs-zstd` | A source cannot be completely parsed. | Run `deja doctor --offline` locally for path-specific diagnostics; Agentic Kit intentionally sanitizes those details. |
| MCP wired but auto hooks missing | Search tools work, but the requested automatic event surface is incomplete. | Inspect the host/plugin coexistence notes above, repair the owned wiring with `ak sync`, and restart the host. |
| External package or plugin | The capability is present but outside Agentic Kit ownership. | Update or remove it with the tool that installed it. Agentic Kit status remains read-only for that artifact. |

For the upstream machine-output contract, see deja-vu's
[JSON output documentation](https://github.com/vshulcz/deja-vu/blob/v0.19.0/docs/json-output.md)
and [v0.19.0 release notes](https://github.com/vshulcz/deja-vu/releases/tag/v0.19.0).
