# Project-scoped management only

## Status

**Proposed** (2026-10-01). Awaiting maintainer decisions on the five open questions at the end.
Nothing is implemented. If accepted, this becomes an ADR that supersedes parts of ADR-0008,
ADR-0015, ADR-0017, ADR-0035 and ADR-0058 §3, and it must land before the 4.0 GA surface freeze
(ADR-0020).

## Outcome

agentic-kit changes nothing outside a project the user has explicitly opted in. A person can
install or run `ak`, open Claude Code, Codex or OpenCode in any other folder, and see exactly the
experience they had before agentic-kit existed. Inside an opted-in project, everything the kit
adds is previewed file by file, layered on top of what is already there, recorded, and removable
with one command.

## The rule

**The blast radius of every `ak` command is the opted-in project.**

Judge by effect, not just by where a file sits. A write is allowed when it is one of these:

1. **Inside the project root.** By default it goes into a git-ignored layer.
2. **A kit-owned cache that does nothing on its own.** This covers versioned tool installs and
   the Brain knowledge base under `$XDG_CACHE_HOME/agentic-kit/` (`%LOCALAPPDATA%` on Windows).
   Nothing in the cache sits on `PATH`, is registered with a host, or runs unless an opted-in
   project points at it. Deleting the folder is always safe; the next `ak sync` refills it.
3. **A record the host itself keeps per project, made through the host's own flow.** Examples
   are Codex's trust prompt and Claude's approval prompt for `.mcp.json` servers. ak never writes
   these. It tells the user to expect the prompt.

Reading is not restricted. The dashboard, usage and census can still read transcripts. Every
other write is out of scope. In particular, ak never:

- runs `npm install -g` (not for Ruflo, AQE, agent-browser, `@ruvector/typesafe`, deja-vu, host
  CLIs, or itself);
- writes `~/.claude/{CLAUDE.md,settings.json,skills/,plugins/}`, user-scope `~/.claude.json`
  servers, `~/.codex/{AGENTS.md,config.toml}`, or anything under `~/.config/opencode/`;
- edits shell rc files, `PATH`, launchd/systemd, or another tool's account-wide switches (such as
  `ruflo funnel disable`);
- pulls or aliases models in the user's Ollama store without a separate, explicit yes;
- stops, reaps or restarts processes it cannot tie to an opted-in project.

## What this replaces

The inventory below was taken on 2026-10-01 at `0511d57`. Paths are relative to the repository.

| Surface | Today | Proposed |
| --- | --- | --- |
| Ruflo, AQE, agent-browser, typesafe | `npm i -g …@latest`, unpinned for Ruflo/AQE (`src/lib/heal.mjs:208`, `src/commands/setup.mjs:322-345`, `src/lib/ruflo-components/apply.mjs:59`) | Exact versions pinned per project and installed into the versioned tool cache |
| Edits inside global packages | aidefence `--no-save`, better-sqlite3 rebuild, `npm pkg set` in the global Ruflo tree (`src/lib/heal.mjs:28-106`) | The same repairs, but only inside ak's own cached copy; a user's own Ruflo is never mutated |
| Host CLIs | Prompted global install during setup; sync and `host pick` install without a prompt (`src/lib/providers.mjs:358`, `src/commands/sync.mjs:260-289`) | Detect and explain only, never install |
| Kit self-update | `npm i -g @pacphi/agentic-kit@x` as the last sync step (`src/lib/heal.mjs:222`) | Report the new version and the upgrade command for however `ak` was installed |
| Claude guidance | Up to about 10.5 KB of blocks in `~/.claude/CLAUDE.md`, loaded in **every** Claude session on the machine (`src/lib/blocks.mjs:48-175,489`) | About 1.5 KB always-on in opted-in projects, with the rest as on-demand skills |
| Codex and OpenCode guidance | `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md` | Project `AGENTS.md` block (only where allowed), project skills, and OpenCode `instructions` |
| Ruflo MCP | `claude mcp add -s user`; `codex mcp add` writes the user config (`src/lib/mcp.mjs:176`, `src/lib/providers.mjs:846`) | Project `.mcp.json`, project `.codex/config.toml`, project `.opencode/` |
| Ruflo component env, provider env, AQE budget | `~/.claude/settings.json` `env`, with user settings as the fallback outside a repo (`src/lib/claude-env-projection.mjs:12`, `src/lib/providers.mjs:469`) | `.claude/settings.local.json` only; no fallback |
| Tool-family deny rules | `~/.claude/settings.json` `permissions.deny` (`src/lib/mcp.mjs:662`) | `.claude/settings.local.json` |
| Token-audit skill | Copied to `~/.claude/skills/` on every setup and scans all projects (`src/commands/setup.mjs:370`) | Project skill, scoped to this project's transcripts by default |
| OpenCode wiring | User `opencode.json`, plugins, agents, skills and wildcard approvals (`src/lib/opencode-core.mjs:631-722`, `src/lib/opencode-artifacts.mjs`) | Project `.opencode/` layer; approvals apply to this project only |
| RuvNet Brain | User-scope Claude plugin whose hooks run in every session, including a write gate (`src/lib/brain-hook-contract.mjs:11-27`), plus the `~/.claude/ruvnet-brain` shim | Shared knowledge base in the cache; `search_ruvnet` MCP per project; hooks only by per-project opt-in |
| Codex extras | `tui.status_line` and `model_context_window` in `~/.codex/config.toml` (`src/lib/codex-statusline.mjs:157`, `src/lib/codex-context.mjs:86`) | The project `.codex/config.toml` if Codex honours those keys there; otherwise a printed snippet the user can paste |
| Codex and Claude MCP repairs, host alignment | Edits `~/.codex/config.toml` and `~/.claude.json` (`src/lib/codex-mcp-reconcile.mjs`, `src/lib/host-alignment.mjs`) | Report-only for user files; `ak migrate` removes only entries ak can prove it owns |
| AQE embeddings | Pulls `all-minilm` and creates an alias in Ollama's machine-wide store (`src/lib/aqe-embedding-lifecycle.mjs:54-69`) | Default `unmanaged`; a pull, and separately an alias, each need their own yes |
| agent-browser | `~/.config/agentic-kit/agent-browser.json`; Chrome for Testing in `~/.agent-browser/` | Config in the project state folder; prefer a system Chrome, otherwise the cache |
| deja-vu | Global install; `deja install` edits user configs for every host; user-level plaintext index | Leaves onboarding (open question 4) |
| Daemons | `ruflo daemon stop --all` before upgrades; a machine-wide `ps` sweep and reap (`src/commands/sync.mjs:315`, `src/lib/daemons.mjs:213-303`) | Only the current project's daemon, identified by its receipt |
| npx cache | Prunes `~/.npm/_npx` (`src/lib/npx.mjs:39-76`) | Leave npm's cache alone |
| Kit config and state | `~/.config/agentic-kit/kit.json` holds machine choices **plus** per-project receipts keyed by absolute root; evidence, receipts and transactions live under `~/.local/state/agentic-kit/` | `.agentic-kit/` inside each project (see below); no user-level config |
| Brain macOS LaunchAgent | ak removes the installer's job (`src/lib/heal.mjs:370`) | Never created, because the installer's user mode is no longer used |
| Bare `ak` | 24-hour `npm view` nudge that creates and writes `kit.json` (`bin/agentic-kit.mjs:251`) | Read-only; any version check is cached in the project or the cache folder |

Already project-scoped, and kept as is: `.swarm/` memory, `.claude-flow/`, `.agentic-qe/`,
`.harness/mcp-policy.json`, the statusline footer and the AQE lifecycle hooks.

Two defects surface from this inventory:

- `claude/ruflo-reference.md` points at `~/.config/ruflo/ruflo-reference-full.md`, which no code
  deploys any more (only `uninstall.mjs:542` deletes a legacy copy). Every new installation
  ships a dangling pointer.
- Project setup runs `ruflo init --full --force` directly in the user's tree. That can
  regenerate `.claude/settings.json` and `.mcp.json` and drop the user's custom MCP entries
  (`docs/setup.md`). This is the biggest "ruined my setup" risk. It needs fixing whatever is
  decided here.

## Onboarding

### Commands

```text
ak                 status for this project. Outside an opted-in project it says so,
                   with how to opt in, and writes nothing.
ak init            opt this project in: detect, choose, preview, apply. Replaces project setup.
ak init --dry-run  the full per-file plan, applying nothing
ak init --like ../other-project
                   copy choices from another opted-in project (the replacement
                   for machine-wide defaults)
ak sync            bring this project back to its declared state. Offline when the cache holds
                   the pinned versions.
ak upgrade [name]  move this project's pins forward, show what changes, then sync
ak off             remove ak from this project and restore what it changed
ak undo            roll back the last ak change in this project
ak doctor          read-only prerequisites check: node, git, host CLIs, Ollama, Chrome,
                   and leftover user-level files from older versions
ak migrate         move from a pre-change user-level installation (see Migration)
ak cache [list|prune]
                   inspect and garbage-collect the tool and Brain cache
```

`ak setup` stays as an alias. Inside a project it runs `ak init`. Outside one it explains the
change and points to `ak init` and `ak migrate`.

The recommended first run installs nothing globally:

```bash
cd my-project
npx @pacphi/agentic-kit@next init
```

A global `npm i -g @pacphi/agentic-kit` is still fine. It is the user's choice, and ak never
makes it for them.

### The `ak init` conversation

```text
agentic-kit adds agent tooling to this project only.
Nothing outside ~/code/my-project changes; your ~/.claude, ~/.codex, ~/.config/opencode and
global npm packages stay exactly as they are.

Found here
  hosts on PATH   claude 2.1.290 · codex 0.161.0 · opencode (not installed)
  existing        CLAUDE.md (tracked, 84 lines) · .mcp.json (tracked: github, postgres)
                  .claude/settings.json (tracked: 6 hooks)
  older ak        user-level ruflo MCP and CLAUDE.md blocks found; see `ak migrate` (optional)

What to add
  [x] Ruflo memory and swarm     [x] Agentic QE
  [ ] RuvNet Brain search        (2.1 GB, shared cache, downloaded once)
  [ ] Browser executor           (uses your Chrome)
  Hosts: [x] Claude Code  [x] Codex

Who sees it
  (•) Just me: only git-ignored files; teammates see no change
  ( ) My team: commit .agentic-kit/project.json so teammates can run `ak sync`

Plan: 11 files, 0 tracked files modified
  + .agentic-kit/project.json, local.json          new, ignored
  + .claude/settings.local.json                    merge: env 4, hooks 3 (yours kept)
  + .claude/rules/agentic-kit.md                   new, ignored (1.4 KB always-on)
  + .claude/skills/ak-ruflo/ ak-aqe/               new, ignored (load on demand)
  ~ .mcp.json                                      tracked; see "MCP for Claude" below
  + .codex/config.toml                             new, ignored; Codex asks you to trust
                                                   this folder once
  + .agents/skills/ak-ruflo/ ak-aqe/               new, ignored
  + .git/info/exclude                              one ak block listing the above
Tools: ruflo 3.48.0, agentic-qe 3.14.5 into ~/.cache/agentic-kit/tools
       (410 MB, shared between projects, nothing added to PATH)

A snapshot is taken first; `ak undo` restores it.  Apply? [y/N]
```

The rules behind this conversation:

- **The default answer is No.** `--yes` is for automation and still prints the plan.
- **The plan lists files, not themes.** Each file is marked new, merge or tracked-modify, and the
  merge keys are shown on request (`--dry-run --diff`).
- **Personal is the default.** Every file ak adds goes into one managed block in
  `.git/info/exclude`. That file is shared across worktrees and never committed. A *tracked*
  file is modified only with a named confirmation, and never in personal mode when an ignored
  layer exists.
- **Missing hosts are explained, not installed.** For example: "Codex isn't installed. Install it
  however you prefer, then run `ak sync` here."
- **ak never edits the user's own tools.** An existing global Ruflo, user-scope MCP server or
  Brain plugin is reported as coexisting, with how it interacts in this project. It is not
  "fixed".

### Upstream initializers are staged, never forced

`ruflo init` and `aqe init` stop running directly in the user's tree.

1. **Stage.** Copy the project's agent-configuration paths into a temporary workspace:
   `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.mcp.json`, `.codex/`, `.agents/`, `.opencode/` and
   `.gitignore`.
2. **Sandbox.** Run the initializer there with `HOME`, `XDG_*`, `CLAUDE_CONFIG_DIR` and
   `CODEX_HOME` pointed at a throwaway folder. Anything the upstream tool writes at user level
   is caught, reported, and becomes an upstream issue. It is never applied. The test helpers
   `sandboxHome()` and `spawnEnv()` already model this.
3. **Classify.** Compare the staged result with the original. Each path is one of: new file,
   member of the curated profile, change to a user file, or deletion.
4. **Apply.** Only new files in the chosen profile, plus merges ak understands: hooks,
   permissions within the disclosed allow-list, and MCP entries. Deletions and rewrites of user
   content are never applied; conflicts are listed.
5. **Receipt.** Record the path, the digest written and the source version (for example
   `ruflo@3.48.0`). Later updates replace a file only while it still matches its receipt.

Profiles cap what lands. `minimal` (the default) is memory, MCP, hooks and one skill each.
`standard` adds the core agents. `full` is everything upstream generates. Today
`ruflo init --full` drops dozens of agents and skills into every project, all paid for in
context (ADR-0042).

If an initializer turns out to need the whole project for detection, the fallback is a
transaction in place: snapshot, run, then revert everything outside the profile. That is
weaker, but still fail-closed.

## Project layout

```text
.agentic-kit/
  project.json        intent: components, hosts allowed, exact tool versions, profile,
                      routing policy, governance. Committed in team mode; ignored otherwise.
  local.json          personal choices: hosts you use, providers, budgets, adapter consent
                      and grants, the approvals ak remembers. Always ignored.
  bin/                generated launchers (ruflo-mcp, aqe-mcp, brain-mcp)
  guidance/           the rendered guidance sources the host files import or reference
  state/              receipts, evidence, health history, snapshots, transactions. Always ignored.
```

- `kit.json` retires. Its per-project receipts, now keyed by absolute root in a user file
  (`rufloDaemon.receipts`, `integrations.ownership.aqePin.projects`,
  `integrations.ownership.rufloComponents.*`, `cleanups.setupProbeRows`), move into each
  project's `state/`.
- `ak sync --all` finds opted-in projects by looking for `.agentic-kit/project.json` among the
  read-only census (ADR-0027) and any paths given. No user-level registry is needed.
- A team's `project.json` pins `kitVersion`. An older `ak` says so instead of acting.

## Tools without global installs

Each tool version lives at `$XDG_CACHE_HOME/agentic-kit/tools/<package>@<exact>/`. It is
installed with `npm install --prefix <tmp> --allow-scripts=<reviewed>`, has its natives built
and checked there, and is then renamed into place atomically. Versions sit side by side, so a
project on Ruflo 3.46 and one on 3.48 do not interfere, and an upgrade no longer needs to stop
every daemon on the machine.

Hosts reach the tools through `.agentic-kit/bin/` launchers that resolve their own project root
from their location, instead of walking up from the current folder. This replaces the
workspace logic in `ak x ruflo-mcp` (`src/lib/ruflo-memory.mjs:119`). Because ruflo MCP no longer
exists outside opted-in projects, the `~/.claude-flow/memory` fallback store goes away.

Two other tool modes:

- `tools: "project"` installs into `.agentic-kit/tools/` for full isolation, for example in
  containers or CI. It uses more disk.
- `tools: "system"` uses a Ruflo or AQE the user installed themselves. ak checks it and never
  upgrades or edits it.

`ak cache prune` keeps every version pinned by a project it can find and anything used in the
last 30 days. A cached version is removed only by an explicit command.

## Hosts

| | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Always-on guidance | `.claude/rules/agentic-kit.md`, which loads at launch and does not stop Claude reading `AGENTS.md` | A block in `AGENTS.md`, only if the file is absent, untracked, or the user agrees | `instructions` in `.opencode/opencode.json` |
| On-demand guidance | `.claude/skills/ak-*` | `.agents/skills/ak-*` | `.opencode/skills/ak-*` |
| MCP | `.mcp.json` launching `${CLAUDE_PROJECT_DIR:-.}/.agentic-kit/bin/ruflo-mcp` | `[mcp_servers.*]` in project `.codex/config.toml` | `mcp` in `.opencode/opencode.json` |
| Env and policy | `.claude/settings.local.json` `env` | `.codex/config.toml` `[shell_environment_policy.set]` and the server `env` | `.opencode/opencode.json` |
| Hooks and plugins | `.claude/settings.local.json` hooks | `.codex/hooks.json` | `.opencode/plugins/` |
| Host's own consent | One-time approval of `.mcp.json` servers | Folder trust, required before any `.codex/` layer loads | None |
| Statusline | Project settings (unchanged) | Project config if honoured there; otherwise a snippet to paste | — |

Notes:

- **Claude.** Use `.claude/rules/`, not `CLAUDE.local.md`. A `CLAUDE.local.md` counts as a
  `CLAUDE.md`, so creating one in an `AGENTS.md`-only repository would stop Claude reading
  `AGENTS.md`. The `enableAllProjectMcpServers` and `enabledMcpjsonServers` pre-approvals only
  work from user or managed settings, so ak does not pre-approve. The user sees Claude's own
  one-time prompt, and that is the friendly outcome. `${CLAUDE_PROJECT_DIR}` expands in
  `.mcp.json` and is set for stdio servers, which makes a committed launcher path portable for
  team mode.
- **Codex.** `codex mcp add` writes only the user config, so ak writes the project TOML through
  the existing `codex-toml-safety` module. It already does this for the AQE pin. ak never
  writes trust or `trusted_hash`. Until the user trusts the folder, status reports "waiting for
  Codex trust". That is a manual row, not an error.
- **OpenCode.** ADR-0017 rejected `opencode mcp add`, not the project layer. Project config
  merges over global, so the four wildcard approvals become project-only, which is strictly
  safer.
- **External adapters (Hermes and future ones).** `lifecycle.apply` and `lifecycle.undo`
  currently run arbitrary subprocesses with `HOME` and no write scope
  (`src/lib/adapters/lifecycle-registry.mjs:269-299`). Adapters must declare their write roots.
  ak runs them with `cwd` set to the project and a sandboxed `HOME`, and conformance fails any
  adapter that writes outside its declared project paths. Registry validation rejects
  `scope: 'user'` trust changes for every host (`src/lib/adapters/registries.mjs:206-266`).

## Components

**Ruflo.** Cached and pinned. Component env (typesafe picker, MiniLM embedder, learning profile)
moves into project env. The funnel opt-out is account-wide, so ak only explains how to do it,
unless Ruflo gains a project tier.

Ruflo also writes its own `~/.claude-flow/` state (neural, rate limiter, `global-ai-budget`,
daemon registries) whenever it runs. ak cannot control that alone. It sets a project-local home
wherever Ruflo honours one, reports what it observes, and files an upstream request through the
upstream registry.

The project daemon still exists, but sync restarts only this project's daemon, from its pid
receipt. A machine-wide orphan report moves to `ak doctor` and is read-only, with a stop offered
only for processes whose working folder is an opted-in project.

**Agentic QE.** Cached and pinned. `aqe init` is staged. The existing project-root pins stay. The
embedding backend defaults to `unmanaged`, which changes nothing in Ollama. Choosing Ollama
needs one yes for "pull `all-minilm` into your Ollama (shared with everything else that uses
Ollama)". The alias step needs a second yes, unless upstream accepts a configurable model name,
which should be requested.

**RuvNet Brain.** The 2 GB knowledge base is data, so a per-project copy makes no sense. It lives
once in the cache (or wherever `RUVNET_BRAIN_KB` points) and does nothing unless a project
enables search. The installer's user mode, with its plugin, shim and nightly LaunchAgent, is
replaced by:

- downloading and verifying the knowledge-base release asset directly; and
- running the Brain MCP server from the tool cache with `RUVNET_BRAIN_KB` set.

This needs a "knowledge base only" mode upstream, or ak's own verified download. The Brain hooks
(session start, prompt submit, the write gate, stop gates) affect behaviour heavily. They become
a separate per-project opt-in, projected into `.claude/settings.local.json`.

**agent-browser.** It uses a system Chrome when one is present. Otherwise Chrome for Testing goes
into the cache, if agent-browser lets ak choose the location; that needs checking. Its config
goes into `.agentic-kit/state/`.

**deja-vu.** It reads every coding-agent history on the machine and keeps a user-level index, so
by design it cannot be scoped to one project. See open question 4.

## Guidance and templates

There is one source per topic in `claude/`, with a small renderer per host. Duplication is
removed at the source, not by sharing a user-level file. The two layers:

- **Always-on** (budget 1.5 KB). Condensed safety and verification rules from
  `ruflo-preamble.md`, plus a list of what this project has enabled and which skills to use.
- **On-demand skills** (no always-on cost):

  | Skill | Source |
  | --- | --- |
  | `ak-ruflo` | `ruflo-reference.md`, with the 439-line `ruflo-reference-full.md` as its reference file. This fixes the dangling pointer. |
  | `ak-aqe` | `aqe-reference.md` |
  | `ak-brain` | `ruvnet-brain-reference.md` |
  | `ak-hosts` | `providers-reference.md`, `dual-mode-reference.md` and `ruflo-opencode-reference.md`, only when those are enabled |
  | `ak-token-audit` | The token-audit skill, rescoped to this project |

ADR-0008's principle still holds: personal facts such as dual-host mode or provider bindings are
never committed. In team mode they render only into the ignored layer.

The effect on context: today a machine with ak installed pays about 10.5 KB in every Claude
session in every folder. Afterwards, folders without ak pay nothing, and opted-in projects pay
about 1.5 KB.

## Sync, status, off

- **`ak sync`**
  - Reads `project.json` and `local.json`.
  - Makes sure the pinned tools are in the cache.
  - Re-renders projections where the receipt shows the file is still unchanged; edited files are
    reported, not overwritten.
  - Verifies, then appends health history to `state/`.
  - Never upgrades, never self-updates, and never touches another project.
- **`ak upgrade`** is the only command that moves pins. It shows the version change and the files
  that would change. In team mode it leaves `project.json` modified for the user to commit.
- **`ak status`** has three sections:
  - **This project.** These are today's project rows.
  - **Prerequisites.** Read-only: node, git, host CLIs, Ollama, Chrome.
  - **Left over from older versions.** User-level ak artifacts, with `ak migrate`. These rows are
    informational and never fail.
- **`ak off`** undoes everything:
  - Removes receipted files that are unchanged, restores edited files from the snapshot, removes
    the ak block in `.git/info/exclude`, and stops this project's daemon.
  - Asks before removing data (`.swarm/`, `.agentic-qe/`); the default is keep.
  - There is no machine teardown, because there is no machine footprint.

## Migration

`ak migrate` is a guided, reversible move. Each step previews and asks, and nothing runs
automatically.

1. **Find.** Look for older installations: `kit.json`, sentinel blocks, user MCP entries,
   env-ownership receipts, OpenCode receipts, the token-audit skill, the Brain user plugin, and
   global packages.
2. **Opt projects in.** Candidates come from kit.json receipts plus census projects with
   `.claude-flow/`, `.swarm/` or `.agentic-qe/`. For each, ak previews the result, carries over
   the kit.json choices as that project's `local.json`, and the user picks which to keep.
3. **Retire user-level artifacts by proven ownership only.** Proof means a complete sentinel, a
   matching receipt, or an exact ak command form. Each group is offered separately. Global
   packages and the Brain plugin default to **keep**, because the user may use them directly.
4. **Archive** `kit.json` as `kit.json.retired-<date>`. Backups follow the existing
   `writeFileWithBackup` contract.

## Making it stick

1. **Write gate.** `file-write.mjs` checks each path against the project root and the cache, and
   anything else throws `OutOfScopeWrite`. A lint rule bans direct `fs` writes and the
   `claudeDir`/`codexDir`/`opencodeDir` helpers in writer modules.
2. **Command gate.** The exec wrapper refuses `npm install -g`, `claude mcp add -s user`,
   `codex mcp add`, `launchctl` and similar commands.
3. **Contract test.** `init`, `sync`, `upgrade`, `off` and `migrate --dry-run` run for every host
   and component combination under `sandboxHome()`, and the test asserts that `HOME` is
   byte-identical apart from the cache. `run-tests.mjs` already fingerprints the user paths and
   would catch a regression.
4. **Upstream watch.** Staged initializers report user-level writes by upstream tools, and each
   one becomes an upstream thread.

## Phasing

| Phase | Lands |
| --- | --- |
| P0 | ADR; write gate in report-only mode; contract test recording today's violations as a baseline |
| P1 | `.agentic-kit/` layout and `ak init` in personal mode for Claude: rules, skills, `settings.local.json`, `.mcp.json` launchers; staged `ruflo init`/`aqe init` with profiles; user guidance writes stop for new projects |
| P2 | Tool cache and launchers; `npm -g`, self-update and host-CLI installs removed; daemon handling scoped to the project |
| P3 | Codex and OpenCode project projections; external adapter write scopes |
| P4 | Brain knowledge-base-only mode, agent-browser, embeddings consent; upstream requests filed |
| P5 | `sync`, `status`, `upgrade`, `off` and `undo` on project state; team mode |
| P6 | `ak migrate`; write gate enforcing; removal of the machine-reconciliation code paths (user blocks, user OpenCode lifecycle, user Codex repair, machine-wide daemon sweep) |

## Trade-offs

- **Disk.** Shared caches keep the cost close to today's. `tools: "project"` duplicates roughly
  400 MB per project, which is why it is not the default.
- **One-time host prompts.** Claude's `.mcp.json` approval and Codex's folder trust appear once
  per project. That is the hosts' own consent model working as designed.
- **Upstream behaviour ak cannot control.** Ruflo's `~/.claude-flow/`, the Brain installer, and
  `deja install` may still write user-level state when run. Staging and sandboxed `HOME` contain
  this during `ak init`. Long-running tools need upstream switches.
- **Features with no project-level home.** These are reduced to printed recipes: the Codex
  statusline and context window if project config rejects them, and the Ruflo funnel opt-out.

## Open questions

1. **Cache location.** Is a kit-owned cache under `~/.cache/agentic-kit` acceptable (it is inert,
   off `PATH`, and safe to delete), or must every byte live inside the project?
2. **Claude MCP when `.mcp.json` is tracked.** In personal mode, either modify the tracked file
   (visible in `git status`), or use Claude's local scope. Local scope is stored in
   `~/.claude.json` keyed by project path, written by `claude mcp add -s local`, and loads only
   in this project.
3. **Default audience.** Personal (proposed) or team?
4. **deja-vu.** Drop it from ak, or keep it only as a documented "install it yourself" companion
   that ak wires into an opted-in project when present?
5. **Codex extras with no project-level home.** Drop them and print recipes (proposed), or keep
   them as an explicitly account-wide opt-in, which would be the rule's only exception?
