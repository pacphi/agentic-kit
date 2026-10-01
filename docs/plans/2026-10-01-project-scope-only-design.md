# Project-scoped management only

## Status

**Direction accepted** (2026-10-01), with the maintainer's decisions recorded under
[Decisions](#decisions). Nothing is implemented yet. P0 is next, starting with removing deja-vu.

This becomes an ADR that supersedes:

- ADR-0035 in full (deja-vu);
- the parts of ADR-0008, ADR-0015, ADR-0017 and ADR-0058 §3 that place state at user level.

It must land before the 4.0 GA surface freeze (ADR-0020).

## Outcome

agentic-kit changes nothing outside a project the user has explicitly opted in, with one narrow,
declared exception for Codex. Someone can install or run `ak`, then open Claude Code, Codex or
OpenCode in any other folder, and the experience is the same as if agentic-kit didn't exist.

Inside an opted-in project:

- everything the kit adds is previewed file by file before it happens;
- it is layered on top of what is already there;
- it is recorded, and one command removes it.

The user never has to finish the job by hand.

## The rule

**The blast radius of every `ak` command is the opted-in project.**

Judge by effect, not just by where a file sits. Only four kinds of write are allowed:

1. **Inside the project root.** By default it goes into a git-ignored layer.
2. **A kit-owned cache that does nothing by itself.** This covers versioned tool installs and the
   Brain knowledge base, under `$XDG_CACHE_HOME/agentic-kit/` (`%LOCALAPPDATA%` on Windows).
   Nothing in it is on `PATH`, registered with a host, or run unless an opted-in project points
   at it. Deleting it is always safe; the next `ak sync` refills it.
3. **Records the host keeps per project, written through the host's own command.** The only one
   is Claude's local-scope MCP registration, made with `claude mcp add -s local` and
   `claude mcp remove -s local` from the project root. Claude stores it in `~/.claude.json` under
   that project's path, and it loads only in that project. ak never edits `~/.claude.json`
   directly.
4. **The Codex exception register.** A closed, coded list of Codex user-level settings that have
   no project-level equivalent. Each is disclosed in the plan, receipted, reference-counted
   across opted-in projects, and removed when the last project that needs it is turned off. See
   [Codex exception register](#codex-exception-register).

Reading is not restricted: the dashboard, usage and census still read transcripts. Every other
write is out of scope. In particular, ak never:

- runs `npm install -g`, whether for Ruflo, AQE, agent-browser, `@ruvector/typesafe`, a host CLI,
  or itself;
- writes `~/.claude/{CLAUDE.md,settings.json,skills/,plugins/}` or user-scope servers in
  `~/.claude.json`;
- writes anything under `~/.config/opencode/`;
- writes `~/.codex/AGENTS.md`, or `~/.codex/config.toml` outside the exception register;
- edits shell rc files, `PATH`, launchd or systemd, or another tool's account-wide switch (for
  example `ruflo funnel disable`);
- pulls or aliases models in the user's Ollama store without a separate yes;
- stops, reaps or restarts processes it cannot tie to an opted-in project.

## Decisions

| # | Question | Decision (2026-10-01) |
| --- | --- | --- |
| 1 | Where do tools and the Brain knowledge base live? | The kit-owned cache under `~/.cache/agentic-kit` is approved. |
| 2 | How is Claude MCP registered? | **Local scope** (`claude mcp add -s local`) in personal mode, so the repository is untouched and there is no approval prompt. Team mode uses `.mcp.json`. |
| 3 | Default audience | **Personal.** Team mode is opt-in. |
| 4 | deja-vu | **Removed from agentic-kit entirely.** See [Removing deja-vu](#removing-deja-vu). |
| 5 | Superpowers found at user level | Its guidance is carried **only into projects with evidence of prior Superpowers use**. See [Superpowers](#superpowers). |
| 6 | Codex settings with no project-level equivalent | Managed by ak under a **declared exception**, so the user never has to do anything by hand. See [Codex exception register](#codex-exception-register). |

## What this replaces

The inventory was taken at `0511d57`. Paths are relative to the repository.

| Surface | Today | Proposed |
| --- | --- | --- |
| Ruflo, AQE, agent-browser, typesafe | `npm i -g …@latest`, unpinned for Ruflo and AQE (`src/lib/heal.mjs:208`, `src/commands/setup.mjs:322-345`, `src/lib/ruflo-components/apply.mjs:59`) | Exact versions pinned per project, in the versioned tool cache |
| Edits inside global packages | aidefence `--no-save`, a better-sqlite3 rebuild and `npm pkg set` in the global Ruflo tree (`src/lib/heal.mjs:28-106`) | The same repairs, made only in ak's cached copy; a user's own Ruflo is never changed |
| Host CLIs | Prompted global install in setup; installed without a prompt by sync and `host pick` (`src/lib/providers.mjs:358`, `src/commands/sync.mjs:260-289`) | Detected and explained, never installed |
| Kit self-update | `npm i -g @pacphi/agentic-kit@x` as sync's last step (`src/lib/heal.mjs:222`) | Reports the upgrade command for however `ak` was installed |
| Claude guidance | Up to about 10.5 KB of blocks in `~/.claude/CLAUDE.md`, loaded in **every** Claude session (`src/lib/blocks.mjs:48-175,489`) | About 1.5 KB always-on in opted-in projects; on-demand skills |
| Codex and OpenCode guidance | `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md` | Project skills, OpenCode `instructions`, and a project `AGENTS.md` block where allowed |
| Ruflo MCP | `claude mcp add -s user`; `codex mcp add` into the user config (`src/lib/mcp.mjs:176`, `src/lib/providers.mjs:846`) | Claude local scope; project `.codex/config.toml`; project `.opencode/` |
| AQE's Claude MCP entry | Written into `.mcp.json` by `aqe init` | Converted to a Claude local-scope registration in personal mode |
| Ruflo component, provider and AQE budget env | `~/.claude/settings.json` `env`; user settings are the fallback outside a repository (`src/lib/claude-env-projection.mjs:12`, `src/lib/providers.mjs:469`) | `.claude/settings.local.json` only, with no fallback |
| Tool-family deny rules | `~/.claude/settings.json` `permissions.deny` (`src/lib/mcp.mjs:662`) | `.claude/settings.local.json` |
| Token-audit skill | Copied into `~/.claude/skills/` on every setup; scans all projects (`src/commands/setup.mjs:370`) | A project skill, scoped to this project's transcripts by default |
| Superpowers guidance | Added to `~/.claude/CLAUDE.md` whenever the plugin is in Claude's plugin cache (`src/lib/blocks.mjs:114-128`) | Added only to projects with evidence of Superpowers use |
| OpenCode wiring | User `opencode.json`, plugins, agents, skills and wildcard approvals (`src/lib/opencode-core.mjs:631-722`, `src/lib/opencode-artifacts.mjs`) | Project `.opencode/`; approvals apply to that project only |
| RuvNet Brain | A user-scope Claude plugin whose hooks (including a write gate) run in every session (`src/lib/brain-hook-contract.mjs:11-27`), and the `~/.claude/ruvnet-brain` shim | Knowledge base in the shared cache; `search_ruvnet` MCP per project; hooks only by per-project opt-in |
| Codex status line, context window, trust | `~/.codex/config.toml`; trust left to the user (`src/lib/codex-statusline.mjs:157`, `src/lib/codex-context.mjs:86`) | Codex exception register |
| Codex and Claude MCP repairs, host alignment | Edits `~/.codex/config.toml` and `~/.claude.json` (`src/lib/codex-mcp-reconcile.mjs`, `src/lib/host-alignment.mjs`) | Codex: the exception register, for entries ak owns or caused. Claude user scope: retired by `ak migrate` |
| AQE embeddings | Pulls `all-minilm` into Ollama's machine-wide store and creates an alias there (`src/lib/aqe-embedding-lifecycle.mjs:54-69`) | Default `unmanaged`; the pull and the alias each need their own yes |
| agent-browser | `~/.config/agentic-kit/agent-browser.json`; Chrome for Testing in `~/.agent-browser/` | Config in project state; a system Chrome first, otherwise the cache |
| deja-vu | Global install; user-level host wiring; plaintext index | Removed (decision 4) |
| Daemons | `ruflo daemon stop --all` before upgrades; machine-wide `ps` sweep and reap (`src/commands/sync.mjs:315`, `src/lib/daemons.mjs:213-303`) | Only the current project's daemon, by receipt |
| npx cache | Prunes `~/.npm/_npx` (`src/lib/npx.mjs:39-76`) | npm's cache is left alone |
| Kit config and state | `~/.config/agentic-kit/kit.json` holds machine choices **and** per-project receipts keyed by absolute root; `~/.local/state/agentic-kit/` | `.agentic-kit/` in each project (see [Project layout](#project-layout)) |
| Brain's macOS LaunchAgent | ak removes the installer's job (`src/lib/heal.mjs:370`) | Never created, because the installer's user mode is no longer used |
| Bare `ak` | A 24-hour `npm view` nudge that creates and writes `kit.json` (`bin/agentic-kit.mjs:251`) | Read-only; the version check is cached in the project or the cache |

Already project-scoped and kept as they are:

- `.swarm/` memory, `.claude-flow/` and `.agentic-qe/`;
- `.harness/mcp-policy.json`;
- the statusline footer;
- the AQE lifecycle hooks.

Two defects surfaced during the inventory:

- **A dangling pointer.** `claude/ruflo-reference.md` points at
  `~/.config/ruflo/ruflo-reference-full.md`. No code deploys that file any more
  (`uninstall.mjs:542` only deletes a legacy copy), so every new installation points at nothing.
- **Force-initializing in the user's tree.** Project setup runs `ruflo init --full --force`
  directly in the project. That can regenerate `.claude/settings.json` and `.mcp.json` and drop
  the user's custom MCP entries (`docs/setup.md`). This is the biggest "ruined my setup" risk,
  and it is fixed by [staging](#upstream-initializers-are-staged-never-forced).

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
ak sync            bring this project back to its declared state; offline when the cache
                   holds the pinned versions
ak upgrade [name]  move this project's pins forward, show what changes, then sync
ak off             remove ak from this project and restore what it changed
ak undo            roll back the last ak change in this project
ak doctor          read-only prerequisites check: node, git, host CLIs, Ollama, Chrome,
                   and leftovers from older versions
ak migrate         move from a pre-change user-level installation (see Migration)
ak cache [list|prune]
                   inspect and garbage-collect the tool and Brain cache
```

`ak setup` stays as an alias. Inside a project it runs `ak init`. Outside a project it explains
the change and points to `ak init` and `ak migrate`.

The recommended first run installs nothing globally:

```bash
cd my-project
npx @pacphi/agentic-kit@next init
```

A global `npm i -g @pacphi/agentic-kit` is still fine. That is the user's choice, and ak never
makes it for them.

### The `ak init` conversation

```text
agentic-kit adds agent tooling to this project only.
Your ~/.claude, ~/.config/opencode and global npm packages stay exactly as they are.

Found here
  hosts on PATH   claude 2.1.290 · codex 0.161.0 · opencode (not installed)
  existing        CLAUDE.md (tracked, 84 lines) · .mcp.json (tracked: github, postgres)
                  .claude/settings.json (tracked: 6 hooks)
  Superpowers     installed for your account; used here in 14 sessions (last 2026-09-28)
  older ak        user-level ruflo MCP and CLAUDE.md blocks found; `ak migrate` (optional)

What to add
  [x] Ruflo memory and swarm     [x] Agentic QE
  [ ] RuvNet Brain search        (2.1 GB, shared cache, downloaded once)
  [ ] Browser executor           (uses your Chrome)
  Hosts: [x] Claude Code  [x] Codex

Who sees it
  (•) Just me: only git-ignored files; teammates see no change
  ( ) My team: commit .agentic-kit/project.json so teammates can run `ak sync`

Plan: 10 files, 0 tracked files modified
  + .agentic-kit/project.json, local.json          new, ignored
  + .claude/settings.local.json                    merge: env 4, hooks 3 (yours kept)
  + .claude/rules/agentic-kit.md                   new, ignored (1.6 KB always-on,
                                                   includes Superpowers notes)
  + .claude/skills/ak-ruflo/ ak-aqe/               new, ignored (load on demand)
  + Claude MCP (this project only)                 ruflo, agentic-qe via `claude mcp add -s local`
                                                   (.mcp.json untouched)
  + .codex/config.toml                             new, ignored
  + .agents/skills/ak-ruflo/ ak-aqe/               new, ignored
  + .git/info/exclude                              one ak block listing the above
Codex account settings (exception; removed when you turn ak off here)
  ~ ~/.codex/config.toml                           trust this folder so Codex loads the project
                                                   settings above (Codex will also edit files
                                                   here without asking each time)
Tools: ruflo 3.48.0, agentic-qe 3.14.5 into ~/.cache/agentic-kit/tools
       (410 MB, shared between projects, nothing added to PATH)

A snapshot is taken first; `ak undo` restores it.  Apply? [y/N]
```

The rules behind it:

- **The default is No.** `--yes` exists for automation and still prints the plan. Codex trust
  additionally needs `--codex-trust` when running non-interactively.
- **The plan lists files, not themes.** Each entry is marked new, merge, tracked-modify or
  exception. `--dry-run --diff` shows the merged keys.
- **Personal is the default.** Each file ak adds is listed in one managed block in
  `.git/info/exclude`, which is shared across worktrees and never committed. Claude MCP goes
  through local scope, so `.mcp.json` is never touched in personal mode. A tracked file is
  modified only after a confirmation that names it.
- **Missing hosts are explained, not installed.** For example: "Codex isn't installed. Install it
  however you prefer, then run `ak sync` here."
- **ak never touches the user's own tools.** An existing global Ruflo, user-scope MCP server,
  Brain plugin or Superpowers plugin is reported as coexisting, with how it interacts in this
  project. It is not "fixed".

### Upstream initializers are staged, never forced

`ruflo init` and `aqe init` no longer run directly in the user's tree.

1. **Stage.** Copy the project's agent-configuration paths into a temporary workspace:
   `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.mcp.json`, `.codex/`, `.agents/`, `.opencode/` and
   `.gitignore`.
2. **Sandbox.** Run the initializer there with `HOME`, `XDG_*`, `CLAUDE_CONFIG_DIR` and
   `CODEX_HOME` pointed at a throwaway folder. Anything the upstream tool writes at user level is
   caught, reported, and turned into an upstream issue. It is never applied. The test helpers
   `sandboxHome()` and `spawnEnv()` already model this.
3. **Classify.** Compare the staged result with the original. Each path is a new file, a member
   of the curated profile, a change to a user file, or a deletion.
4. **Apply** only these:
   - new files in the chosen profile;
   - merges ak understands: hooks, permissions within the disclosed allow-list, and MCP entries.
     In personal mode, MCP entries become Claude local-scope registrations.

   Deletions and rewrites of user content are never applied, and conflicts are listed.
5. **Receipt.** Record the path, the digest written and the source version (for example
   `ruflo@3.48.0`). Later updates replace a file only while it still matches its receipt.

Profiles limit what lands:

| Profile | Contents |
| --- | --- |
| `minimal` (default) | Memory, MCP, hooks, and one skill per component |
| `standard` | `minimal` plus the core agents |
| `full` | Everything upstream generates |

Today `ruflo init --full` puts dozens of agents and skills into every project, and the context
pays for all of them (ADR-0042).

If an initializer turns out to need the whole project for detection, the fallback is a
transaction in place: snapshot, run, then revert everything outside the profile. That is weaker
than staging, but still fails closed.

## Project layout

```text
.agentic-kit/
  project.json        intent: components, allowed hosts, exact tool versions, profile,
                      routing policy, governance. Committed in team mode, ignored otherwise.
  local.json          personal choices: hosts you use, providers, budgets, adapter consent
                      and grants, remembered approvals. Always ignored.
  bin/                generated launchers (ruflo-mcp, aqe-mcp, brain-mcp)
  guidance/           rendered guidance sources that host files import or reference
  state/              receipts, evidence, health history, snapshots, transactions,
                      references held on Codex exceptions. Always ignored.
```

`kit.json` retires:

- Its per-project receipts move into each project's `state/`. Today they are keyed by absolute
  root inside a user file: `rufloDaemon.receipts`, `integrations.ownership.aqePin.projects`,
  `integrations.ownership.rufloComponents.*` and `cleanups.setupProbeRows`.
- `ak sync --all` finds opted-in projects by looking for `.agentic-kit/project.json` among the
  read-only census (ADR-0027) and any paths given. No user-level registry is needed.
- A team's `project.json` pins `kitVersion`. An older `ak` says so instead of acting.

## Tools without global installs

Each tool version lives at `$XDG_CACHE_HOME/agentic-kit/tools/<package>@<exact>/`. ak installs
it into a temporary folder with `npm install --prefix <tmp> --allow-scripts=<reviewed>`, builds
and checks its natives there, then renames it into place atomically. Versions sit side by side:

- a project on Ruflo 3.46 and another on 3.48 do not interfere;
- an upgrade no longer has to stop every daemon on the machine.

Hosts reach the tools through `.agentic-kit/bin/` launchers. Each launcher finds its project root
from its own location instead of walking up from the current folder. This replaces the workspace
logic in `ak x ruflo-mcp` (`src/lib/ruflo-memory.mjs:119`). Claude local-scope entries point at
the launcher by absolute path. Team-mode `.mcp.json` uses
`${CLAUDE_PROJECT_DIR:-.}/.agentic-kit/bin/ruflo-mcp`. Ruflo MCP no longer exists outside
opted-in projects, so the `~/.claude-flow/memory` fallback store goes away.

Two other tool modes:

- `tools: "project"` installs into `.agentic-kit/tools/` for full isolation, for example in
  containers or CI. It uses more disk.
- `tools: "system"` uses a Ruflo or AQE the user installed themselves. ak checks it and never
  upgrades or edits it.

`ak cache prune` keeps every version pinned by a project it can find, plus anything used in the
last 30 days. Only an explicit command removes a cached version.

## Hosts

| | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Always-on guidance | `.claude/rules/agentic-kit.md`; loads at launch and does not stop Claude reading `AGENTS.md` | Block in `AGENTS.md`, only if the file is absent or untracked, or the user agrees | `instructions` in `.opencode/opencode.json` |
| On-demand guidance | `.claude/skills/ak-*` | `.agents/skills/ak-*` | `.opencode/skills/ak-*` |
| MCP | Personal: local scope through `claude mcp add -s local`, pointing at `.agentic-kit/bin/`. Team: `.mcp.json` with `${CLAUDE_PROJECT_DIR}` | `[mcp_servers.*]` in project `.codex/config.toml` | `mcp` in `.opencode/opencode.json` |
| Env and policy | `.claude/settings.local.json` `env` | `.codex/config.toml` `[shell_environment_policy.set]` and server `env` | `.opencode/opencode.json` |
| Hooks and plugins | `.claude/settings.local.json` hooks | `.codex/hooks.json`; Codex asks once per hook (ak never writes `trusted_hash`) | `.opencode/plugins/` |
| Host consent | None in personal mode; the one-time `.mcp.json` approval in team mode | Folder trust, handled by the exception register | None |
| Statusline | Project settings (unchanged) | Exception register, unless project config honours it | — |

Notes:

- **Claude.** Personal mode uses local scope because it touches nothing in the repository and
  shows no approval prompt. The `enableAllProjectMcpServers` and `enabledMcpjsonServers`
  pre-approvals work only from user or managed settings, so `.mcp.json` would otherwise prompt
  each user. Guidance goes in `.claude/rules/`, not `CLAUDE.local.md`. A `CLAUDE.local.md` counts
  as a `CLAUDE.md`, so creating one in an `AGENTS.md`-only repository would stop Claude reading
  `AGENTS.md`. The existing `claude mcp remove ruflo -s local` (`src/commands/setup.mjs:570`)
  turns into the registration path, and receipts record each name ak added so that `ak off`
  removes only those.
- **Codex.** `codex mcp add` writes only the user config, so ak writes the project TOML through
  the existing `codex-toml-safety` module, which already does this for the AQE pin. Project
  `.codex/` layers load only in trusted folders, which is why trust is the first entry in the
  exception register.
- **OpenCode.** ADR-0017 rejected `opencode mcp add`, not the project layer. Project config is
  merged over global config, so the four wildcard approvals become project-only, which is
  strictly safer.
- **External adapters (Hermes and future ones).** Today `lifecycle.apply` and `lifecycle.undo`
  run arbitrary subprocesses with `HOME` and no write scope
  (`src/lib/adapters/lifecycle-registry.mjs:269-299`). Under this design:
  - adapters must declare their write roots;
  - ak runs them with `cwd` set to the project and a sandboxed `HOME`;
  - conformance fails any adapter that writes outside its declared project paths;
  - registry validation rejects `scope: 'user'` trust changes for every host
    (`src/lib/adapters/registries.mjs:206-266`). The only exception is Codex's own register,
    which is coded and not declared by an adapter.

## Codex exception register

Codex keeps some behaviour only in `~/.codex/config.toml`. Leaving those settings to the user
would mean manual steps, and the kit must not leave the user with manual work. So ak manages
them as a declared exception, not by default. The register is a constant in code (for example
`CODEX_USER_EXCEPTIONS`). Nothing reads it from configuration, and adapters cannot extend it.

| Entry | Why it cannot be project-level | When ak applies it |
| --- | --- | --- |
| `[projects."<root>"] trust_level = "trusted"` | Codex reads trust only from the user config, and without it Codex ignores the project's `.codex/config.toml`, hooks and MCP | Codex is enabled for this project and the user approves the line in the plan |
| `[tui] status_line`, `status_line_use_colors` | ADR-0015: user-scoped. Check per Codex version whether the project config honours it; if it does, the entry moves to the project and leaves the register | The user chose the Codex status line for this project |
| `model_context_window` | Same check as the status line (`src/lib/codex-context.mjs:56-61`) | The user chose the maximum context for this project |
| Repairs to entries ak wrote or caused: the recursive `codex mcp-server`, and the `claude-flow` placeholder that stops Codex re-importing Claude's MCP | Codex's own Claude-config import puts them in the user file | Found during `init`, `sync` or `migrate`; the entry must match an exact known form |

How the register works:

- **Disclosure.** Each entry appears in the plan under its own heading. Trust is a separate,
  explicitly named question, because it also changes Codex's approval behaviour for that folder.
- **Never overwrite the user.** A key is set only when it is absent, or when ak owns it by
  receipt. A user's own value is reported and left alone. ak never writes `trusted_hash`,
  `[hooks.state]` or plugin tables; Codex's per-hook consent remains its own.

  Writing `trust_level` reverses the 2026-09-01 hook-remediation rule ("never edit project
  trust"). That rule targeted automatic edits; this one is a consented plan item, scoped to an
  opted-in project's exact root.
- **Reference counting.** A sidecar receipt next to `~/.codex/config.toml` (following the
  existing `.agentic-kit-*.json` pattern) lists which opted-in project roots hold each entry.
  `ak off` removes the project's references, and the last reference out restores the original
  value, or removes the key if there was none. Trust entries are always per project, so
  `ak off` removes that project's trust line directly.
- **Backups and atomicity.** Every write follows the existing `writeFileWithBackup` contract and
  goes through `codex-toml-safety`. Symlinked or non-regular files remain report-only.
- **Enforcement.** The write gate allows `~/.codex/config.toml` only through the exception
  module, which holds a capability nothing else can get. The contract test permits exactly the
  register's keys to change, and only when Codex is enabled.

## Superpowers

ak never installs, moves, enables or disables the Superpowers plugin. It belongs to the user.
What ak manages is its **guidance**: `claude/superpowers-reference.md`, which explains how
Superpowers and ak's planning conventions fit together. Today that guidance goes into
`~/.claude/CLAUDE.md` whenever the plugin sits in Claude's plugin cache, so every session on the
machine pays for it.

Under this design, the guidance goes only where Superpowers has actually been used:

- **Evidence of use, per project.** Any one of these counts:
  - a `superpowers:*` skill invocation or Superpowers command in that project's Claude or Codex
    transcripts (the usage classifier already recognizes these skill names,
    `src/lib/usage-classify.mjs:47-51`);
  - Superpowers artifacts committed in the repository, such as `docs/superpowers/`, or plan files
    carrying a Superpowers sub-skill header;
  - Superpowers enabled in the project's own Claude settings.
- **Migration.** `ak migrate` adds the guidance only to opted-in projects that have evidence. The
  preview shows the evidence, for example "14 sessions, last 2026-09-28". Projects without
  evidence don't get it, and the user-level block is then retired.
- **New projects.** `ak init` includes the guidance when the project has evidence. When the
  plugin is installed but the project has no history, it is offered unticked.
- **Where it lands.** It goes in the project's always-on rule, in the personal layer, because the
  plugin is personal tooling.

## Components

**Ruflo.** Cached and pinned. Component env (the typesafe picker, the MiniLM embedder, the
learning profile) moves into the project env. The funnel opt-out is account-wide, so ak only
explains how to turn it off, unless Ruflo gains a project tier.

Ruflo writes its own `~/.claude-flow/` state whenever it runs: neural data, the rate limiter,
`global-ai-budget` and the daemon registries. ak can't stop that alone. Where Ruflo honours a
project-local home, ak sets it; it reports what it observes; and it files an upstream request
through the upstream registry.

The project daemon stays. Sync restarts only this project's daemon, using its pid receipt. The
machine-wide orphan report moves to `ak doctor` and becomes read-only. It offers to stop only
processes whose working folder is an opted-in project.

**Agentic QE.** Cached and pinned. `aqe init` is staged, and the existing project-root pins stay.
The embedding backend defaults to `unmanaged`, which leaves Ollama untouched. Choosing Ollama
asks one yes for "pull `all-minilm` into your Ollama (shared with everything else that uses
Ollama)". Creating the alias needs a second yes, unless upstream accepts a configurable model
name. That should be requested upstream.

**RuvNet Brain.** The 2 GB knowledge base is data, so there's no point copying it into each
project. It lives once in the cache, or wherever `RUVNET_BRAIN_KB` points, and does nothing
unless a project turns search on. The installer's user mode (its plugin, the shim and the
nightly LaunchAgent) is replaced by:

- downloading and verifying the knowledge-base release asset directly, which needs a "knowledge
  base only" mode upstream or ak's own verified download;
- running the Brain MCP server from the tool cache with `RUVNET_BRAIN_KB` set.

The Brain hooks (session start, prompt submit, the write gate and the stop gates) change
behaviour heavily. They become a separate per-project opt-in, projected into
`.claude/settings.local.json`.

**agent-browser.** It uses a system Chrome when one is present. Otherwise Chrome for Testing goes
into the cache, if agent-browser lets ak choose the location; that needs checking. Its config
moves into `.agentic-kit/state/`.

## Removing deja-vu

deja-vu indexes every coding-agent history on the machine and keeps a user-level index, so it
cannot fit a project-only kit. It is removed from agentic-kit completely, as the first change in
P0.

- **Code.** Delete:
  - `src/lib/deja-vu.mjs`, `src/lib/adapters/deja-vu.mjs` and `src/commands/status/deja-vu.mjs`
    (1,430 lines);
  - the deja-vu references in 17 other source files: setup and uninstall flags, the sync
    step, the trust-manifest group, live checks, refresh, the dashboard About entry, and the
    `kit.json` `integrations.tools.dejaVu` intent with its defaults and validation;
  - their 26 test files.

  The companion registry (`src/lib/adapters/companion-registry.mjs` and its lifecycle registry)
  has deja-vu as its only member. It goes too, unless the MetaHarness proposal (ADR-0022) still
  needs that seam.
- **Flags.** `--with-deja-vu`, `--deja-vu-mode`, `--no-deja-vu`, `--remove-deja-vu` and
  `--purge-deja-vu-data` are removed. For one release, passing any of them prints what changed
  and how to manage deja-vu directly, then exits 2.
- **Docs.** `docs/deja-vu.md` and ADR-0035 move to `docs/archive/`. ADR-0035 is marked superseded.
  The README, installation, setup, managed-tools, troubleshooting, upgrading and maintainer guides
  lose their deja-vu sections.
- **Existing users.** `ak migrate` offers one hand-back step, and these flags are its only deja-vu
  code. It shows what ak installed or wired, using the `integrations.ownership.dejaVu` receipts,
  and offers two choices:
  - **keep** (the default): deja-vu keeps working, and ak simply stops managing it;
  - **remove what ak set up**: the receipt-owned host wiring, plus the package if ak installed it.

  The derived index is removed only after its own, separate confirmation, because it is the
  user's data. The hand-back code is deleted in the release after GA.

## Guidance and templates

There is one source per topic in `claude/` and a small renderer for each host, so the
duplication is removed at the source rather than by sharing a user-level file.

**Always-on** (budget 1.5 KB). Condensed safety and verification rules from `ruflo-preamble.md`,
a list of what this project has enabled and which skills to use, and the Superpowers notes when
the project has evidence of use.

**On-demand skills** (no always-on cost):

| Skill | Source |
| --- | --- |
| `ak-ruflo` | `ruflo-reference.md`, with the 439-line `ruflo-reference-full.md` as its reference file. This fixes the dangling pointer. |
| `ak-aqe` | `aqe-reference.md` |
| `ak-brain` | `ruvnet-brain-reference.md` |
| `ak-hosts` | `providers-reference.md`, `dual-mode-reference.md` and `ruflo-opencode-reference.md`, only when they apply |
| `ak-token-audit` | The token-audit skill, rescoped to this project |

ADR-0008's principle still holds: personal facts such as dual-host mode, provider bindings or
Superpowers use are never committed. In team mode they render only into the ignored layer.

The effect on context: today a machine with ak installed pays about 10.5 KB in every Claude
session in every folder. Afterwards, folders without ak pay nothing, and opted-in projects pay
about 1.5 KB.

## Sync, status, off

- **`ak sync`**
  1. Reads `project.json` and `local.json`.
  2. Makes sure the pinned tools are in the cache.
  3. Re-renders projections whose receipts show they are unchanged, and reports edited files
     instead of overwriting them.
  4. Re-checks this project's Codex exception entries.
  5. Verifies, then appends to the health history in `state/`.

  It never upgrades, never self-updates, and never touches another project.
- **`ak upgrade`** is the only command that moves pins. It shows the version change and the
  files that would change. In team mode it leaves `project.json` modified for the user to commit.
- **`ak status`** has three sections:
  - **This project.** Today's project rows, plus Codex exception entries.
  - **Prerequisites.** Read-only checks: node, git, host CLIs, Ollama, Chrome.
  - **Left over from older versions.** User-level ak artifacts, with `ak migrate` named.
    Informational only; these never fail.
- **`ak off`**
  - Removes receipted files that are unchanged, restores edited files from the snapshot, and
    removes the Claude local-scope registrations ak added.
  - Drops this project's Codex exception references and removes the ak block from
    `.git/info/exclude`.
  - Stops this project's daemon.
  - Asks before removing data (`.swarm/`, `.agentic-qe/`); the default is to keep it.

  There is no machine teardown beyond the reference-counted Codex entries.

## Migration

`ak migrate` is a guided, reversible move. Each step shows a preview and asks first; nothing runs
automatically.

1. **Find** older installations:
   - `kit.json` and its receipts;
   - sentinel blocks in user guidance files;
   - the user-scope `claude-flow` MCP entry and the user Codex `ruflo` entry;
   - env-ownership receipts and OpenCode receipts;
   - the token-audit skill, the Brain user plugin and global packages;
   - deja-vu receipts;
   - the Superpowers plugin.
2. **Opt projects in.**
   - Candidates are projects named in `kit.json` receipts, plus census projects that have
     `.claude-flow/`, `.swarm/` or `.agentic-qe/`.
   - For each one, show a preview, and carry the `kit.json` choices over as its `local.json`.
   - User-level MCP becomes local-scope registrations, and the Superpowers guidance follows the
     evidence rule.
   - The user picks which projects to keep.
3. **Move Codex settings into the exception register.** Status line, context window and
   repaired entries that ak already owns in `~/.codex/config.toml` are adopted as register
   entries, with references from the projects opted in during step 2. Nothing changes on disk.
4. **Hand back deja-vu** (see [Removing deja-vu](#removing-deja-vu)).
5. **Retire user-level artifacts, by proven ownership only.** Proof means a complete sentinel, a
   matching receipt, or an exact ak command form. Each group is offered on its own. Global
   packages and the Brain plugin default to **keep**, because the user may use them directly.
6. **Archive** `kit.json` as `kit.json.retired-<date>`. Backups follow the existing
   `writeFileWithBackup` contract.

## Making it stick

1. **Write gate.**
   - `file-write.mjs` allows only paths inside the project root and the cache, plus the Codex
     register through its capability. Anything else throws `OutOfScopeWrite`.
   - A lint rule bans direct `fs` writes, and the `claudeDir`/`codexDir`/`opencodeDir` helpers,
     in writer modules.
2. **Command gate.**
   - The exec wrapper refuses `npm install -g`, `claude mcp add -s user`, `codex mcp add`,
     `launchctl` and similar commands.
   - It allows `claude mcp add|remove -s local` only with the project root as `cwd`.
3. **Contract test.**
   - Runs `init`, `sync`, `upgrade`, `off` and `migrate --dry-run` for every combination of host
     and component under `sandboxHome()`.
   - Asserts that `HOME` is byte-identical apart from three things: the cache, the
     `projects["<root>"].mcpServers` entries in `~/.claude.json`, and the register's keys in
     `~/.codex/config.toml`.
   - `run-tests.mjs` already fingerprints the user paths, so any regression would show there.
4. **Upstream watch.** Staged initializers report user-level writes made by upstream tools, and
   each one becomes an upstream thread.

## Phasing

| Phase | Lands |
| --- | --- |
| P0 | Remove deja-vu. Then the ADR, the write gate in report-only mode, and the contract test recording today's violations as its baseline |
| P1 | The `.agentic-kit/` layout, and `ak init` in personal mode for Claude: rules, skills, `settings.local.json`, local-scope MCP launchers. Staged `ruflo init` and `aqe init` with profiles. User-level guidance writes stop for new projects |
| P2 | Tool cache and launchers. Global npm installs, self-update and host-CLI installs removed. Daemon handling scoped to the project |
| P3 | Codex project projections and the Codex exception register; OpenCode project projections; write scopes for external adapters |
| P4 | Brain knowledge-base-only mode, agent-browser, embeddings consent, Superpowers evidence. Upstream requests filed |
| P5 | `sync`, `status`, `upgrade`, `off` and `undo` working on project state; team mode |
| P6 | `ak migrate`; the write gate switched to enforcing; the machine-reconciliation code paths removed (user blocks, the user OpenCode lifecycle, user Codex repairs outside the register, the machine-wide daemon sweep) |

## Trade-offs

- **Disk.** The shared cache keeps disk use close to today's. `tools: "project"` duplicates
  roughly 400 MB per project, which is why it is not the default.
- **Host prompts.** In personal mode Claude shows none. Codex still asks once per hook, because
  `trusted_hash` stays Codex's own consent. Team-mode `.mcp.json` shows Claude's one-time
  approval.
- **The Codex exception is real user-level state.** It is narrow, coded, disclosed,
  reference-counted and reversible. It exists so the user never has to edit Codex config by hand.
- **Upstream behaviour ak can't control.** Ruflo's `~/.claude-flow/` and the Brain installer can
  still write user-level state when they run. Staging with a sandboxed `HOME` contains this
  during `ak init`; long-running tools need upstream switches.
- **No project-level home.** The Ruflo funnel opt-out becomes a printed instruction.

## Follow-ups to verify during implementation

- Whether the current Codex release honours `tui.status_line` and `model_context_window` in a
  trusted project's `.codex/config.toml`. Each key that it honours leaves the exception register.
- Whether agent-browser accepts a browser install location, and whether Ruflo accepts a
  project-local home for its `~/.claude-flow/` state.
- Whether the Brain installer has, or will accept, a knowledge-base-only mode.
