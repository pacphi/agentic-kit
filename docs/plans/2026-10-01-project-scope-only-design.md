# Project-scoped management only

## Status

**Direction accepted** (2026-10-01). The maintainer's decisions are recorded under
[Decisions](#decisions). Nothing is implemented yet.

The next step is P0: the exit release on the current line, then the removal of deja-vu.

This plan becomes an ADR that supersedes:

- ADR-0035 in full (deja-vu);
- the user-level parts of ADR-0008, ADR-0015, ADR-0017 and ADR-0058 §3.

It also amends ADR-0025, ADR-0027 and ADR-0048 for the dashboard. It must land before the 4.0
GA surface freeze (ADR-0020).

## Outcome

agentic-kit changes nothing outside a project the user has explicitly opted in, apart from one
narrow, declared exception for Codex. Someone can run `ak`, then open Claude Code, Codex or
OpenCode in any other folder, and the experience is the same as if agentic-kit didn't exist.

Inside an opted-in project, everything the kit adds is:

- shown file by file before it happens;
- layered on top of what is already there;
- recorded, and removable with one command.

The dashboard reports facts about the whole account where they really are account-wide, and
reports what ak manages project by project. Viewing the dashboard writes nothing outside the
kit's cache. The user never has to finish a setup by hand.

## The rule

**The blast radius of every `ak` command is the opted-in project.**

Judge by effect, not just by where a file sits. Only four kinds of write are allowed:

1. **Inside the project root.** By default this goes into a git-ignored layer.
2. **A kit-owned cache that does nothing on its own.** It lives under
   `$XDG_CACHE_HOME/agentic-kit/` (`%LOCALAPPDATA%` on Windows) and holds versioned tool
   installs, the Brain knowledge base, and derived data such as scan snapshots, usage indexes and
   evidence. Nothing in it is on `PATH`, registered with a host, or run unless an opted-in project
   points at it. Deleting it is always safe; the next command rebuilds what it needs.
3. **A host's own per-project record, written through the host's own command.** The only one is
   Claude's local-scope MCP registration (`claude mcp add|remove -s local`, run from the project
   root). Claude stores it in `~/.claude.json` under that project's path, and it loads only in
   that project. ak never edits `~/.claude.json` directly.
4. **The Codex exception register.** A closed, coded list of Codex user-level settings that have
   no project-level equivalent. Each entry is shown in the plan, has a receipt, is
   reference-counted across opted-in projects, and is removed when the last project using it is
   uninstalled. See [Codex exception register](#codex-exception-register).

Reading is not restricted: the dashboard, usage and census still read transcripts. Every other
write is out of scope. In particular, ak never:

- runs `npm install -g` for anything, itself included;
- writes `~/.claude/{CLAUDE.md,settings.json,skills/,plugins/}`, or user-scope servers in
  `~/.claude.json`;
- writes anything under `~/.config/opencode/`;
- writes `~/.codex/AGENTS.md`, or `~/.codex/config.toml` outside the register;
- edits shell rc files, `PATH`, launchd or systemd, or another tool's account-wide switch;
- pulls or aliases models in the user's Ollama store without a separate yes;
- stops, reaps or restarts processes it cannot tie to an opted-in project;
- writes into a project that has not opted in. This includes the dashboard, which today writes a
  health history into any project you select.

## Decisions

| # | Question | Decision (2026-10-01) |
| --- | --- | --- |
| 1 | Where tools and the Brain knowledge base live | The kit-owned cache under `~/.cache/agentic-kit` is approved. |
| 2 | How Claude MCP is registered | Local scope (`claude mcp add -s local`) in personal mode: nothing in the repository changes and Claude shows no approval prompt. Team mode uses `.mcp.json`. |
| 3 | Default audience | Personal. Team mode is opt-in. |
| 4 | deja-vu | Removed from agentic-kit entirely. |
| 5 | Superpowers found at user level | Its guidance goes only into projects with evidence of prior Superpowers use. |
| 6 | Codex settings with no project-level home | ak manages them under a declared exception, so the user never has to edit Codex config by hand. |
| 7 | Moving existing users over | **No migration code.** One final release of the current line makes `ak uninstall --purge` remove everything, and the new version tells people to run it first. See [Upgrading from the user-level versions](#upgrading-from-the-user-level-versions). |
| 8 | Command surface | **Kept trim.** Four lifecycle verbs: `init`, `status`, `sync`, `uninstall`. See [Commands](#commands). |

Smaller calls made in this revision (flag any you disagree with):

- **The Claude MCP server keeps the name `claude-flow`.** That is today's registration name.
  Ruflo's generated agents, the auto-approve rules (`src/lib/adapters/registries.mjs:212`) and the
  Usage history all use `mcp__claude-flow__*`. Renaming it would split the Usage tool mix and break
  those references.
- **The telemetry identity moves to the cache.** If the cache is wiped, the next export looks like
  a new installation, the same as a reinstall does today.
- **Maintenance discovery preferences move to the cache** (extra roots, exclusions, source
  toggles). Losing them only resets them to defaults. The "which projects" question is answered by
  opt-in itself.

## What this replaces

The inventory was taken at `0511d57`. Paths are relative to the repository.

| Surface | Today | Proposed |
| --- | --- | --- |
| Ruflo, AQE, agent-browser, typesafe | `npm i -g …@latest`, unpinned for Ruflo and AQE (`src/lib/heal.mjs:208`, `src/commands/setup.mjs:322-345`, `src/lib/ruflo-components/apply.mjs:59`) | Exact versions pinned per project, held in the versioned tool cache |
| Edits inside global packages | aidefence `--no-save`, a better-sqlite3 rebuild and `npm pkg set` in the global Ruflo tree (`src/lib/heal.mjs:28-106`) | Made only in ak's cached copy; a user's own Ruflo is never changed |
| Host CLIs | Prompted global install during setup; installed without a prompt by sync and `host pick` (`src/lib/providers.mjs:358`, `src/commands/sync.mjs:260-289`) | Detected and explained, never installed |
| Kit self-update | `npm i -g @pacphi/agentic-kit@x` as sync's last step (`src/lib/heal.mjs:222`) | Reports the upgrade command for however `ak` was installed |
| Claude guidance | Up to about 10.5 KB of blocks in `~/.claude/CLAUDE.md`, loaded in **every** Claude session (`src/lib/blocks.mjs:48-175,489`) | About 1.5 KB always-on in opted-in projects, plus on-demand skills |
| Codex and OpenCode guidance | `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md` | Project skills, OpenCode `instructions`, and a project `AGENTS.md` block where allowed |
| Ruflo MCP | `claude mcp add -s user`; `codex mcp add` into the user config (`src/lib/mcp.mjs:176`, `src/lib/providers.mjs:846`) | Claude local scope; project `.codex/config.toml`; project `.opencode/` |
| AQE's Claude MCP entry | Written into `.mcp.json` by `aqe init` | A Claude local-scope registration in personal mode |
| Component, provider and AQE budget env | `~/.claude/settings.json` `env`, falling back to user settings outside a repo (`src/lib/claude-env-projection.mjs:12`, `src/lib/providers.mjs:469`) | `.claude/settings.local.json` only, with no fallback |
| Tool-family deny rules | `~/.claude/settings.json` `permissions.deny` (`src/lib/mcp.mjs:662`) | `.claude/settings.local.json` |
| Token-audit skill | Copied into `~/.claude/skills/` on every setup, and scans all projects (`src/commands/setup.mjs:370`) | A project skill, scoped to this project's transcripts by default |
| Superpowers guidance | Added to `~/.claude/CLAUDE.md` whenever the plugin is cached (`src/lib/blocks.mjs:114-128`) | Added only to projects with evidence of Superpowers use |
| OpenCode wiring | User `opencode.json`, plugins, agents, skills and wildcard approvals (`src/lib/opencode-core.mjs:631-722`) | Project `.opencode/`; approvals apply to that project only |
| RuvNet Brain | A user-scope Claude plugin whose hooks, including a write gate, run in every session (`src/lib/brain-hook-contract.mjs:11-27`) | Knowledge base in the cache; `search_ruvnet` MCP per project; hooks only by per-project opt-in |
| Codex status line, context window, trust | `~/.codex/config.toml`; trust is left to the user (`src/lib/codex-statusline.mjs:157`, `src/lib/codex-context.mjs:86`) | Codex exception register |
| User-level MCP repairs and host alignment | Edit `~/.codex/config.toml` and `~/.claude.json` (`src/lib/codex-mcp-reconcile.mjs`, `src/lib/host-alignment.mjs`) | Codex: register entries only, for entries ak owns or caused. Claude: none |
| AQE embeddings | Pulls `all-minilm` into Ollama's store and aliases it (`src/lib/aqe-embedding-lifecycle.mjs:54-69`) | Default `unmanaged`; the pull and the alias each need their own yes |
| agent-browser | `~/.config/agentic-kit/agent-browser.json`; Chrome for Testing in `~/.agent-browser/` | Config in project state; a system Chrome first, otherwise the cache |
| deja-vu | Global install, user-level host wiring, plaintext index | Removed |
| Daemons | `ruflo daemon stop --all` before upgrades; a machine-wide `ps` sweep and reap (`src/commands/sync.mjs:315`, `src/lib/daemons.mjs:213-303`) | Only the current project's daemon, by receipt |
| npx cache | Pruned under `~/.npm/_npx` (`src/lib/npx.mjs:39-76`) | npm's cache is left alone |
| Kit config and state | `~/.config/agentic-kit/kit.json` (machine choices **and** per-project receipts keyed by absolute root); `~/.local/state/agentic-kit/` | `.agentic-kit/` in each project, plus the cache for derived data |
| Bare `ak` and dashboard GETs | A 24-hour `npm view` nudge that creates and writes `kit.json` (`bin/agentic-kit.mjs:251`, `src/lib/versions.mjs:85,184`); evidence writes on read | Write only to the cache, or not at all |

Already project-scoped and kept:

- `.swarm/` memory, `.claude-flow/` and `.agentic-qe/`;
- `.harness/mcp-policy.json`;
- the statusline footer;
- the AQE lifecycle hooks.

Two defects surfaced on the way:

- **A dangling reference.** `claude/ruflo-reference.md` points at
  `~/.config/ruflo/ruflo-reference-full.md`, which nothing deploys any more.
- **Forced initialization in the user's tree.** Project setup runs `ruflo init --full --force`
  directly in the project. That can drop the user's own MCP entries and regenerate their
  settings. [Staging](#upstream-initializers-are-staged-never-forced) fixes this.

## Commands

The lifecycle comes down to four verbs:

```text
ak                 status for this project; outside an opted-in project it says so and how to
                   opt in, and writes nothing
ak init            opt this project in, or change its choices (hosts, components, Codex
                   extras, embeddings, MCP tool families). Re-running it shows the current
                   choices and the diff.
ak status          this project's state, its prerequisites, and drift
ak sync            bring this project back to its declared state
                   --upgrade [name[@version]]  move pins forward (or back), show what changes
                   --all                       every opted-in project ak can find
ak uninstall       remove ak from this project and restore what it changed
```

The observing and working commands stay as they are: `dashboard`, `usage`, `models`, `system`,
`about`, `audit`, `maintain`, `run`, `telemetry`, and the maintainer-only `admin`.

These are removed or folded in:

| Today | Becomes |
| --- | --- |
| `setup` | `init` |
| `host pick`, `host off`, `host reset-routes` | Re-running `init` |
| `host check-connection` | `status --refresh=live` |
| `host align`, `x host-align` | Removed: user-level repairs are out of scope, and the Codex register covers entries ak caused |
| `heal hooks` | Project-level actions move into `maintain`; user-level ones become advice the user runs |
| `x mcp`, `x statusline`, `x codex-context`, `x aqe-embedding` | Choices in `init` |
| `x reference` | `sync` renders guidance |
| `x ruflo-mcp` | The project launcher `.agentic-kit/bin/ruflo-mcp` |
| `x daemon-gc` | `sync` (this project's daemon only) |
| `x dashboard`, `x admin` | Removed as duplicates of the top-level commands |

Commands the first draft proposed and this revision drops:

| Dropped | Instead |
| --- | --- |
| `migrate` | See [Upgrading](#upgrading-from-the-user-level-versions) |
| `upgrade` | `sync --upgrade` |
| `off` | `uninstall` |
| `undo` | `uninstall` restores the pre-init snapshot, a pin goes back with `sync --upgrade name@version`, and `maintain undo` keeps its own receipts |
| `doctor` | The Prerequisites section of `status` |
| `cache` | `sync` prunes the cache, and `system` reports it |
| `init --like` | Not needed |

## Onboarding

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
  + Claude MCP (this project only)                 claude-flow, agentic-qe via
                                                   `claude mcp add -s local` (.mcp.json untouched)
  + .codex/config.toml                             new, ignored
  + .agents/skills/ak-ruflo/ ak-aqe/               new, ignored
  + .git/info/exclude                              one ak block listing the above
Codex account settings (exception; removed when you uninstall here)
  ~ ~/.codex/config.toml                           trust this folder so Codex loads the project
                                                   settings above (Codex will also edit files
                                                   here without asking each time)
Tools: ruflo 3.48.0, agentic-qe 3.14.5 into ~/.cache/agentic-kit/tools
       (410 MB, shared between projects, nothing added to PATH)

A snapshot is taken first; `ak uninstall` restores it.  Apply? [y/N]
```

The rules behind this conversation:

- **The default is No.** `--yes` exists for automation and still prints the plan. Codex trust also
  needs `--codex-trust` when there is no terminal to ask in.
- **The plan lists files, not themes.** Each entry is marked new, merge, tracked-modify or
  exception. `--dry-run --diff` shows the merged keys.
- **Personal mode is the default.** Every file ak adds is listed in one managed block in
  `.git/info/exclude`, which worktrees share and git never commits. Claude MCP goes through local
  scope, so `.mcp.json` is never touched. A tracked file is changed only after a confirmation that
  names it.
- **Missing hosts are explained, not installed.** For example: "Codex isn't installed. Install it
  however you prefer, then run `ak sync` here."
- **The user's own tools are left alone.** An existing global Ruflo, user-scope MCP server, Brain
  plugin or Superpowers plugin is reported as coexisting, with how it interacts in this project.
  ak does not "fix" it.

### Upstream initializers are staged, never forced

`ruflo init` and `aqe init` no longer run directly in the user's tree.

1. **Stage.** Copy the project's agent-configuration paths into a temporary workspace:
   `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.mcp.json`, `.codex/`, `.agents/`, `.opencode/` and
   `.gitignore`.
2. **Sandbox.** Run the initializer there with `HOME`, `XDG_*`, `CLAUDE_CONFIG_DIR` and
   `CODEX_HOME` pointed at a throwaway folder. Anything the upstream tool writes at user level is
   caught and reported, never applied, and becomes an upstream issue. The test helpers
   `sandboxHome()` and `spawnEnv()` already model this.
3. **Classify.** Compare the staged result with the original. Each path is one of: new, in the
   curated profile, a change to a user file, or a deletion.
4. **Apply** only:
   - new files in the chosen profile; and
   - merges ak understands: hooks, permissions within the disclosed allow-list, and MCP entries.
     In personal mode, MCP entries become Claude local-scope registrations.

   Deletions and rewrites of user content are never applied, and conflicts are listed.
5. **Receipt.** Record the path, the digest written and the source version. Later updates replace
   a file only while it still matches its receipt.

**Existing setups are used, not duplicated.** Many projects already ran `ruflo init` or `aqe init`
themselves, either by hand or under an older agentic-kit. When the project already has equivalent
Ruflo or AQE hooks, MCP entries, agents or skills, ak records them as present and user-owned,
uses them, and adds no second copy. A tracked `.mcp.json` that already defines `claude-flow` gets
no local-scope duplicate. Project guidance keeps the existing sentinel names
(`agentic-kit-project-guidance`, `agentic-kit-aqe-init-guard`), so blocks an older version left
behind are simply taken over. This is ordinary init behaviour, not migration code.

Profiles limit what lands:

| Profile | Contents |
| --- | --- |
| `minimal` (default) | Memory, MCP, hooks, and one skill per component |
| `standard` | `minimal` plus the core agents |
| `full` | Everything upstream generates |

Today `ruflo init --full` puts dozens of agents and skills into every project, and they all cost
context (ADR-0042). If an initializer turns out to need the whole project to detect what it is
working with, the fallback is a transaction in place: snapshot, run, then revert everything outside
the profile.

## Project layout

```text
.agentic-kit/
  project.json        intent: components, allowed hosts, exact tool versions, profile,
                      routing policy, governance. Committed in team mode, ignored otherwise.
  local.json          personal choices: hosts you use, providers, budgets, adapter consent
                      and grants, remembered approvals, project-tied dispositions. Always ignored.
  bin/                generated launchers (ruflo-mcp, aqe-mcp, brain-mcp)
  guidance/           rendered guidance sources that host files import or reference
  state/              receipts, project evidence, health history, snapshots, maintenance
                      transactions and plans, references held on Codex exceptions.
                      Always ignored.
```

- `kit.json` retires. Its per-project receipts, today keyed by absolute root inside a user file,
  move into each project's `state/`.
- `ak sync --all` and the dashboard find opted-in projects through the `optedIn` census scope (see
  [Dashboard and metrics](#dashboard-and-metrics)). There is no user-level registry.
- A team's `project.json` pins `kitVersion`. An older `ak` says so instead of acting.

## Tools without global installs

Each tool version lives at `$XDG_CACHE_HOME/agentic-kit/tools/<package>@<exact>/`. To install one,
ak runs `npm install --prefix <tmp> --allow-scripts=<reviewed>`, builds and checks its natives
there, then renames the folder into place atomically. Versions sit side by side, so:

- one project on Ruflo 3.46 and another on 3.48 do not interfere;
- an upgrade no longer has to stop every daemon on the machine.

Hosts reach the tools through `.agentic-kit/bin/` launchers.

- **Root resolution.** Each launcher works out its project root from its own location, instead of
  walking up from the current folder. This replaces the workspace logic in `ak x ruflo-mcp`
  (`src/lib/ruflo-memory.mjs:119`).
- **How hosts reference them.** Claude local-scope entries point at the launcher by absolute path.
  Team-mode `.mcp.json` uses `${CLAUDE_PROJECT_DIR:-.}/.agentic-kit/bin/ruflo-mcp`.
- **No more user-level memory store.** Ruflo MCP no longer exists outside opted-in projects, so the
  `~/.claude-flow/memory` fallback store goes away.

There are two other tool modes:

- `tools: "project"` installs into `.agentic-kit/tools/` for full isolation, for example in a
  container or CI.
- `tools: "system"` uses a Ruflo or AQE the user installed themselves. ak checks it and never
  upgrades or edits it.

`ak sync` prunes the cache. It keeps every version pinned by a project it can find, plus anything
used in the last 30 days. Anything pruned is downloaded again when needed.

## Hosts

| | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Always-on guidance | `.claude/rules/agentic-kit.md`: loads at launch and does not stop Claude reading `AGENTS.md` | A block in `AGENTS.md`, only if the file is absent or untracked, or the user agrees | `instructions` in `.opencode/opencode.json` |
| On-demand guidance | `.claude/skills/ak-*` | `.agents/skills/ak-*` | `.opencode/skills/ak-*` |
| MCP | Personal: local scope through `claude mcp add -s local` (server names `claude-flow`, `agentic-qe`, `ruvnet-brain`). Team: `.mcp.json` with `${CLAUDE_PROJECT_DIR}` | `[mcp_servers.*]` in the project `.codex/config.toml` | `mcp` in `.opencode/opencode.json` |
| Env and policy | `env` in `.claude/settings.local.json` | `[shell_environment_policy.set]` and the server `env` in `.codex/config.toml` | `.opencode/opencode.json` |
| Hooks and plugins | Hooks in `.claude/settings.local.json` | `.codex/hooks.json`; Codex asks once per hook, and ak never writes `trusted_hash` | `.opencode/plugins/` |
| Host's own consent | None in personal mode; Claude's one-time `.mcp.json` approval in team mode | Folder trust, through the exception register | None |
| Statusline | Project settings (unchanged) | The exception register, unless the project config honours it | — |

- **Claude.**
  - Guidance goes in `.claude/rules/`, not `CLAUDE.local.md`. A `CLAUDE.local.md` counts as a
    `CLAUDE.md`, so in an `AGENTS.md`-only repository it would stop Claude reading `AGENTS.md`.
  - The `.mcp.json` pre-approvals only work from user or managed settings. That is one more reason
    personal mode uses local scope.
  - Receipts record each local-scope name ak added, and `ak uninstall` removes only those.
- **Codex.** `codex mcp add` writes only to the user config, so ak writes the project TOML through
  the existing `codex-toml-safety` module, which already does this for the AQE pin. Project
  `.codex/` settings load only in trusted folders, so trust is the first entry in the exception
  register.
- **OpenCode.** ADR-0017 rejected `opencode mcp add`, not the project layer. The project config is
  merged over the global one, so the wildcard approvals become project-only.
- **External adapters (Hermes and later ones).**
  - Today their lifecycle hooks run as arbitrary subprocesses with `HOME` and no write scope
    (`src/lib/adapters/lifecycle-registry.mjs:269-299`). Adapters must declare their write roots.
  - ak runs them with the project as the working directory and a sandboxed `HOME`. Conformance
    fails any adapter that writes elsewhere.
  - Registry validation rejects `scope: 'user'` trust changes for every host
    (`src/lib/adapters/registries.mjs:206-266`).

## Codex exception register

Codex keeps some behaviour only in `~/.codex/config.toml`. Leaving it to the user would mean
manual steps, so ak manages it as a declared exception. The register is a constant in code (for
example `CODEX_USER_EXCEPTIONS`). It is never read from configuration, and adapters cannot extend
it.

| Entry | Why it cannot be per project | When ak applies it |
| --- | --- | --- |
| `[projects."<root>"] trust_level = "trusted"` | Codex reads trust only from the user config, and without it Codex ignores the project's `.codex/config.toml`, hooks and MCP | Codex is enabled for this project and the user approves that line of the plan |
| `[tui] status_line`, `status_line_use_colors` | User-scoped per ADR-0015. If a Codex version honours it in the project config, the entry moves there and leaves the register | The user chose the Codex status line for this project |
| `model_context_window` | Same check as the status line (`src/lib/codex-context.mjs:56-61`) | The user chose the maximum context for this project |
| Repairs to entries ak wrote or caused: the recursive `codex mcp-server`, and the `claude-flow` placeholder that stops Codex re-importing Claude's MCP | Codex's own Claude-config import puts them in the user file | Found during `init` or `sync`; the entry must match an exact known form |

How the register is handled:

- **Disclosure.** Each entry appears in the plan under its own heading. Trust is a separate, named
  question, because it also changes Codex's approval behaviour for that folder.
- **The user's values win.**
  - A key is set only when it is absent or already owned by ak through a receipt. A value the user
    set is reported and left alone.
  - ak never writes `trusted_hash`, `[hooks.state]` or plugin tables.
  - Writing `trust_level` reverses the 2026-09-01 hook-remediation rule "never edit project trust".
    That rule was about automatic edits; this is a plan item the user consents to, scoped to the
    exact root of one opted-in project.
- **Reference counting.** A sidecar receipt next to `~/.codex/config.toml` lists which project roots
  hold each entry. `ak uninstall` drops that project's references, and the last one out restores
  the original value or removes the key. Trust lines are per project, so they are removed
  directly.
- **Safety.** Writes go through `writeFileWithBackup` and `codex-toml-safety`. Symlinked or
  non-regular files are reported, never written.

## Superpowers

ak never installs, moves, enables or disables the Superpowers plugin; it belongs to the user. What
ak manages is the guidance in `claude/superpowers-reference.md`, which explains how Superpowers fits
ak's planning conventions. `ak init` includes it only when the project shows evidence of use. Any
of these counts as evidence:

- A `superpowers:*` skill invocation, or a Superpowers command, in that project's Claude or Codex
  transcripts. The usage classifier already recognizes these (`src/lib/usage-classify.mjs:47-51`).
- Superpowers artifacts committed in the repository.
- Superpowers enabled in the project's own Claude settings.

Without evidence, the guidance is offered but left unticked. It lands in the project's always-on
rule, in the personal layer, because the plugin is personal tooling.

## Components

**Ruflo.**

- Cached and pinned. The component env (typesafe picker, MiniLM embedder, learning profile) moves
  into the project env.
- The funnel opt-out is account-wide, so ak only explains how to turn it off, unless Ruflo gains a
  project tier.
- Ruflo writes its own `~/.claude-flow/` state when it runs. Where Ruflo honours a project-local
  home, ak sets one. Either way, ak reports what it observes and files an upstream request.
- Sync restarts only this project's daemon, using its pid receipt. System → Runtime shows other
  processes read-only.

**Agentic QE.**

- Cached and pinned, and `aqe init` is staged. The project-root pins stay.
- The embedding backend defaults to `unmanaged`, which leaves Ollama untouched.
- Choosing Ollama asks once to pull `all-minilm`, and again before creating the alias. An upstream
  request should ask for a configurable model name, which would remove the alias step.

**RuvNet Brain.**

- The 2 GB knowledge base lives once in the cache, or wherever `RUVNET_BRAIN_KB` points. A valid
  existing `~/.cache/ruvnet-brain/kb` is reused rather than downloaded again.
- The Brain MCP server runs from the tool cache.
- The installer's user mode (plugin, shim, LaunchAgent) is not used. Its replacement is either a
  "knowledge base only" mode upstream or ak's own verified download.
- The Brain hooks become a separate opt-in per project.

**agent-browser.** It uses a system Chrome when one is present, and otherwise the cache, if
agent-browser lets ak choose the location. Its config moves to `.agentic-kit/state/`.

## Removing deja-vu

deja-vu indexes every agent history on the machine into a user-level index, so it cannot fit a
project-only kit. It is removed in P0, on the new line.

- **Code.**
  - Delete `src/lib/deja-vu.mjs`, `src/lib/adapters/deja-vu.mjs` and
    `src/commands/status/deja-vu.mjs`, 1,430 lines in total.
  - Remove the references in 17 other source files: setup and uninstall flags, the sync step, the
    trust-manifest group, live checks, refresh, the dashboard About card and categories, the
    System install row, and the `integrations.tools.dejaVu` intent.
  - Delete the 26 test files that cover it.
  - The companion registry has deja-vu as its only member, so it goes too, unless the MetaHarness
    proposal (ADR-0022) still needs it.
- **Flags.** `--with-deja-vu`, `--deja-vu-mode`, `--no-deja-vu`, `--remove-deja-vu` and
  `--purge-deja-vu-data` are removed. They fail as unknown flags.
- **Docs.** `docs/deja-vu.md` and ADR-0035 move to `docs/archive/`, with ADR-0035 marked
  superseded. The guides lose their deja-vu sections.
- **Usage history.** No Usage or telemetry code names deja-vu. Old `mcp__deja-vu__*` rows age out of
  the window, and the tool-family map tags them "retired".
- **Existing users.** The exit release removes it (see below).

## Guidance and templates

Each topic has one source in `claude/` and a small renderer for each host. That removes the
duplication at its source instead of sharing one user-level file.

**Always-on** (budget 1.5 KB): condensed safety and verification rules from `ruflo-preamble.md`,
what this project has enabled and which skills to use, and the Superpowers notes when the project
qualifies.

**On-demand skills**, which cost nothing until used:

| Skill | Source |
| --- | --- |
| `ak-ruflo` | `ruflo-reference.md`, with the 439-line `ruflo-reference-full.md` as its reference file. This also fixes the dangling reference. |
| `ak-aqe` | `aqe-reference.md` |
| `ak-brain` | `ruvnet-brain-reference.md` |
| `ak-hosts` | `providers-reference.md`, `dual-mode-reference.md` and `ruflo-opencode-reference.md`, only where they apply |
| `ak-token-audit` | The token-audit skill, rescoped to this project |

Personal facts are never committed (ADR-0008's principle). That covers dual-host mode, provider
bindings and Superpowers use. Today an installed machine pays about 10.5 KB in every Claude
session, in every folder. Afterwards, a folder that hasn't opted in pays nothing, and an opted-in
project pays about 1.5 KB, plus skill descriptions.

## Sync, status, uninstall

**`ak sync`**

- Reads `project.json` and `local.json`.
- Makes sure the pinned tools are in the cache, and prunes it.
- Re-renders projections whose receipts show they are unchanged. Edited files are reported instead
  of overwritten.
- Re-checks this project's Codex exception entries.
- Verifies, then appends health history to `state/`.

It never self-updates and never touches another project. `--upgrade` is the only thing that moves
pins. In team mode it leaves `project.json` modified for the user to commit.

**`ak status`** has three sections:

- **This project:** today's project rows, plus the Codex exception entries.
- **Prerequisites:** read-only checks for node, git, the host CLIs, Ollama and Chrome.
- **Older installation:** a single row, shown only when an older agentic-kit is detected (see
  [The new version's single check](#the-new-versions-single-check)).

**`ak uninstall`**

- Removes receipted files that are unchanged, and restores edited ones from the pre-init snapshot.
- Removes the local-scope MCP names ak added, drops this project's Codex references, removes the ak
  block from `.git/info/exclude`, and stops this project's daemon.
- Asks before removing data in `.swarm/` and `.agentic-qe/`; the default is to keep it.
- Removing everything (`rm -rf ~/.cache/agentic-kit`) is always safe.

## Dashboard and metrics

The dashboard currently assumes one machine-wide installation. Four reviews (About and Overview,
System, Maintenance, Usage and Observability) found it needs four principles and a set of changes
in each area.

### Principles

1. **One project selector.**
   - The server resolves the current project by walking up from where `ak dashboard` started to
     `.agentic-kit/project.json`. A header `?project=` selector, reusing `resolveSelectedProject`
     and `keyForProject` (`src/lib/dashboard-server.mjs:206-238`), then drives the status rows,
     host health, Ruflo components, intelligence detail, improvement and refresh.
   - Today only some readers use the launch directory. `cachedHostFacts` ignores it
     (`src/lib/dashboard-server.mjs:491`), and Intelligence deliberately has no current project.
   - Outside an opted-in project, the dashboard opens in "no project" mode: prerequisites, a picker
     of opted-in projects, and the `ak init` hint.
2. **Viewing never writes outside the cache.** Today:
   - a GET of `/api/status` writes `kit.json` version checks (`src/lib/versions.mjs:85,184`) and
     evidence files (`src/commands/status.mjs:155`, `src/lib/dashboard-server.mjs:486-494`);
   - the cheap System read writes `daemon-sweep` evidence about every minute
     (`src/lib/footprint/runtime.mjs:97-99`, `src/lib/daemons.mjs:98-102`);
   - the Intelligence stream appends `.claude-flow/health-history.json` in **any** selected
     project, including `$HOME` (`src/lib/live/intelligence-watch.mjs:203-207`).

   Afterwards, version checks and evidence go to the cache. Reads that only need fresh data pass
   `record:false`. Health history goes to `.agentic-kit/state/`, and only for opted-in projects.
3. **"Opted in" is a census scope.**
   - Add `optedIn` next to `learning` in `src/lib/project-census.mjs:59`. It is a project-level,
     identity-merged scope. Each row reads a capped `<repository root>/.agentic-kit/project.json`.
     An unreadable marker is `unknown`, never `false` (ADR-0023).
   - Add a derived `seenOnly` scope.
   - Discovery needs no registry. Besides the transcript census it reads these read-only sources:
     project keys in `~/.claude.json` that hold ak local-scope entries, the roots listed in the
     Codex register's sidecar, and paths passed explicitly.
   - `sync --all`, cache pruning and every project filter below use this scope.
4. **Account-wide facts stay account-wide; ak's management is per project.** Spend, plan limits,
   transcripts and plugins belong to the account, and reading them stays allowed. What ak manages
   is shown project by project.

### About and Overview

| Panel | Today | Change |
| --- | --- | --- |
| About cards | Version chips read the npm global root (`src/lib/versions.mjs:9-17`). Host "Managed by ak" comes from `kit.json`. The configured-surface copy describes user-level MCP and guidance (`src/lib/dashboard/about-directory.mjs:278-302`). There is a deja-vu card | Chip shows the pinned version and whether it is cached. Host chip reads "Enabled for this project". Configured cards are rewritten for project scope. The deja-vu card and its join/category keys are removed (`src/lib/dashboard/groups.mjs:46,55`). The update hint becomes `ak sync --upgrade` |
| Summary and subsystem map | Most rows are machine-level: versions, natives, npx, user memory, user MCP, user blocks, daemons, deja-vu, hosts and routing from `kit.json` | Three sections matching `ak status`. Routing comes from `project.json`. The project's health-history regressions appear in Summary |
| Host badges and participation | `enabled` comes from `kit.json` (`src/lib/host-readiness.mjs:102`). The hint is `ak host pick`. Alignment reads user files | `enabled` comes from `project.json` and `local.json`. The hint is `ak init`. Codex register entries become project rows. Native probes stay read-only |
| Ruflo components | `kit.json` intent, the global version, one machine evidence file, and a dry run against `~/.claude/settings.json` | Intent from `project.json`, version from pin plus cache, evidence in project state, a dry run against `settings.local.json`. The funnel card explains that the setting is account-wide |
| Intelligence | Census-wide rollup; the selection defaults to the most recently active project; writes health history (see principle 2) | Keep the rollup, labelling rows as opted in or not. Default the selection to the current project when it is opted in. `improvement` follows the selection |
| Models | Store and key in `~/.config/agentic-kit` (`src/lib/model-inventory/store.mjs:13-14`) | Cache. Routes from `project.json` |
| Refresh | `local` and `live` read `kit.json` and write user-level evidence. Live checks run `ruflo` in temp folders, so upstream state lands in `~/.claude-flow` | Takes a project and writes evidence to project state. Live checks run with a sandboxed `HOME`. The deja-vu check is removed. Machine, maintenance and inventory snapshots persist in the cache |

### System

| Panel | Today | Change |
| --- | --- | --- |
| Install footprint | Rows for npm-global Ruflo, AQE and agent-browser, a deja-vu row, host CLIs as npm globals, the Brain at the installer path (`src/lib/footprint/install.mjs:193-242`) | One row per cached `<pkg>@<version>`: bytes, native addons, `pinnedBy`, last used, prunable. A user's own global Ruflo or AQE shows as user-owned. Host CLIs become prerequisites. Brain row reads the cache path. Duplicate natives are grouped across cached versions. KPI reads "tool cache · N versions · M pinned" |
| Runtime | Machine-wide `ps` sweep, which also writes evidence | Read-only. Processes and daemons are tagged by opted-in project, and "stale" counts only opted-in projects |
| Storage | An `ak-config` root; learning stores scanned in every census project | Add an `ak-cache` root (tools, brain, derived data) and a per-project `.agentic-kit/state/` node. Split learning stores into opted-in and seen-only. Show `~/.claude-flow` as upstream-owned. Old config files show as an older installation |
| Storage reclaim (advisory) | The npx "version-stale" reason compares against global installs, with an `ak sync` hint (`src/lib/footprint/storage-reclaim.mjs:242-257`) | Add a "tool cache: versions no project pins, unused for 30 days" candidate, which `ak sync` prunes. Rebase the Brain and browser detectors onto the cache. Drop the npx global-baseline reason |
| Largest consumers | No `~/.cache/agentic-kit` row | Add `ak-cache` with breakdowns. Mark the old config folder as an older installation |
| Catalog | Does not see local-scope MCP, `.opencode/opencode.json`, `.claude/rules` or `settings.local.json` hooks. Expects user guidance blocks | Add those surfaces, a `local` scope, and a `user-exception` scope for register keys. Owner comes from project receipts. Expected user blocks become zero. Skill pressure defaults to opted-in projects |
| Projects | Only measures repositories with an HTTPS remote and a recorded session (`src/lib/footprint/projects.mjs:741-773`) | Always measure opted-in projects. Columns for mode, `kitVersion`, components and pins. KPI reads "N opted in · M seen". Reuse the unused `project-group-controls.mjs` as an opted-in, seen-only or all filter. Add `.agentic-kit` to `EXCLUDED_DIRS` in `stack-detect.mjs` |
| Snapshot file | `~/.config/agentic-kit/footprint-snapshot.json` (`src/lib/footprint/snapshot.mjs:47-49`) | Cache |

### Maintenance

Most of what Maintenance can change today is user-level. Inventory and Discovery are reads, so they
stay, and user placements are labelled "Yours: ak reads, never changes".

- **Writes only inside opted-in roots.** Add a precondition in `coordinator.mjs` before
  `provider.apply` and `provider.undo`. It refuses `OUT_OF_SCOPE_WRITE` unless the target resolves
  inside a root that has `.agentic-kit/project.json`. Do the same in the hook-remediation planner
  (`src/lib/hook-remediation/planner.mjs:423`).
- **Become read-only advice the user runs.** Each of these becomes a copy-only "you run this" step
  using the existing procedure renderer:
  - `claude-plugin` at user scope;
  - `codex-plugin` and `codex-mcp`;
  - `host-alignment` edits to `~/.claude.json`;
  - npx cache cleaning and `ollama rm`;
  - terminating orphan processes outside opted-in projects;
  - `owned-skill` at user scope;
  - the hook-heal SessionEnd clamps on user files, and the Codex companion-plugin disable.

  In `provider-registry.mjs`, declare them with `operations: []`, as the unsupported entries already
  are.
- **Remain, gated to opted-in roots:** `git-project-patch`, project and local `claude-plugin`,
  project `owned-skill`, realigning project `.mcp.json` and `.codex/config.toml`, and project
  hook-heal actions.
- **Codex user file.** Changes only through the register's capability. The recursive
  `codex mcp-server` matcher (`src/lib/host-alignment.mjs:32`) becomes the register's repair matcher,
  and it must prove ak wrote or caused the entry.
- **Fix the hook scope.** The projection hard-codes hooks as `'user'` even when they come from a
  project (`src/lib/maintenance/management/projection.mjs:427,444`).
- **Guidance lanes.** Recipes for ak-managed tools emit `ak sync --upgrade`, not `npm -g`. Third-party
  tools keep copy-only advice. The context audit targets the project rule, and detects Superpowers
  from project evidence.
- **Where state lives.**
  - Project state: receipts, transactions, plans, locks, patch preimages, project-skill archives and
    hook-healing receipts.
  - Cache: scans, inventory snapshots, locators, history, checkpoints and discovery snapshots.
  - Discovery intent leaves `kit.json`: opt-in replaces `exactProjects`, and roots, exclusions and
    source toggles become cache preferences.
  - Route the direct `fs` writes (`transaction-store`, `plan-store`, `mutation-lock`,
    `git-project-patch`, `owned-skill`, `hook-remediation/fs-port`) through the write gate.

### Usage, Observability and telemetry

| Panel | Today | Change |
| --- | --- | --- |
| Scorecard, Limits, Prompts, Models | Whole account; `handleUsage` takes only `days` | Stays account-wide by default, because spend and limits are. Add `scope=all\|opted-in` to `handleUsage`, `scanKey` and `aggregate`, and a strip reading "opted-in: N projects, X% of spend". Limits: classify each opted-in project's statusLine, and report a kit footer still at user level as an older installation. Extra hosts come from `local.json` |
| Tool mix | Raw MCP names | Keep `claude-flow` as the server name so history doesn't split. Add a server-to-family tag (ruflo, aqe, brain, and deja-vu as retired) through `classifyToolName` (`src/lib/live/tool-classify.mjs:5`) |
| Projects | Top Git repositories by spend | Opted-in badge and filter. Opt-in status is read once per root at index read time and passed into `aggregate`, never stored in the parse cache, because a project can opt in after its transcripts were indexed |
| Context and the context-tax finding | Advice points at user-level guidance blocks. Claude window size is measured only where the footer runs | Default to opted-in projects, with an "all sessions" toggle, and say that Claude pressure is measured only where the footer runs. Split the context-tax finding into opted-in and not. Advice points at the project rule, skills and `ak audit context` |
| `ak audit context` | Reads machine guidance files, top-level `mcpServers` in `~/.claude.json`, and the Superpowers plugin cache (`src/lib/context-audit-sources.mjs:216-275`) | Project rule target (about 1.5 KB budget), frontmatter of ak's own skills, local-scope, `.mcp.json` and project Codex MCP reported by scope, and project Superpowers evidence. Machine blocks show as an older installation |
| Observability | Reads every transcript. Workspace store in `~/.config/agentic-kit` | Reads stay. Workspace store moves to the cache. `resolveProjectIdentity` gets an `optedIn` flag for a badge and filter (`src/lib/live/project-label.mjs:70-93`) |
| Telemetry | Contract v1 fixes `selection.scope`. Inventory and maintenance come from user-level stores. Identity sits next to `kit.json` | Contract v2: `selection.scope` is `all\|opted-in`; optional per-session `akScope`; inventory and maintenance come from project state or read `unavailable`. Identity moves to the cache |
| Admin | npm download trends include automatic self-update installs | Annotate the release on the sparkline. The trend breaks there, because there are no more self-update installs and `npx … init` runs count instead |
| Derived state | `usage-index.json`, `observability-workspaces.json`, `claude-context-windows/`, rate-limit files, `openrouter-activity.json` and host-setup evidence live under `~/.config` or `~/.local/state` | All move to the cache, with a one-release read fallback from the old paths. The statusline footer reads the Brain version from the cache, not `kit.json` |

### Proof that ak stays out of other projects

Add a **Footprint** card under Usage → Context. It gives the user evidence of what this design
promises.

- **Per-session field.** Each session gets a cached `akFootprint` field: MCP calls per ak family,
  `ak-*` and Ruflo skill uses, and kit-owned hook attachments. This bumps the index `SCHEMA_VERSION`
  from 26 to 27 (`src/lib/usage-index.mjs:198`).
- **Hook attachments.** These need `attachment` and `system` records to be parsed. They are ignored
  today (`src/lib/usage-parsers.mjs:799-801`).
- **The comparison.** Split sessions into opted-in and not, and into before and after the switch,
  dated by the opt-in receipt.
- **Expected result.** Projects that haven't opted in show zero ak calls, skills and hooks after the
  switch, and a lower median first-turn input and cache write for the same host and model family.

## Upgrading from the user-level versions

There is no migration code. Existing users remove the old installation with the old tool, then opt
projects in with the new one.

### The exit release

The current line gets one final release (the next `4.0.0-alpha`), published **before** the new line.
It makes `ak uninstall --purge` remove everything that line ever placed. Today it leaves gaps,
which this release closes:

| Gap today | Exit release |
| --- | --- |
| Codex `ruflo` MCP entry and the other host wiring are undone only by `ak host off` | `--purge` runs every enabled host's teardown |
| Provider env (`ENABLE_*`, `AQE_LLM_PROVIDER`, `AQE_MAX_BUDGET_USD`) and the AQE router | Removed by ownership receipt |
| AQE embedding settings in user Codex and OpenCode config; the Ollama alias | Removed by receipt; the alias after a confirmation |
| Brain user plugin, shim and LaunchAgent (today only a printed notice) | Removed after a confirmation. The knowledge base is kept by default so the new version can reuse it |
| `~/.local/state/agentic-kit/` and the rest of `~/.config/agentic-kit/` | Removed after teardown succeeds |
| deja-vu | Wiring removed. Package and index each confirmed separately, defaulting to keep |

It ends by printing the new version's opt-in command. A sandboxed-`HOME` regression test proves it:
run setup, then `uninstall --purge`, and `HOME` matches its pre-setup fingerprint apart from data the
user chose to keep.

Order matters. An older prerelease `ak sync` self-updates by following both the `latest` and `next`
tags (`src/lib/versions.mjs:209`). Once the new line is on `next`, an old `ak sync` will install it.
So the exit release ships first, and the instructions always run it by exact version through `npx`,
whatever happens to be installed globally.

### The instructions

These go in the README and `docs/upgrading.md`:

```bash
# 1. Remove the old setup with the exit release (preview first)
npx @pacphi/agentic-kit@<exit-release> uninstall --purge --dry-run
npx @pacphi/agentic-kit@<exit-release> uninstall --purge

# 2. Remove the old global runner, if you installed one
npm uninstall -g @pacphi/agentic-kit

# 3. Opt in each project you want
cd my-project
npx @pacphi/agentic-kit@next init
```

To keep using deja-vu on its own, answer "keep" to its prompts in step 1, then run
`deja install <host>` yourself.

### The new version's single check

The new version contains one legacy check and nothing else. It looks for an old installation:

- `~/.config/agentic-kit/kit.json`;
- `~/.local/state/agentic-kit/`; or
- a user-scope `claude-flow` entry in `~/.claude.json`.

If it finds one, `init` and `sync` stop and print the three steps above, and `status` and the
dashboard show one "Older installation" row with the same steps. Projects the old version set up
need nothing special, because `init` uses existing setups instead of duplicating them.

## Making it stick

1. **Write gate.**
   - `file-write.mjs` allows only paths inside the project root and the cache, plus the Codex
     register through its capability. Anything else throws `OutOfScopeWrite`.
   - A lint rule bans direct `fs` writes and the `claudeDir`/`codexDir`/`opencodeDir` helpers in
     writer modules.
2. **Command gate.**
   - The exec wrapper refuses `npm install -g`, `claude mcp add -s user`, `codex mcp add`,
     `launchctl` and similar commands.
   - It allows `claude mcp|plugin … -s local|project` only when the working directory is an
     opted-in root.
3. **Contract tests.**
   - `init`, `sync`, `sync --upgrade` and `uninstall` run for every host and component
     combination under `sandboxHome()`. Afterwards `HOME` must be byte-identical except for the
     cache, `projects["<root>"].mcpServers` in `~/.claude.json`, and the register's keys in
     `~/.codex/config.toml`.
   - A second test serves every dashboard GET and SSE route from a folder that has not opted in,
     and asserts that nothing outside the cache changed.
4. **Upstream watch.** Staged initializers and sandboxed live checks report user-level writes made
   by upstream tools, and each one becomes an upstream thread.

## Phasing

Every phase updates the dashboard panels and docs it affects. P6 holds the cross-cutting
dashboard work.

| Phase | Lands |
| --- | --- |
| P0 | The exit release on the current line: a complete `uninstall --purge` and its regression test. Then, on the new line: remove deja-vu, the ADR, the write gate in report-only mode, and contract tests recording today's violations as the baseline |
| P1 | The `.agentic-kit/` layout and `ak init` in personal mode for Claude: rules, skills, `settings.local.json`, local-scope MCP launchers. Staged initializers that use existing setups. The legacy check. User-level guidance writes stop |
| P2 | Tool cache and launchers. Global npm installs, self-update and host-CLI installs removed. Daemon handling scoped to the project |
| P3 | Codex project settings and the exception register; OpenCode project settings; write scopes for external adapters |
| P4 | Brain knowledge-base-only mode, agent-browser, embeddings consent, Superpowers evidence. Upstream requests filed |
| P5 | `sync`, `status` and `uninstall` on project state; team mode; the command removals and folds |
| P6 | Dashboard: the project selector, read-only views, the `optedIn` census scope, the System, Maintenance and Usage changes, telemetry v2, and the Footprint card |
| P7 | Write gate enforcing; the machine-reconciliation code paths deleted |

## Trade-offs

- **Disk.** The shared cache keeps disk use close to today's. `tools: "project"` adds roughly 400 MB
  per project, which is why it isn't the default.
- **Host prompts.** In personal mode Claude asks nothing. Codex still asks once per hook, because
  `trusted_hash` stays Codex's consent. A team-mode `.mcp.json` gets Claude's one-time approval.
- **The Codex exception is real user-level state.** It is narrow, coded, disclosed,
  reference-counted and reversible.
- **Upgrading costs the user one manual sequence.** In exchange there is no migration code to
  maintain. The exit release makes that sequence complete, and the new version points to it.
- **Usage scope differs by panel.** Spend and limits stay account-wide, while Context and Footprint
  default to opted-in projects. Each panel says which scope it shows.
- **Upstream behaviour ak can't control.** Ruflo's `~/.claude-flow/` and upstream installers may
  still write user-level state. Staging and sandboxed live checks contain that during ak's own runs.

## Follow-ups to verify during implementation

- Whether the current Codex release honours `tui.status_line` and `model_context_window` in a
  trusted project config. Any key it honours leaves the register.
- Whether agent-browser accepts a browser install location, and whether Ruflo accepts a
  project-local home for its `~/.claude-flow/` state.
- Whether the Brain installer has, or will accept, a knowledge-base-only mode.
- Whether `claude plugin` operations at `local` or `project` scope leave
  `~/.claude/plugins/installed_plugins.json` untouched.
