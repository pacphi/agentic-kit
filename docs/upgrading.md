# Upgrading `ak` & adopting new capabilities

New `ak` features almost always ship **opt-in**. That means moving your machine to the
latest capability is *two* motions, not one: get the newer code, then turn the feature on.
This page exists because those two are easy to conflate — and `ak sync`, despite its name,
updates the code and reconverges choices you have already made.

## Supported host delegation and realignment

Claude and Codex remain ambidextrous through their native CLI workers. Agentic-kit
uses `ak run`; Ruflo's dual-mode orchestrator and AQE's `claude-code` / `codex`
providers retain their own supported routes. The optional Codex plugin in Claude
uses App Server. These paths do not require the retired `codex mcp-server`.

To audit and correct this workstation:

```bash
ak host align --all-projects
ak host align --all-projects --apply
```

The first command is read-only. The second names the affected files and offers
backed-up removal of recognized retired transports. `--yes` approves the displayed
corrections noninteractively. Approval remembers the exact repair recipe,
file, host, scope, project and name; later matching corrections do not prompt again.
Remove `integrations.hostAlignment` from `kit.json` to revoke that preference.

The all-projects scope combines the bounded session census with existing projects
declared in Claude configuration, plus the home-directory `.mcp.json`. Add
`--project /absolute/path` for a project or worktree not in those sources.
Custom environments or executables, ambiguous syntax, symlinks, and misplaced
plugins require review. The companion plugin's existing correction workflow is
`ak heal hooks --host codex`; alignment does not reinstall or delete plugins.

`ak status` reports user/current-project anomalies. Setup and sync offer
realignment, and `ak run` refuses affected workers while blocking anomalies
remain. AQE routing, provider fallbacks, modern servers named `codex` or `claude`,
and supported `claude mcp serve` tool exposure are preserved. See
[ADR-0051](adr/0051-supported-peer-delegation-and-host-realignment.md) for the policy,
official source citations, authority boundaries and verification limits.

## 2026-09-28: One evidence cache for `ak status`'s local checks

`ak status`, `ak sync`, and the dashboard now share one evidence cache
(`<state>/agentic-kit/evidence/`) for native runtime, host setup, version drift,
npm-global-root, the daemon sweep, and the ak launcher check, each with its own age rule.
Right after upgrading to this release the cache is cold. Native runtime, host setup,
host-install-method, host-launch, npm-global-root, the daemon sweep, and the ak launcher
check each probe once on their first use after the upgrade and record what they find — a normal
row, possibly a moment slower on that one check, never a placeholder state. This is expected and
needs no action. Two rows read differently until their own next refresh, unchanged by this
release: ruflo-component rows read `unknown` until `ak sync` or `ak status --refresh` (see
[managed-tools.md](managed-tools.md#managed-ruflo-components)); the remembered live-check rows
simply don't appear until `ak sync` or `ak status --refresh=live` records one.

The old, now-orphaned storage locations — `<stateBase>/agentic-kit/live-checks/` (pre-dating this
release) and `<stateBase>/agentic-kit/ruflo-components-evidence.json` (also pre-dating this
release) — are simply abandoned, not migrated. They are inert; delete them by hand or leave them.

`--refresh`'s name and default did not change; its scope grew (see [ADR-0063](adr/0063-evidence-store-and-refresh-vocabulary.md)).

## 2026-10-03: AQE is no longer pinned to the project root

AQE 3.14.5 fixed [agentic-qe#735](https://github.com/proffesor-for-testing/agentic-qe/issues/735):
a command, hook or MCP server started in a subfolder now finds the project root, the memory
database and the storage folder on its own. `ak sync` and `ak setup` no longer write the
`AQE_PROJECT_ROOT`, `AQE_MEMORY_PATH` and `AQE_STORAGE_PATH` pin, and `ak status` no longer reports
on it.

A pin an earlier version wrote is released by `ak sync` only when that is safe, because AQE uses the
nearest `.agentic-qe`:

- AQE must be 3.14.5 or later. With an older or unknown version the pin stays.
- No stray `.agentic-qe` store may exist below the project root. With one, the pin stays, because
  without it an AQE run from that folder adopts the stray. Merge the strays with
  `ak x aqe-store merge`, or remove them, and run `ak sync`.

While a pin is kept, `ak status` shows one `aqe-pin` row that says why. Releasing a pin puts back
what each file held before, as described in the 2026-09-27 entry below; `ak uninstall` always
releases it.

## 2026-09-27: AQE is pinned to the project root

> Superseded on 2026-10-03: agentic-kit no longer writes this pin. This entry describes what an
> earlier version wrote, which `ak sync` releases under the rules above.

AQE used to create a new `.agentic-qe` store in whatever folder a command, hook or MCP server
started in. `ak sync` and `ak setup` now pin AQE to the project root in projects that have
`.agentic-qe`, with three absolute values:

- `AQE_PROJECT_ROOT` — the repository root
- `AQE_MEMORY_PATH` — `<root>/.agentic-qe/memory.db`
- `AQE_STORAGE_PATH` — `<root>/.agentic-qe`

They go into the `env` of `.claude/settings.local.json`, the `agentic-qe` entry of `.mcp.json`
(only when it starts AQE's own server), and two tables of the project's `.codex/config.toml`:
`[mcp_servers.agentic-qe.env]` and `[shell_environment_policy.set]` (the environment Codex gives
the commands and hooks it runs; pinned when the table exists or AQE is registered in that file).
Your user-level `~/.codex/config.toml` is never pinned, and neither is a `.mcp.json` or project
`.codex/config.toml` that git tracks: a committed absolute path would point your teammates' AQE at a
path that does not exist on their machines. `ak status` names such a file in an `aqe-pin` hand fix;
keep it out of git (`git rm --cached`, then `.gitignore`) and run `ak sync` if you want it pinned.
`.claude/settings.local.json` is always pinned. Each file gets a receipt beside it
(`<file>.agentic-kit-aqe-pin.json`; the shell table's is
`.codex/config.toml.agentic-kit-aqe-shell-pin.json`), and `ak uninstall` puts back what was there
before, removing a table or a `settings.local.json` that ak created and left empty. ak keeps its
newest backup of each file (`<file>.ak-aqe-pin-backup.<id>`). AQE's relative
`AQE_MEMORY_PATH = ".agentic-qe/memory.db"` in either Codex table is replaced, also after
`aqe init` writes it back, and restored on uninstall. The relative value AQE writes into
`.claude/settings.json` stays: Claude Code gives `settings.local.json` precedence.

A value you set yourself is kept. `ak status` then shows an `aqe-pin` row that names the file for
you to fix by hand. A pin copied from another checkout names that checkout's root: remove the
three keys from the named file, then run `ak sync` in this checkout. Restart Claude Code, Codex
and OpenCode sessions so they pick up the new environment. After the pin, `aqe status` and
`aqe health` print "not initialized" when run from a subfolder (AQE checks the working
directory); run them from the project root.

Stores AQE already created in subfolders stay where they are until you merge them (next section).

## 2026-09-28: ak prunes redundant settings safety copies

Before writing a value into a settings file it manages (Ruflo components' env, the memory pin,
AQE's embedding-endpoint settings in Claude's and Codex's configuration — not the AQE
project-root pin above, which keeps its own newest-only rule), ak keeps a
`<file>.ak-<tag>-backup.<uuid>` copy of what was there. After a write, ak removes an older copy
of that same file and tag only when the
copy it just made and the write's receipt already prove the older one redundant: every owned
value in it matches the newest copy or the receipt, and its bytes are exactly what ak's own
editor would write back. A copy still holding the user's own formatting, values, or anything the
newest copy and receipt do not already account for is never removed. See
[ADR-0058](adr/0058-managed-ruflo-components.md) §3.

## 2026-09-27: `ak x aqe-store` merges stray AQE stores

`ak status` now shows stray AQE stores (a `.agentic-qe` folder with a `memory.db` below the project
root) as a hand fix. `ak x aqe-store status`, or `ak x aqe-store merge` without `--yes`, previews
what a merge would do. It opens no store in place, but it is not free: it copies the whole project
store and every stray store into ak's state folder, and runs `aqe init --auto --minimal` and
`aqe learning stats` in a scratch folder there to find AQE's starter patterns (the init runs
`npm exec ruflo --version`, which may reach the npm registry). It removes the copies when it
finishes. It also reports a project store that already fails SQLite's integrity or foreign-key
check, and an earlier merge that was interrupted during its import.

With every Claude Code, Codex and OpenCode session in the project closed,
`ak x aqe-store merge --yes`:

- backs up the project store;
- rehearses AQE's own export and import on copies;
- imports each stray's patterns and captured experiences into the project store;
- moves each whole stray folder to `~/.local/state/agentic-kit/aqe-store-merge/<time>/archive/`
  (`%LOCALAPPDATA%\agentic-kit\aqe-store-merge\` on Windows), beside the backup and a
  `receipt.json`.

It needs agentic-qe 3.14.4 or later and refuses while any process holds a store, or when it
cannot tell; there is no `--force`. A store that changes after the merge copied it stops the merge
before its import, or, during the import, stays in place. A nested repository or a worktree inside
the checkout keeps its own store and is skipped. Audit-trail rows and the AQE starter patterns the
project store lacks are not imported; they stay in the archive. To identify the starter patterns, the merge builds a fresh AQE store in its scratch
folder with your project's AQE embedder, so the embedder must be reachable (for Ollama, start it
first). ak keeps the archive until you delete it; see
[TROUBLESHOOTING](troubleshooting.md#restore-an-aqe-store-from-the-merge-archive) to restore one.

## 2026-09-27: No more `aqe solver` line in setup and sync

`ak setup` and `ak sync` no longer print an `aqe solver` line. AQE's native solver package was
never published, and AQE made its TypeScript solver the implementation (agentic-qe#617, released
in 3.13.10), so the step only ever reported that state and never installed anything. Nothing to do.

## 2026-09-27: System snapshot v8 (imported Codex copies)

When the ChatGPT desktop app imports a Claude Code transcript, it saves a copy as a Codex session.
Project discovery no longer counts these copies: they give a folder no Codex host and no Desktop
origin, and System says how many it set aside. A snapshot taken before this change still holds the
old hosts and origins, so the Footprint snapshot schema advances to v8. This build reports a v7
snapshot as unreadable until you run **Refresh machine** in System or `ak system --refresh=machine`. It
is never shown under the new rule. See [ADR-0060](adr/0060-session-surface-initiator-and-product-names.md) §3.

## 2026-09-27: Ruflo support window

ak supports the newest six Ruflo minor versions, and never fewer than the minors released in the
last 30 days. The oldest supported minor is the window's floor (for example `3.39.0`). `ak status`
shows a `versions` row for it:

- **inside the support window**: your Ruflo is supported; the row names the floor and when ak last
  read Ruflo's release dates.
- **unsupported**: your Ruflo is below the floor. ak's workarounds for Ruflo defects fixed before
  the floor are gone, so an older Ruflo may misbehave. Run `ak sync` to upgrade it.
- **not yet known**: ak has not read Ruflo's release dates yet. Run `ak sync`.

`ak status` never looks the dates up itself. A plain `ak sync` reads them from npm and remembers them
in `kit.json` (`versionCheck.rufloMinors`). `ak sync --dry-run` reads them for its preview and
remembers nothing; `ak sync --no-upgrade` does not read them.

## 2026-09-27: ak keeps its MCP policy file out of git

In a Ruflo repository where MCP tool governance is on, the next `ak sync` or `ak setup --project`
adds two lines to the repository's `.git/info/exclude`: `# agentic-kit` and
`/.harness/mcp-policy.json`. git then ignores the policy file ak writes. No tracked file changes:
ak never edits `.gitignore` and never ignores the rest of `.harness/`. If you already committed
ak's policy file, the line does not untrack it; run `git rm --cached .harness/mcp-policy.json` if
you want it out. When ak removes its policy file (governance turned off, or `ak uninstall`), it
removes the two lines too; a policy file you edited is yours, so ak leaves it and the lines. On Ruflo 3.46.0
and newer the policy is enforced on the stdio MCP launches, so calls beyond the cap are refused.

## 2026-09-26: `ak sync`'s exit code ignores fixes you do by hand

`ak sync` now exits 0 when everything it can repair has converged, even if a row whose fix you
must do yourself (`→ manual:` in `ak status`) is still failing. Before, such a row passed sync when
nothing else was planned and failed it next to any unrelated planned fix, so a CI job's result
depended on unrelated drift. Each failing or warning manual row is now listed after the verdict
under "needs your action", and `ak sync --json` lists them in a `needsYourAction` array of
`{ "subsystem", "level", "message", "fix" }`. When a failing manual row remains, the verdict reads
"converged — nothing left that sync can repair". A job that relied on `ak sync` failing for such a
row should read `needsYourAction`, or run `ak status`, which still reports overall health. An
info-level manual row (for example, the AQE readiness reminder) is invisible to the manual-step
note and to `needsYourAction` alike; if that is the only thing left, sync now reports "nothing to
do — all subsystems healthy" instead of counting it as a manual step.

## 2026-09-26: ak records and reverses its edits inside Ruflo's install

When `ak sync` has to rewrite a better-sqlite3 line in a package inside Ruflo's install so the
native binding can be installed, it now records the file, the field, the original value and its
own value first, in `install-edits.json` in ak's state folder (`~/.local/state/agentic-kit/` by
default). `ak status` and `ak about` show each edit that is still in place.
`ak uninstall` puts the original value back where the file still holds ak's value, and reports the
rest. A Ruflo upgrade or reinstall replaces the edited files, and ak then forgets the receipt. Edits
made by earlier releases have no receipt: ak cannot show or restore them. Reinstall Ruflo if you
want its shipped files back, then run `ak sync`.

## 2026-09-27: Claude Code's Ruflo MCP starts through ak's launcher

The next `ak sync` (or `ak setup`) replaces ak's user-scope `claude-flow` registration
(`ruflo mcp start`) with `ak x ruflo-mcp --host claude`, the launcher Codex already uses. Claude
Code sessions then use the same store as Codex: the repository's `.swarm` from any subfolder, and
the user-level store `~/.claude-flow/memory` from your home folder, a temporary root or a tool's
own folder. Ruflo also reads the repository's MCP policy file from a subfolder. A registration you
wrote yourself (another command, scope or environment key) is left alone. The launcher must be on
the `PATH` Claude Code starts with, and that `ak` must be a build whose launcher takes `--host`
(ak checks `ak x ruflo-mcp --help`). If `ak` is not found, or it is an older install whose launcher
has no `--host` option, sync keeps the old registration and says so, and `ak status` lists the step as yours: put `ak` on `PATH` (or update
it), then run `ak sync`. Restart Claude Code to pick up the new registration.

The same sync removes ak's old setup probe rows (`_setup/verify-…`) once, from both memory files of
the current project and of the user-level store, after backing each file up (see
[TROUBLESHOOTING](troubleshooting.md#old-setup-probe-rows)).

## 2026-09-26: Codex's Ruflo memory outside a project

Codex's Ruflo launcher (`ak x ruflo-mcp`) no longer creates a `.swarm` store at the filesystem
root, in your home folder itself, in a temporary root or inside a tool's own folder (`~/.codex`,
`~/.claude`, `~/.config`, `~/.local`, `~/.cache`, `~/Library/Application Support`, `%APPDATA%`).
Sessions started there share one user-level store, `~/.claude-flow/memory`. Repositories and plain
work folders keep their own `.swarm` as before. Earlier sessions may have left `~/.swarm` or
`.swarm` folders under `~/.codex/.chatgpt-projects/`. `ak status` lists them for information and
never moves or deletes them; inspect one read-only before you remove it. Restart Codex for a
running Ruflo server to pick up the new location.

## 2026-09-26: Registering a provider keeps Ruflo memory in `.swarm`

When `kit.json` lists providers and a project has no Ruflo JSON configuration
(`claude-flow.config.json` or `.claude-flow/config.json`; `ruflo init` writes only
`.claude-flow/config.yaml`), `ak setup`, `ak sync` and `ak host pick` now create a minimal
`claude-flow.config.json` containing `memory.persistPath: ".swarm"` before running
`ruflo providers configure`. Without it, Ruflo creates that file from its defaults, which point
memory at `./data/memory` and hide the existing `.swarm` store
([ruvnet/ruflo#3193](https://github.com/ruvnet/ruflo/issues/3193)). Commit the file or ignore it,
as you prefer; Ruflo adds its provider entries to it. An existing Ruflo JSON configuration, or one
named by `CLAUDE_FLOW_CONFIG`, is left alone. `ak status` warns when a Ruflo JSON configuration
points memory away from a `.swarm` store that holds entries.

## 2026-09-26: ak no longer installs a standalone agentdb

AgentDB ships inside Ruflo, and Ruflo is its only writer. `ak setup` and `ak sync` no longer
install or repin a separate global `agentdb` CLI, and `ak status` no longer shows an `agentdb`
row. The dashboard's About card for agentdb takes its state from the `natives` row about Ruflo's
bundled copy instead. Nothing is uninstalled for you. A leftover global is harmless; remove it with
`npm uninstall -g agentdb` only if you do not use it yourself and no other package, such as
`agentic-flow`, owns the `agentdb` command (`npm ls -g --depth=0` lists what is installed). An
`agentdb` key in `kit.json` is kept and ignored.

`ak x harvest` now runs only Ruflo commands from the project root: `ruflo hooks post-task`, plus
`ruflo memory distill run` when you pass `--distill`. Its `--json` result no longer carries the
`agentdb` or `harvested` fields; each step reports `ok`, `skipped` and `detail`, and the result
names the project `root`. `ak status --refresh=live --only harvest` now fails when Ruflo is
missing instead of skipping.

## 2026-09-26: Status rows say who performs each fix

Every `ak status --json` row (and each `/api/status` row) gains `repair`: `"sync"` when an
`ak sync` step performs the row's `fix`, `"manual"` when you must do it yourself, and `null` when the
row has no fix. `ak sync` plans only `"sync"` fixes and reports how many manual steps remain; text
status prints a manual fix as `→ manual: …`. Scripts that treated every `fix` as sync work should
filter on `repair`.

Warnings that ask you to act now carry that step as a manual fix instead of inside the message. This
covers the Brain plugin's unreviewed hooks and a refused Brain refresh, a missing AQE semantic
backend, Codex context and plugin issues, an unreadable model inventory, Ruflo memory
configuration and backups, unavailable external AQE intent, an invalid qe-court panel,
agent-browser's external installs and browser payload, and Ruflo components waiting on a host
restart. They are tagged `manual` on the dashboard and counted by `ak sync` and the bare `ak` hint.
A script that read the instruction from `message` should read `fix`.

## 2026-09-26: `ak sync --json` emits one JSON result

`ak sync --json` was listed in the help but printed the ordinary human output. It now writes
every human line (the plan, step results, prompts) to stderr and exactly one JSON object to
stdout, pretty-printed like `ak status --json`:

```json
{ "plan": [], "steps": [], "unresolved": [], "skipped": [], "needsYourAction": [], "converged": true, "exitCode": 0 }
```

- `plan` and `skipped` items use the `ak status --json` row fields: `subsystem`, `level`,
  `message`, `fix`, `repair`.
- Each `steps` item is `{ "id", "ok", "detail" }` for a sync step that ran; `detail` is what the
  step printed, or `null`.
- Each `unresolved` item is `{ "subsystem", "fix", "message", "reason" }`. `reason` is one of
  `not-converged`, `no-step`, `failing`, `apply-failed`, or `declined`.
- Each `needsYourAction` item is `{ "subsystem", "level", "message", "fix" }`: a failing or
  warning row whose fix you must do yourself. These never change `converged` or `exitCode`.
- `converged` is `true` when nothing is left for sync to do, `false` when it ended with unresolved
  items, and `null` when it stopped before a verdict: a dry run with a plan, a rejected flag, or an
  error. A rejected flag or an error also adds `error`, and an unreadable kit.json also adds
  `recovery` (`backup`, `commands`, `note`): the commands that move it aside. The process exit
  code equals `exitCode`.

A script that scraped stdout of `ak sync --json` for human lines should read stderr instead.

## 2026-09-26: `ak sync` fails when a planned repair did not take

After applying its plan, `ak sync` checks status again. If a row it planned to fix is still there
with the same fix, or it planned a fix that no sync step performs, it prints
`unresolved: [subsystem] fix — reason` and exits 1. Before, it printed "converged" and exited 0. A
CI job or script that runs `ak sync` can now fail where it used to pass; the `unresolved:` line
names what to look at. Manual fixes (`→ manual:` in `ak status`) are never planned and never fail
sync. A Ruflo install that lacks its bundled agentdb now shows a manual reinstall on the `natives`
row instead of a sync action that no step performed.

## 2026-09-26: AQE embedding edits in Codex TOML

Unrelated keys in Codex `config.toml`, such as `tui.status_line = ["model"]` or other
dotted and quoted root keys, no longer stop ak from projecting the AQE embedding
endpoint into that file.

An AQE registration written inline (`agentic-qe = { … }` under `[mcp_servers]`, or
`mcp_servers = { … }`) was previously read as absent and skipped silently. With a selected
embedding backend it is now reported as a conflict: `ak status` shows it as a hand fix
(`→ manual:`) naming the file, and `ak sync` leaves the entry alone and lists it under "needs your
action" without failing. Run
`ak x aqe-embedding status --json` to see the file and reason, then rewrite the entry as a
`[mcp_servers.agentic-qe]` table.

AQE entries started with `aqe mcp`, `agentic-qe mcp` or `aqe-v3 mcp` are now
recognized on Claude, Codex and OpenCode, as is every plain npx spelling:
`npx [-y|--yes] agentic-qe[@latest|@<exact version>] mcp`. With a selected embedding backend, ak now projects
the endpoint into such entries instead of reporting an unrecognized transport.

## 2026-09-10: Remembered Codex MCP correction

Claude Code's `claude-flow` registration and Codex's `ruflo` registration follow
Ruflo's host-specific conventions. Seeing both names across hosts is expected;
two enabled Ruflo connections inside Codex need review.

Run `ak sync` when status reports a duplicate. The repair prompt names the exact
configuration and offers to remember correction of the recognized user-scope
`claude-flow` alias. Accepting that prompt, or the equivalent disclosed setup
manifest with `--yes`, authorizes later setup/sync runs to repeat this bounded
correction. Historical approvals are not converted into remembered consent.

The correction disables the alias in place rather than deleting it:

```toml
[mcp_servers.claude-flow]
# agentic-kit: disabled placeholder — stops Codex's Claude import from
# re-adding a duplicate of [mcp_servers.ruflo]. Delete this table to undo.
command = "ruflo"
args = ["mcp", "start"]
enabled = false
```

Codex's Claude config import adds any Claude MCP server whose name Codex does
not already have. A deleted alias therefore returned within hours. The
placeholder keeps the name taken and launches nothing.

The correction runs after provisioning, with an enabled canonical `ruflo`
replacement present. Each correction retains the live fingerprint check, creates a
current-state backup, and verifies the result. The remembered correction is used
only while agentic-kit owns the workspace-aware `ak x ruflo-mcp` replacement.
It does not authorize removing project entries, other names, custom commands,
custom environment settings, or plugin-provided servers. Standard upstream `npx`
launch forms are recognized for diagnostics; they do not expand removal consent.

Setup and sync recheck the final topology. An unresolved duplicate or in-scope
recursive transport prevents a success verdict. Machine-only setup can repair a
user-scope duplicate when its replacement already exists, without editing project
registrations. A mismatched `CODEX_HOME` stops native removal before any write.

The preference is stored at
`integrations.ownership.codex.mcpRepairConsent` in `kit.json`. Remove that property
to revoke remembered correction. Future matching repairs will ask again. This
protects the outcome of setup/sync; it cannot prevent another program from editing
configuration between runs.

## 2026-09-04: Human session identity in System

`storage.topSessions[]` now carries an additive `identity` object with the original storage name,
host-native ID when declared, declared opening instant when available, measured file mtime, the
time basis, and per-field provenance. One bounded transcript-head read supplies identity and
working context for the already-ranked top-N rows; it does not read prompts, titles, or messages.

System > Sessions renders the identity as one two-line transcript link: localized date/time first,
then a shortened opaque native ID. Focus or hover discloses the original filename, full native ID,
and detailed localized time with timezone. If an older snapshot or host has no declared opening
instant, the measured mtime is explicitly labeled **Last active**. Run **Refresh machine** or
`ak system --refresh=machine` to populate native identity for an existing snapshot; no
configuration or payload migration is required.

## 2026-09-03: System Projects snapshot v7

The Projects section now deep-measures only repositories with both a recorded host session and a
proven HTTPS web destination. The lifetime census still reports every project-like session path,
and the payload names how many paths were excluded for no session attribution, a local-only or
unrecognized remote, an insecure HTTP remote, or unreadable evidence. This prevents a session cwd
such as the user home from triggering several hundred thousand unrelated filesystem observations.

Because that population is narrower than the v6 measurement contract, the Footprint snapshot
schema advances to v7. A v6 snapshot is reported as unreadable by this build until the next explicit
**Refresh machine** or `ak system --refresh=machine`; it is never silently reinterpreted.

## 2026-09-03: System Catalog snapshot v6

Catalog identity now preserves full plugin marketplace/version provenance and separates
standalone capability identities from plugin-contributed identities. Catalog v4 now also separates
one physical artifact from each host ConsumerBinding, and the Footprint snapshot schema advances to
v6. An older snapshot is reported as unreadable-by-this-build until
you run `ak system --refresh=machine`. It is not migrated or silently shown under the new semantics.

This issue #198 prerequisite closed through
[PR #201](https://github.com/pacphi/agentic-kit/pull/201), merge `1bf0a5b`. Its identity,
snapshot, preview, and bounded-dashboard regressions are locked by
`tests/kit/footprint-collectors.test.mjs`, `tests/kit/footprint-snapshot-v2.test.mjs`,
`tests/kit/skill-maintenance-plan.test.mjs`, and `tests/ui/dashboard-ui.mjs`.

JSON consumers should treat `catalog.items[].key` as an opaque canonical identifier. The additive
fields `canonicalId`, `capabilityName`, `pluginRef`, `sourceScopes`, occurrence evidence,
`overlaps`, `projects`, `pluginSources`, and `sourceStamps` provide relationships previously
flattened into a display name. Skill/command entrypoint bodies remain absent; only bounded SHA-256
evidence is emitted.

For a read-only project review, run:

```bash
ak system --refresh=machine
ak x skills plan --project /absolute/path/to/project
```

The plan does not remove anything. Use the separate Maintenance workflow below for provider-backed
remediation.

## 2026-09-03: Maintenance control plane

The upgrade adds `ak maintain` and **System > Maintenance**. No configuration opt-in is required,
but no operation runs automatically: ordinary scan/plan are read-only, executable plans expire
after five minutes, and apply requires the exact plan ID, digest, selected action IDs, and `--yes`.

```bash
ak maintain --refresh=machine
ak maintain plan --findings FINDING_ID --executable
ak maintain apply --plan PLAN_ID --digest SHA256 --actions ACTION_ID --yes
```

Maintenance stores private, integrity-sealed scan reports, plans, and receipts under the current
user's agentic-kit state directory. Existing System snapshot files remain read-only evidence inputs;
Catalog schema v4 is still refreshed with `ak system --refresh=machine`. `ak sync` neither selects
nor executes Maintenance findings.

Browser **Reload** reads the saved Maintenance report without polling providers. Use the header's
**Refresh** control with **Refresh** selected, or `ak maintain --refresh`, for current provider/version
evidence. A successful **Refresh machine** operation persists a new System snapshot before
updating Maintenance.

The first provider set is intentionally narrower than the inventory. Claude plugin disable,
update, and remove; exact Codex plugin/MCP removal; exact receipt-owned skill archive; one bounded
owned stale-npx cleanup; and identity-proven Ruflo MCP orphan termination can be executable when
their provider and evidence are present. OpenCode plugin/MCP, Codex per-plugin update, Claude
plugin prune, unreceipted skills, other caches, transcripts, and ambiguous resources remain
report-only.

If an older or interrupted transaction is recovery-required, new Maintenance changes stop. The
only recovery command is:

```bash
ak maintain recover --receipt RECEIPT_ID --yes
```

It reconciles every entry against its recorded preimage or verified postimage. It never retries,
applies, undoes, or compensates an uncertain operation. A mixed, drifting, or uninspectable state
remains blocked. See the [Maintenance runbook](maintenance.md) before acting on an interrupted
receipt.

## The one rule

> **`ak sync` converges to the choices already recorded in `kit.json`.** It updates the
> `ak` binary and heals whatever has drifted, but it **never makes a new opt-in decision for
> you.** Adopting a capability that shipped after your install = run that capability's own
> opt-in command.

So a feature can be *installed* (the code is on disk) without being *enabled* (your
`kit.json` never asked for it). `ak sync` will faithfully keep re-applying claude-only if
that's what you recorded — the same way it won't pick an LLM provider or exclude an MCP
family on your behalf.

## `sync` vs `setup` vs `host pick`

| Command              | What it's for                                   | Changes your `kit.json` choices? |
| -------------------- | ----------------------------------------------- | -------------------------------- |
| `ak sync`            | update the binary + heal to your recorded state | **no** — converges, never decides |
| `ak host pick` | opt into or retune execution hosts and host routing | **yes** — this is the switch |
| `ak x statusline codex native\|extended` | opt into a user-wide Codex status-line preset | **yes** — records the preset |
| `ak setup`           | first-time bootstrap of absent tooling          | only via explicit flags (`--codex`, `--opencode`, `--primary-host`) |

## Installation method and the kit's own version

The package installation method and the command's operational scope are
independent. A project-local or `npm exec` copy of `ak` can still upgrade global
Ruflo/AQE/host packages, write current-user configuration, and heal the current
project. Conversely, globally installing the runner does not initialize any
repository until a project-scoped command is run there.

`ak sync` never installs another agentic-kit version. It may report that a newer kit is
available, and every run ends by printing the three steps that move a machine to the
project-scoped line, run by exact version through `npx` whatever is installed globally. A
sync launched from a local dependency, Git checkout, or one-shot npm cache therefore never
creates or replaces a global agentic-kit installation. Use `ak sync --no-upgrade` to hold
back Ruflo, AQE and the other tools too.

See [Installation and scope](installation.md) for global, local, one-shot,
tarball, Git, source-link, multi-user, and CI guidance.

## Running `ak sync` while sessions are live

`ak sync` is plan-based: on a converged machine it prints "nothing to do" and touches
nothing. The blast radius comes entirely from what's in the plan — and the widest heals are
the ones a **`versions`** row triggers. If you have Claude Code, Codex, or OpenCode sessions
open in other terminals, here is what can actually reach them, worst first:

1. **All ruflo daemons stop, machine-wide.** Before any package upgrade, sync runs
   `ruflo daemon stop --all` (upgrades wipe native modules, so daemons must not hold them) —
   and upstream defines that as *every* workspace and worktree
   ([ruflo #2661](https://github.com/ruvnet/ruflo/issues/2661)), not just the current
   project. In-flight background work in other sessions is lost; daemons restart lazily on
   the next ruflo command in each project, so the damage is interrupted work, not lasting
   state.
2. **The npm swap window.** While `npm install -g` replaces `ruflo` / `agentic-qe` (and
   npm-managed `claude` / `codex` / `opencode` CLIs), the global tree is mid-replacement for
   up to ~30s+. Live sessions touch that tree constantly — hooks on every edit, statusline
   ticks every few seconds, MCP tool spawns — and an invocation landing in the window can
   fail once. Statusline failures degrade gracefully (the command chains fallbacks); hook
   failures surface as one-off errors. A live session's `claude-flow` MCP server keeps
   running its already-loaded code but sees a mixed-version tree for anything loaded
   lazily afterward — if its tools start misbehaving, restart that session.
3. **Other projects keep an older footer until you sync them.** Ruflo signs
   `.claude/helpers/statusline.cjs` and restores it from its manifest on its next call. The
   kit's footer lives in a loader beside it (`.claude/helpers/ak-statusline.cjs`), so an
   upgrade does not remove it. A project that still has an older kit's injection inside the
   signed helper loses that footer when Ruflo restores the file. Cosmetic; `ak sync` in that
   project installs the loader, and `ak status` flags it on the `statusline` row.
4. **A narrow race on `~/.claude.json`.** MCP registration shells out to
   `claude mcp add -s user`, which rewrites the same file live Claude sessions persist
   state into — last writer wins. Rare, but real; re-run `ak sync` if the registration
   doesn't stick.
5. **A stale npx-cache env can vanish mid-use.** The prune only removes envs strictly
   older than the installed baseline; a statusline/hook fallback executing from one at that
   moment fails once, then npx re-fetches.

What does **not** break, by design: running binaries keep executing their old code
(replaced files don't affect a running process's open inodes). Agentic-kit's managed
settings and guidance writers are atomic and fail closed when the one-time backup cannot
be created or validated. Settings env keys, `~/.codex/config.toml` edits (Ruflo/AQE MCP,
`[tui]` status line), OpenCode wiring, `.agentic-qe/llm-config.json`, and managed guidance
have host-specific reload behavior. Restart affected sessions to
load a consistent configuration. Claude can reload a changed status-line command during
a session; do not assume every setting is frozen until restart. The kit itself is never
updated by `ak sync`.

> [!TIP]
> If other sessions are mid-task: `ak sync --dry-run` first. Even without a `versions` row,
> inspect the named repairs: native-module, MCP, hook, and
> configuration changes can affect running sessions. A `versions` row → either let the
> other sessions reach a stopping point, or run `ak sync --no-upgrade` now (heals only —
> skips the daemon stop and the npm swaps entirely) and do the full sync later.
> `ak sync --skip versions` is narrower: it holds back only the package upgrades and the
> heals they trigger, and still refreshes RuvNet Brain and the kit itself. The armed
> footer wipe in other open projects follows from the upgrade itself, not from sync — expect
> it after any ruflo upgrade regardless of how you apply it.

## 4.0 GA surface migration

Version 4.0 removes the pre-GA compatibility surfaces in one direction:

- Replace `ak dual` with `ak run`. The stable executor applies `--escalate` per failed worker and
  records the attempt trail. The removed `--parallel` switch has no direct replacement because
  `ak run` is concurrent by default; use `--max-concurrent 1` for sequential execution.
  Templates, repeatable `--route` overrides, `--timeout`, and `--json` continue on `ak run`.
- Replace `ak provider` with `ak host`, and replace `ak x provider` with `ak x host`. Removed
  commands fail as unknown commands; provider bindings remain a separate domain concept.
- On first load, host enablement moves from `providers.hosts` to `integrations.hosts`,
  `providers.primaryHost` moves to `routing.primaryHost`, and `providers.dualRouting` moves to
  `routing.routes`. Within each route, `source` becomes `provenance` and `escalate` becomes
  `escalation`. `providers.bindings` merges without loss into `integrations.bindings`;
  conflicting binding ids stop with a readable configuration error.
- Adapter ownership markers such as Codex and OpenCode MCP/catalog fields move from `providers`
  to `integrations.ownership`. A successful write records versioned `routing` and `integrations`
  envelopes and removes the old fields; later loads use only the canonical shape.
- Older alphas could install the global `@claude-flow/codex` package and run
  `ruflo init --dual --force`. Those releases stored no ownership receipt, so GA cannot safely
  uninstall the package or delete generated project agents automatically. If you installed the
  package only for the removed executor, run `npm uninstall -g @claude-flow/codex`; review any
  generated project agent files before removing them.

The migration preserves user-pinned hosts, models, escalation order, and provenance. Review the
result with `ak host status`, then use `ak run --dry-run` to inspect the materialized plan.
`--json` emits machine-readable output while executing; combine it with `--dry-run` when
execution must not start.

A **host** runs the work; a **provider** serves inference. A binding can connect one provider to
several hosts through separate native configuration **projections**, while **observability**
sources establish facts with observed, configured, inferred, or unknown provenance. Upgrading does
not silently create, adopt, or rewrite these bindings, and credentials remain environment-only.
See [ADR-0016](https://github.com/pacphi/agentic-kit/blob/main/docs/adr/0016-capability-driven-integration-adapters.md).

## `ak system --json` fields removed in 4.0.0-alpha.41

Two fields left the runtime census. If you parse `ak system --json` (or `GET /api/system`), read
them defensively or drop them:

| Removed | Where | Why |
|---|---|---|
| `runtime.daemons.budget` | daemon census | No local source exists for ruflo's launch budget — not circumstantially, structurally — so the field could only ever read `unknown`. A permanently unknowable quantity is removed rather than reported as degraded ([ADR-0023](https://github.com/pacphi/agentic-kit/blob/main/docs/adr/0023-fail-closed-operations-and-explicit-degradation.md) §9). `ruflo daemon budget` remains the way to ask. |
| `runtime.childProcessCount` | runtime census | Still counted by the process survey — it is what makes the per-host rows correct — but no longer republished. As a rendered figure it was a bare number with no denominator, no history and no action attached. |

Nothing else was removed. `storage.topSessions` rows **gained** `projectLabel`,
`projectResolved`, and `context`; the raw `project` key is unchanged. The top-N rows now use the
bounded transcript-head `cwd` metadata already allowed by ADR-0025, so dated Codex rollouts can be
attributed without scanning their message bodies. `runtime.processes[]` gained `source`; its
`project` measurement is now present only when a Git repository boundary is proven. Consumers
should render `source` as the process working context and keep `project` only for repository joins.
`catalog.items` now also covers
project-scoped `.claude/skills|agents|commands` across every project on disk, so the list is
longer — the shape is identical and deduplication by `(kind, name)` is unchanged.

## QE-Court configs created before agentic-qe 3.13.3

`agentic-qe` 3.13.3 fixed its shipped QE-Court default and made configuration validation
mandatory before a court convenes. New configs seat `defense` on `claude-code`, `jury` on
`cognitum-high`, and `deeperReviewer` on `codex`, preserving three distinct vendors.

An existing `.claude/skills/qe-court/config.json` is project-owned and is not overwritten by
an agentic-qe or `ak` upgrade. If `ak status` reports `writerIsNeverJuror`, regenerate the
config with agentic-qe 3.13.3+ or change `routing.defense.provider` from `cognitum-low` to
`claude-code`. `ak` reports this state read-only; `ak sync` no longer changes QE-Court roles.

The local anti-collusion check is not a runtime-readiness proof. Current consumer projections can
reference source-only referee/oracle assets, and `primaryHost` does not reverse court seats. Use
`pnpm test:qe-court-live` in a source checkout for one bounded Claude-led and one bounded
Codex-led **participant-transport** trial; do not record it as a court verdict.

If you already have `ak` working, you almost never need `ak setup` again — it's the
installer. Enabling a shipped-but-opt-in host feature is a `host pick` (or an `x mcp pick`,
etc.), not a re-`setup`. Project setup calls `ruflo init --full --force`, so review the
[setup scope and project mutation contract](setup.md) before deliberately rerunning it in
an existing project.

Codex status-line management is deliberately not enabled merely because an
upgrade adds support for it. Run `ak x statusline codex native` once to opt in;
later `ak sync` runs converge that recorded choice. Use
`ak x statusline codex off` to relinquish ownership. See
[Managed Codex status line](codex-statusline.md).

## Worked example: adopting ambidextrous dual-host

You have an older `ak` and both the `claude` and `codex` CLIs installed, and you want the
ambidextrous dual-host experience (per-activity routing across Claude + Codex). Two motions:

```bash
ak sync                              # 1. update the binary (+ heal everything)
ak host pick --host claude,codex   # 2. opt in → wires dual-host
ak host status                 # 3. verify: hosts "Managed by ak, wired" + routing table
```

Step 1 gets the newer code onto disk. Step 2 is what actually turns dual-host on — it
records `codex` in `kit.json` and does the wiring: writes `ENABLE_CODEX` into
`.claude/settings.local.json`, seeds the per-activity routing policy, registers the
workspace-aware Ruflo MCP in Codex, retires any agentic-kit-owned legacy `codex mcp-server`
project entry, and generates the dual-host guidance.
Add `--primary-host codex` if you want Codex to lead (Claude becomes the alternate).

> [!NOTE]
> `ak sync` no longer updates the kit itself, so install the version you want first (for
> example `npm install -g @pacphi/agentic-kit`); `ak host pick` then runs under that version.

From then on, `ak sync` **maintains** the choice — it re-applies your recorded dual-host
config idempotently on every run. `ak status` flags drift; `ak host off` reverts to
the claude-only default, reversibly.

The full menu of host/provider levels — QE provider selection, deterministic fallback
chains, per-activity routing defaults, undo — lives in [providers.md](providers.md). This
page is only about the *upgrade motion*. The cross-host support and limitations
matrix lives in [host-support.md](host-support.md).

## How drift surfaces (you don't have to go looking)

Every `ak` command ends with a best-effort, never-blocking drift nudge. It has two halves:

- **Version drift** (npm-managed tools; TTL-cached network check):
  `↑ ruflo 4.1.0 available (installed 4.0.0) — run: ak sync`
- **Local artifact drift** (spawn-light file compares, evaluated on every run):
  `↻ drifted: 2 CLAUDE.md block(s) · deprecated codex MCP registered — run: ak sync`

The second half covers the artifacts `ak` *renders*: managed guidance blocks in the
machine-wide guidance files (`~/.claude/CLAUDE.md`, and `~/.codex/AGENTS.md` on codex
machines), Codex's independent Ruflo/AQE access, legacy MCP retirement, and the statusline
footer. These can drift with **no version change at all** —
a kit update (or, on an npm-linked dev checkout, merely merging a PR that edits a
`claude/*.md` template) revises the source of truth, and the rendered copies lag until the
next `ak sync`. The nudge closes that window. For guidance blocks it reads the dry run of the
same reconcile `ak sync` applies, as `ak status` does, so the three never disagree. It stays
quiet after `status`, `sync`, and `ak x reference`, which already show the same information.

## Why `ak sync` pulled a prerelease

The `4.0.0-alpha.*` train publishes to npm's **`next`** dist-tag, not `latest` (`latest`
stays pinned at the last stable-ish release). A naive "is there a newer version?" check
reads `latest` and would conclude your alpha is already ahead — so it would never offer the
upgrade.

`ak` handles this: when your **installed** version is itself a prerelease, the self-drift
check consults **both** the `latest` and `next` dist-tags and takes the higher of the two.
That's why `ak sync` on `alpha.19` correctly pulls `alpha.20` even though `latest` points
further back. (If you'd rather move it by hand: `npm i -g @pacphi/agentic-kit@next`.)

## Appendix — design references

The *why* behind primary-host selection and ambidextrous mirroring is captured as an ADR —
[docs/adr/0006-primary-host-and-ambidextrous-mirroring.md](https://github.com/pacphi/agentic-kit/blob/main/docs/adr/0006-primary-host-and-ambidextrous-mirroring.md).
The per-activity routing model spans ADR-0001..0005 (see [docs/adr/](adr/)). This page
deliberately links rather than restates them, so the ADRs stay the source of truth.
