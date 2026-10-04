# Project-scoped management only

## Status

**Direction accepted** (2026-10-01). The maintainer's decisions are recorded under
[Decisions](#decisions). Nothing is implemented yet.

**Amended 2026-10-03:** one `managed-tools` skill replaces the per-tool on-demand skills; the
token-audit skill leaves the product; `sync --all --upgrade` is defined under Sync. Decision G17 in
the master plan.

The next step is the three [prerequisites](#prerequisites), which land on `main` first. P0
follows: the exit release on the current line, then the removal of deja-vu.

This plan becomes an ADR that supersedes:

- ADR-0035 in full (deja-vu);
- the user-level parts of ADR-0008, ADR-0015, ADR-0017 and ADR-0058 §3.

ADR-0029 and ADR-0031 (external host adapters) are withdrawn from v4 and carried to v5, not
superseded. See [Setting host adapters aside for v5](#setting-host-adapters-aside-for-v5).

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

The dashboard observes all agent work on the machine: every session on every host it can read,
in git repositories and anywhere else on the filesystem. It reports what ak manages place by
place. Viewing the dashboard writes nothing outside the kit's cache. The user never has to finish
a setup by hand.

## The rule

**The blast radius of every `ak` command is the opted-in project.**

Judge by effect, not just by where a file sits. Only four kinds of write are allowed:

1. **Inside the project root.** By default this goes into a git-ignored layer.
2. **A kit-owned cache that does nothing on its own.** It lives under
   `$XDG_CACHE_HOME/agentic-kit/` (`%LOCALAPPDATA%\agentic-kit\cache` on Windows) and holds versioned tool
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
| 9 | What the dashboard covers | **All work, every host, every place.** Observation covers every readable host and every folder where sessions ran, git repository or not. Management stays opt-in per project. The dashboard launches anywhere and defaults to all work. See [Dashboard and metrics](#dashboard-and-metrics). |
| 10 | External host adapters and Hermes | **Retired from v4 and set aside for v5.** v5 plans full support for Grok, Gemini, Hermes, OpenCode, Claude (Code, claude.ai, Desktop) and ChatGPT/Codex as first-class hosts, so a plug-in adapter contract doesn't carry forward. The work is tagged and registered, not discarded. See [Setting host adapters aside for v5](#setting-host-adapters-aside-for-v5). |
| 11 | `ak x harvest` | **Removed.** Ruflo's own hooks already record task outcomes, and Ruflo's daemon schedules distillation. The `managed-tools` skill's Ruflo reference documents the two Ruflo commands for anyone who wants to run them by hand. |

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
| Claude guidance | Up to about 10.5 KB of blocks in `~/.claude/CLAUDE.md`, loaded in **every** Claude session (`src/lib/blocks.mjs:48-175,489`) | About 1.5 KB always-on in opted-in projects, plus one on-demand skill (`managed-tools`) |
| Codex and OpenCode guidance | `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md` | The `managed-tools` project skill, OpenCode `instructions`, and a project `AGENTS.md` block where allowed |
| Ruflo MCP | `claude mcp add -s user`; `codex mcp add` into the user config (`src/lib/mcp.mjs:176`, `src/lib/providers.mjs:846`) | Claude local scope; project `.codex/config.toml`; project `.opencode/` |
| AQE's Claude MCP entry | Written into `.mcp.json` by `aqe init` | A Claude local-scope registration in personal mode |
| Component, provider and AQE budget env | `~/.claude/settings.json` `env`, falling back to user settings outside a repo (`src/lib/claude-env-projection.mjs:12`, `src/lib/providers.mjs:469`) | `.claude/settings.local.json` only, with no fallback |
| Tool-family deny rules | `~/.claude/settings.json` `permissions.deny` (`src/lib/mcp.mjs:662`) | `.claude/settings.local.json` |
| Token-audit skill | Copied into `~/.claude/skills/` on every setup, and scans all projects (`src/commands/setup.mjs:370`) | Not a product skill. It becomes a maintainer-only skill of this repository, and `ak init` never writes it |
| Superpowers guidance | Added to `~/.claude/CLAUDE.md` whenever the plugin is cached (`src/lib/blocks.mjs:114-128`) | Added only to projects with evidence of Superpowers use |
| OpenCode wiring | User `opencode.json`, plugins, agents, skills and wildcard approvals (`src/lib/opencode-core.mjs:631-722`) | Project `.opencode/`; approvals apply to that project only |
| RuvNet Brain | A user-scope Claude plugin whose hooks, including a write gate, run in every session (`src/lib/brain-hook-contract.mjs:11-27`) | Knowledge base in the cache; `search_ruvnet` MCP per project; hooks only by per-project opt-in |
| Codex status line, context window, trust | `~/.codex/config.toml`; trust is left to the user (`src/lib/codex-statusline.mjs:157`, `src/lib/codex-context.mjs:86`) | Codex exception register |
| User-level MCP repairs and host alignment | Edit `~/.codex/config.toml` and `~/.claude.json` (`src/lib/codex-mcp-reconcile.mjs`, `src/lib/host-alignment.mjs`) | Codex: register entries only, for entries ak owns or caused. Claude: none |
| AQE embeddings | Pulls `all-minilm` into Ollama's store and aliases it (`src/lib/aqe-embedding-lifecycle.mjs:54-69`) | Default `unmanaged`; the pull and the alias each need their own yes |
| agent-browser | `~/.config/agentic-kit/agent-browser.json`; Chrome for Testing in `~/.agent-browser/` | Config in project state; a system Chrome first, otherwise the cache |
| deja-vu | Global install, user-level host wiring, plaintext index | Removed |
| External host adapters | An experimental contract behind `AK_EXPERIMENTAL_HOST_ADAPTERS=1`: trust, conformance and grants, adapter routing in `ak run`, and an AQE provider bridge. Consent and grants live in `~/.config/agentic-kit` (`src/lib/adapters/consent.mjs:14`, `src/lib/adapters/grants.mjs:55`) | Retired from v4; set aside for v5 |
| Learning write | `ak x harvest`, opted in through `kit.json` (`src/commands/x/harvest.mjs`) | Removed; Ruflo's hooks record outcomes |
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
  `~/.config/ruflo/ruflo-reference-full.md`, which nothing deploys any more. Fixed by
  [Prerequisite A](2026-10-01-prereq-ruflo-reference-pointer.md).
- **Forced initialization in the user's tree.** Project setup runs `ruflo init --full --force`
  directly in the project. That can drop the user's own MCP entries and regenerate their
  settings. [Staging](#upstream-initializers-are-staged-never-forced) fixes this.

## Prerequisites

The dashboard review found three defects on the current line. They are bugs today, whatever
happens to this design, and later phases build on them being fixed. Each has its own write-up.
They land on `main` before P0, so they also ship in the exit release and carry over to the new
line.

| | Write-up | What it fixes | Why the design needs it |
| --- | --- | --- | --- |
| A | [Remove the dangling full Ruflo reference pointer](2026-10-01-prereq-ruflo-reference-pointer.md) | Every Claude session on an installed machine is pointed at a file the kit never installs | The Ruflo reference (`ruflo.md`) of the `managed-tools` skill later takes this content over; until then the current line should not mislead agents |
| B | [Stop the Intelligence view writing into projects](2026-10-01-prereq-intelligence-no-project-writes.md) | Opening Overview → Intelligence appends `.claude-flow/health-history.json` in whichever project is selected, including the home folder | Establishes dashboard principle 2 (viewing writes only to the cache) and introduces `paths.cacheDir()`, the cache folder the whole design uses |
| C | [Give hooks their real scope in the Maintenance inventory](2026-10-01-prereq-maintenance-hook-scope.md) | Every hook is labelled user-level, and hooks never reach the production Inventory at all | The Maintenance write precondition and the "Yours: ak reads, never changes" labelling both depend on true scope and project |

None of them depends on the others, so they can land in any order or in parallel.

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
| `host`, `host status` | The Hosts section of `status` |
| `host pick --primary-host`, `--aqe-provider`, `--aqe-fallback`, `--provider` | Choices in `init`, saved to `local.json` |
| `host adapters` (list, trust, revoke, conformance, grant, gate, status, revoke-grant), `x aqe-provider` | Retired from v4 and set aside for v5. See [Setting host adapters aside for v5](#setting-host-adapters-aside-for-v5) |
| `x harvest`, and the `harvest` live check | Removed. The `managed-tools` skill's Ruflo reference documents `ruflo hooks post-task` and `ruflo memory distill run`. The `learning` live check stays |
| `x aqe-store` | A `maintain` action with an undo receipt. It still refuses while any AQE writer is open, and it is never a `sync` step (decision B5-D2) |
| `x skills plan` | A read-only finding in `maintain` |

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

Plan: 8 files, 0 tracked files modified
  + .agentic-kit/project.json, local.json          new, ignored
  + .claude/settings.local.json                    merge: env 4, hooks 3 (yours kept)
  + .claude/rules/agentic-kit.md                   new, ignored (1.6 KB always-on,
                                                   includes Superpowers notes)
  + .claude/skills/managed-tools/                  new, ignored (load on demand)
  + Claude MCP (this project only)                 claude-flow, agentic-qe via
                                                   `claude mcp add -s local` (.mcp.json untouched)
  + .codex/config.toml                             new, ignored
  + .agents/skills/managed-tools/                  new, ignored
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
  local.json          personal choices: hosts you use, the primary host, AQE and Ruflo
                      providers, budgets, remembered approvals, project-tied dispositions.
                      Always ignored.
  bin/                generated launchers (ruflo-mcp, aqe-mcp, brain-mcp)
  guidance/           rendered guidance sources that host files import or reference
  state/              receipts, project evidence, health history, snapshots, maintenance
                      transactions and plans, references held on Codex exceptions.
                      Always ignored.
```

- `kit.json` retires. Its per-project receipts, today keyed by absolute root inside a user file,
  move into each project's `state/`.
- `ak sync --all` and the dashboard find opted-in projects through a rebuildable project index in
  the cache and the `optedIn` census scope (see
  [Finding every managed project](#finding-every-managed-project)). The marker in the project is
  the only authority; there is no registry that must be kept in step.
- `state/status.json` holds the project's latest status snapshot, which the dashboard aggregates.
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
| On-demand guidance | `.claude/skills/managed-tools/` | `.agents/skills/managed-tools/` | `.opencode/skills/managed-tools/` |
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
- **Every host.** Registry validation rejects `scope: 'user'` trust changes
  (`src/lib/adapters/registries.mjs:206-266`).
- **Hermes and other hosts.** v4 supports Claude Code, Codex and OpenCode. The external adapter
  contract is set aside for v5, as the next section describes.

### Setting host adapters aside for v5

v5 plans full support for Grok, Gemini, Hermes, OpenCode, Claude (Code, claude.ai, Desktop) and
ChatGPT/Codex as first-class hosts. A plug-in adapter contract doesn't fit that. Porting it to
project scope would mean moving its consent and grant stores out of `~/.config/agentic-kit`,
giving adapters write scopes, and adding adapter session sources: work that v5 replaces. So v4
retires the contract instead, and keeps the work for v5 to refactor.

- **What goes, in P0 alongside deja-vu:**
  - `ak host adapters` and the `AK_EXPERIMENTAL_HOST_ADAPTERS` flag;
  - adapter routing in `ak run` (`src/lib/execution/adapters.mjs`, `src/lib/execution/admitted.mjs`);
  - the hidden `ak x aqe-provider` bridge, through which Agentic QE could use an adapter as its
    model provider;
  - the admission, admitted, consent, conformance, grants, hook-runner, integrity, manifest, source
    and AQE-provider modules in `src/lib/adapters/`, and the external hook-audit provider. With the
    two command files that is about 5,700 lines in 16 files, plus about 15 test files;
  - external entries in the lifecycle registry;
  - `docs/hermes-host-adapter.md`, `docs/authoring-host-adapters.md` and
    `docs/host-adapter-freeze-checklist.md`.
- **What stays:** the host registry, bindings, lifecycle for the built-in hosts, and the other
  `src/lib/adapters/` modules the built-in hosts use. The read-only Maintenance discovery source
  for Hermes configuration also stays.
- **How the work is kept:**
  - An annotated tag, `archive/v4-host-adapters`, marks the last `main` commit that has the code,
    before the removal lands. Release builds start only from `v*` tags, so the tag starts none.
  - `docs/proposals/v5-planning-sources.md` lists every file, ADR, doc and test it covers.
  - ADR-0029 and ADR-0031 are marked "Withdrawn from v4; carried to v5".
  - A v5.0.0 card reimagines host support for the named hosts, starting from the tag.
- **Existing users.** The exit release still carries the contract, and its purge cleans up after
  it (see [The exit release](#the-exit-release)). Anyone who depends on the Hermes adapter can stay
  on the exit release until v5. The community adapter's maintainer
  (`adrianco/ak-adapter-hermes`) gets a heads-up, posted only after the maintainer approves the
  text.
- **Unsupported hosts are still seen.** The [coverage card](#every-host) lists Hermes, Gemini CLI
  and other known hosts when they are installed, as "sessions not read; support planned for v5".

## Codex exception register

Codex keeps some behaviour only in `~/.codex/config.toml`. Leaving it to the user would mean
manual steps, so ak manages it as a declared exception. The register is a constant in code (for
example `CODEX_USER_EXCEPTIONS`). It is never read from configuration, and nothing can extend
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
- **Docs.** `docs/archive/2026-10-03-guide-deja-vu.md` and ADR-0035 move to `docs/archive/`, with ADR-0035 marked
  superseded. The guides lose their deja-vu sections.
- **Usage history.** No Usage or telemetry code names deja-vu. Old `mcp__deja-vu__*` rows age out of
  the window, and the tool-family map tags them "retired".
- **Existing users.** The exit release removes it (see below).

## Guidance and templates

Each topic has one source in `claude/` and a small renderer for each host. That removes the
duplication at its source instead of sharing one user-level file.

**Always-on** (budget 1.5 KB): condensed safety and verification rules from `ruflo-preamble.md`,
what this project has enabled and when to open the `managed-tools` skill, and the Superpowers
notes when the project qualifies.

**On-demand skill**, which costs nothing until used. There is one product skill, `managed-tools`.
`ak init` writes it only into an opted-in project, ignored like every other generated file, at
`.claude/skills/managed-tools/` and `.agents/skills/managed-tools/` (and
`.opencode/skills/managed-tools/` where OpenCode applies). It holds:

- `SKILL.md`: what this project has enabled and which reference to read for each component.
- One reference file per enabled component. A component that is not enabled gets no file:

  | Reference | Source |
  | --- | --- |
  | `ruflo.md` | `ruflo-reference.md`, with the 439-line `ruflo-reference-full.md` as its reference file. This also gives the full reference a real home; [prerequisite A](#prerequisites) only stops the current line pointing at a missing file. P1-03 decides the file name and placement of the full reference. |
  | `aqe.md` | `aqe-reference.md` |
  | `brain.md` | `ruvnet-brain-reference.md` |
  | `hosts.md` | `providers-reference.md`, `dual-mode-reference.md` and `ruflo-opencode-reference.md`, only where they apply |

- Implementation note for P1-03: content that a tool already injects itself is left out of the
  reference files. That covers the Brain plugin's hook, AQE's own `AGENTS.md` section and Ruflo's
  `CLAUDE.md` block.

Two rules keep the skill namespace clean:

- The `ak-` skill namespace in `.claude/skills/` belongs to this repository's authored maintainer
  skills, tracked by name (see [Maintainer skills](../maintainer.md#maintainer-skills)). `ak init`
  never writes an `ak-*` skill.
- The token-audit skill is not a product skill. It becomes a maintainer-only skill of this
  repository, in a separate change.

Personal facts are never committed (ADR-0008's principle). That covers dual-host mode, provider
bindings and Superpowers use. Today an installed machine pays about 10.5 KB in every Claude
session, in every folder. Afterwards, a folder that hasn't opted in pays nothing, and an opted-in
project pays about 1.5 KB, plus the `managed-tools` skill's description.

## Sync, status, uninstall

**`ak sync`**

- Reads `project.json` and `local.json`.
- Makes sure the pinned tools are in the cache, and prunes it.
- Re-renders projections whose receipts show they are unchanged. Edited files are reported instead
  of overwritten.
- Re-checks this project's Codex exception entries.
- Verifies, then appends health history to `state/` and writes the status snapshot
  `state/status.json`.
- Adds the project to the cache's project index, if it is missing.

It never self-updates and never touches another project. `--upgrade` is the only thing that moves
pins. In team mode it leaves `project.json` modified for the user to commit.

**`ak sync --all --upgrade [name[@version]]`** composes the two flags. Applying its plan is `ak sync`
running in each opted-in project in turn, so no pin moves any other way. The semantics are:

- It shows one per-project plan: which pins move, from what to what.
- It takes one yes.
- It then moves the named pin in every opted-in project. With no name, it moves every pin to the
  newest version inside its support window.
- `--dry-run` prints the plan and stops.
- A failure in one project is reported and the batch continues.
- The report lists the projects moved, left and failed.

Pins stay pinned-only in 4.x: nothing floats. A floating policy is the v5 decision X1. The
[estate convergence design](2026-10-03-estate-convergence-design.md) (P5-02) uses the same wording.

**`ak status`** has three sections:

- **This project:** today's project rows, plus the Codex exception entries.
- **Prerequisites:** read-only checks for node, git, the host CLIs, Ollama and Chrome.
- **Older installation:** a single row, shown only when an older agentic-kit is detected (see
  [The new version's single check](#the-new-versions-single-check)).

In an opted-in project, `ak status` also refreshes `state/status.json`, so the dashboard's
aggregates stay current without the dashboard re-running anything.

**`ak uninstall`**

- Removes receipted files that are unchanged, and restores edited ones from the pre-init snapshot.
- Removes the local-scope MCP names ak added, drops this project's Codex references, removes the ak
  block from `.git/info/exclude`, and stops this project's daemon.
- Removes the project from the cache's project index.
- Asks before removing data in `.swarm/` and `.agentic-qe/`; the default is to keep it.
- Removing everything (`rm -rf ~/.cache/agentic-kit`) is always safe.

## Dashboard and metrics

The dashboard is where a user sees all the agent work done on their machine. It shows which of
those places agentic-kit manages, and how each one is doing.

- **Launch anywhere.** It starts from any folder: `ak dashboard`, or
  `npx @pacphi/agentic-kit dashboard` with nothing installed.
- **Every host.** It reads sessions from every host it can read, whether or not ak manages that
  host anywhere.
- **Every place.** It covers work in git repositories and everywhere else on the filesystem.
- **Managed status.** It finds every managed project and shows its health.
- **Totals and one place.** It shows totals across all of that, and narrows any view to a single
  place.

**Observation and management are separate.** Management stays opt-in per project, as the rest of
this design describes. Observation is reading, so the rule allows it everywhere: every session on
every readable host, in every folder.

Today the dashboard assumes one machine-wide installation. It also breaks work down only by git
repository. Four reviews (About and Overview, System, Maintenance, Usage and Observability) found
the principles and per-area changes below.

### Principles

1. **Launch anywhere; one scope filter for the whole dashboard.** A header filter has three
   levels, plus a host facet:

   | Level | Shows | When it is selected |
   | --- | --- | --- |
   | **All work** | Everything: every session on every readable host, in every [place](#every-place-work-happens) | **The default** |
   | **Managed projects** | Only places that have opted in | Chosen from the filter or the work view |
   | **One place** | Everything narrowed to one repository, folder or grouped place | Preselected when the dashboard is launched inside a known place; otherwise chosen from the work view or the filter |

   The **host facet** (All hosts, Claude Code, Codex, OpenCode) narrows any level to one host.

   How the levels apply to panels:
   - Launching outside any project (in the home folder, say) is not a reduced mode. It opens on
     All work.
   - Every panel declares which levels it supports. Some panels only exist for managed projects:
     status, versions, Codex exceptions and managed files. At **All work** those panels show the
     managed projects and say so. A panel with nothing to show at the selected level gives a
     one-line note instead of an empty card.
   - Activity figures show the managed share beside the total, for example "managed projects: $41
     of $63 this week".
   - **Plan limits are always account-wide**, whatever the filter, and are labelled that way.

   How it is built:
   - The filter is the `?project=` key the server already understands, reusing
     `resolveSelectedProject` and `keyForProject` (`src/lib/dashboard-server.mjs:206-238`), plus
     two reserved values for the aggregate levels.
   - It drives every reader: status rows, host health, Ruflo components, Intelligence,
     improvement, Usage, Observability, System and Maintenance.
   - Today only some readers follow the launch folder (`cachedHostFacts` ignores it,
     `src/lib/dashboard-server.mjs:491`), and Intelligence deliberately has no current project.
2. **Viewing never writes outside the cache.** Today:
   - a GET of `/api/status` writes `kit.json` version checks (`src/lib/versions.mjs:85,184`) and
     evidence files (`src/commands/status.mjs:155`, `src/lib/dashboard-server.mjs:486-494`);
   - the cheap System read writes `daemon-sweep` evidence about every minute
     (`src/lib/footprint/runtime.mjs:97-99`, `src/lib/daemons.mjs:98-102`);
   - the Intelligence stream appends `.claude-flow/health-history.json` in **any** selected
     project, including `$HOME` (`src/lib/live/intelligence-watch.mjs:203-207`). This one is
     fixed first, by [Prerequisite B](2026-10-01-prereq-intelligence-no-project-writes.md).

   Afterwards, version checks and evidence go to the cache. Reads that only need fresh data pass
   `record:false`. The Intelligence sparkline ring stays in the cache, keyed by project, for any
   census project, because it is derived observation data (Prerequisite B puts it there).
   `ak sync`'s own health history is a different record: it goes to `.agentic-kit/state/`, and
   only for opted-in projects.
3. **"Opted in" is a census scope.**
   - Add `optedIn` next to `learning` in `src/lib/project-census.mjs:59`. It is a project-level,
     identity-merged scope. Each row reads a capped `<repository root>/.agentic-kit/project.json`.
     An unreadable marker is `unknown`, never `false` (ADR-0023).
   - Add a derived `seenOnly` scope.
   - Discovery is described in [Finding every managed project](#finding-every-managed-project).
   - `sync --all`, cache pruning and every project filter below use this scope.
4. **Aggregates come from what each project recorded.** The dashboard never re-runs status for
   every project when it opens.
   - Each opted-in project keeps its latest status snapshot in `.agentic-kit/state/status.json`.
     The snapshot holds the rows, the verdict, the pinned and cached versions, the `kitVersion` and
     the time it was collected. `ak status` and `ak sync` write it in that project.
   - Aggregates read those snapshots and show each one's age.
   - **Refresh this project** re-collects one project, which is an explicit action. **Refresh all**
     works through the managed projects two at a time.
   - Both refreshes write only that project's ignored state and the cache. That is allowed,
     because the project opted in and the user asked.

### Finding every managed project

The marker `.agentic-kit/project.json` is the authority: a folder is managed if and only if it has
one. Finding the markers uses these sources, from most to least reliable:

1. **A project index in the cache** (`cacheDir()/projects.json`).
   - `ak init` and `ak sync` add the project root, and `ak uninstall` removes it.
   - It is a hint, not a registry. The dashboard checks each listed root's marker on every read.
     A root whose marker is gone shows as "moved or deleted", with a **Forget** button that edits
     only the index.
   - Because the index is cache data, deleting it is safe. It is rebuilt from the sources below and
     from the next `ak sync` in each project, and the dashboard says when it was rebuilt.
   - A project opted in a minute ago appears straight away, before any agent session has run in it.
2. **The transcript census** (ADR-0027). It catches projects whose index entry is missing.
   - It also finds team-mode projects. A teammate's clone carries a committed `project.json`, so it
     appears as "team project, not set up on this machine", with `ak sync` as the next step.
3. **Read-only host records.** Project keys in `~/.claude.json` that hold ak local-scope entries,
   and the roots listed in the Codex register's sidecar.
4. **Paths given explicitly** with `ak dashboard --project <path>`. These are read only, never
   saved.

**Worktrees** are grouped under their repository (ADR-0050). In personal mode `.agentic-kit/` is
untracked, so each worktree has its own set-up state, and the dashboard shows it per worktree.

### Every host

Today ak reads every Claude Code, Codex and OpenCode session on the account, whether or not any
project enables that host. Reading is not gated on enablement. The census covers exactly those
three hosts (`PROJECT_SOURCE_HOSTS`, `src/lib/footprint/project-sources.mjs:44`). That stays true,
and three additions close the gaps:

1. **`ak run` records what it supervises.** Every worker run is recorded in the cache, on any host:
   host, working folder, start and end, outcome, and the model when known. A host ak drives is then
   counted even if it keeps no readable history of its own.
2. **Hosts ak doesn't support yet are detected, not read.** A read-only check finds Hermes,
   Gemini CLI and other known hosts by their install markers. It never opens their session
   history. Reading them is v5 work (see
   [Setting host adapters aside for v5](#setting-host-adapters-aside-for-v5)).
3. **A coverage card.** It lists the three built-in hosts, plus every other known host that is
   installed. For each, it shows whether the host is installed, whether its sessions can be read,
   and from what date. A host whose history ak cannot read shows as a visible gap, not a silent
   zero.

Hosts ak has no reader for are outside what it can observe. The coverage card says so instead of
guessing.

### Every place work happens

Every session belongs to exactly one **place**. That way the per-place rows always add up to the
account total.

| Place kind | What counts | How it is identified |
| --- | --- | --- |
| **Repository** | A git repository. Worktrees are grouped beneath it, and a session started in a subfolder counts for the repository, with the subfolder kept as detail | Repository identity (ADR-0050) |
| **Folder** | A folder with no git repository above it, such as `~/notes` or `~/Downloads/spike` | Its canonical path. Folders sharing a parent are grouped in the tree |
| **Home** | Sessions started in the home folder itself | One place |
| **Temporary** | Sessions in system temporary folders | One grouped place, because the folders are short-lived |
| **Tool folders** | Sessions started inside `~/.claude`, `~/.codex` or other host and config folders | One grouped place |
| **No longer on disk** | Places whose folder has gone | Kept with their last label, so history and totals stay intact |

**Managed** is an attribute of a repository or a folder, not a kind of place.

- `ak init` works in a plain folder as well as a repository. In a folder there is nothing to
  git-ignore, so the personal files simply live there.
- Home, temporary and tool folders cannot be managed. `ak init` refuses there, as project setup
  does today.

These views count only git repositories today, and change as follows:

| View | Today | Change |
| --- | --- | --- |
| Usage project ranking | Keeps only git repositories and worktrees (`src/lib/usage-project-groups.mjs:61-64`) | Ranks places of every kind |
| System measurement | Covers only repositories with an HTTPS remote (`src/lib/footprint/projects.mjs:741-773`) | Measures managed places, every git repository (local-only ones included), and plain folders on request with the existing bounded walk |
| Census and Intelligence | Group non-git and user-level rows as "other/unclassified" | Use the place kinds above |

Home, temporary and tool folders are never measured as projects, because Storage already measures
them as storage roots. Paths stay on this machine: places are shown by label locally, and
telemetry exports never carry them.

### The work view

This view replaces today's machine-wide Overview Summary as the dashboard's landing page. It answers
two questions together: where agent work is happening, and which of those places ak manages.

At **All work**, it shows:

| Card | Shows |
| --- | --- |
| Activity | Sessions, tokens and spend across every host and place, with the managed share |
| Hosts | Sessions per host, and the coverage card |
| Places | Places with work in the window, by kind; how many are managed (personal and team); team projects not set up on this machine |
| Most active unmanaged places | Where work happens without ak. This is information only: ak never opts a place in by itself |
| Health | Managed projects that are healthy, need attention, or have not been checked for 7 days or more, from the snapshots |
| Needs attention | Every managed project's attention rows in one list, each tagged with its project and the command to run there |
| Versions in use | Each tool's pinned versions and how many projects use each one; projects pinned to an older `kitVersion` |
| Codex exceptions | Register entries in effect and the projects holding each one |
| Cache | Cached tool versions, their size, what `ak sync` would prune, and the Brain knowledge base |
| Learning | Patterns learned, across every place with learning state |
| Footprint | ak tool calls, skills and hooks per place: present in managed projects, and zero everywhere else |

Below the cards is a table with one row per place that had work in the window. It shows the
place's name and kind, the hosts used, sessions, tokens and spend, whether it is managed, and,
for managed places, its health and when it was last checked. Quick filters narrow it to managed,
unmanaged or one kind. Clicking a row narrows the whole dashboard to that place.

**Managed projects** shows the same view, limited to opted-in places.

At **One place**, the view becomes that place's page:

- **For every place:** its activity by host and model, its sessions, its learning, and its ak
  footprint.
- **For a managed place, also:**
  - the full status rows (This project, Prerequisites);
  - its hosts and routes;
  - its pins and whether they are cached;
  - its Codex exception entries;
  - a **Managed files** panel, built from the project's receipts. It lists every file and record
    ak wrote there, and whether each is unchanged or edited since. This answers "what exactly is
    ak doing in this project?"
- **For an unmanaged place:** the `ak init` command to opt it in, where the place kind allows.

The dashboard stays read-only for project files. Running `ak init`, `ak sync` or `ak uninstall`
remains a command, which the view shows ready to copy.

### About and Overview

| Panel | Today | Change |
| --- | --- | --- |
| About cards | Version chips read the npm global root (`src/lib/versions.mjs:9-17`). Host "Managed by ak" comes from `kit.json`. The configured-surface copy describes user-level MCP and guidance (`src/lib/dashboard/about-directory.mjs:278-302`). There is a deja-vu card | Chip shows the pinned version and whether it is cached. Host chip reads "Enabled for this project". Configured cards are rewritten for project scope. The deja-vu card and its join/category keys are removed (`src/lib/dashboard/groups.mjs:46,55`). The update hint becomes `ak sync --upgrade` |
| Summary and subsystem map | Most rows are machine-level: versions, natives, npx, user memory, user MCP, user blocks, daemons, deja-vu, hosts and routing from `kit.json` | Replaced by [the work view](#the-work-view). At **One place**, a managed place shows the sections of `ak status` and its health-history regressions. Routing comes from `project.json` |
| Host badges and participation | `enabled` comes from `kit.json` (`src/lib/host-readiness.mjs:102`). The hint is `ak host pick`. Alignment reads user files | `enabled` comes from `project.json` and `local.json`. The hint is `ak init`. Codex register entries become project rows. Native probes stay read-only |
| Ruflo components | `kit.json` intent, the global version, one machine evidence file, and a dry run against `~/.claude/settings.json` | Intent from `project.json`, version from pin plus cache, evidence in project state, a dry run against `settings.local.json`. The funnel card explains that the setting is account-wide |
| Intelligence | Census-wide rollup; the selection defaults to the most recently active project; writes health history (see principle 2) | Follows the header filter. **All work** shows the rollup over every place with learning state, grouped by place kind. **Managed projects** limits it to opted-in places. **One place** shows the detail. `improvement` follows the selection |
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
| Projects | Only measures repositories with an HTTPS remote and a recorded session (`src/lib/footprint/projects.mjs:741-773`) | Measure managed places and every git repository, local-only ones included. Measure plain folders on request. Columns for kind, managed, mode, `kitVersion`, components and pins. KPI reads "N places · M managed". The table follows the header filter. Reuse the unused `project-group-controls.mjs` for its kind and managed filters. Add `.agentic-kit` to `EXCLUDED_DIRS` in `stack-detect.mjs` |
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
- **Fix the hook scope first.** The projection hard-codes hooks as `'user'` even when they come
  from a project (`src/lib/maintenance/management/projection.mjs:418,427,444`). No production
  caller passes hooks into the inventory at all. [Prerequisite C](2026-10-01-prereq-maintenance-hook-scope.md)
  fixes both before any of the gating above.
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
| Scorecard, Limits, Prompts, Models | Whole account; `handleUsage` takes only `days` | Follows the header filter and host facet (default All work), with the managed share shown beside the figures. Add `scope=all\|managed\|<place key>` and `host` to `handleUsage`, `scanKey` and `aggregate`. Plan limits are always account-wide and labelled so. Limits: classify each opted-in project's statusLine, and report a kit footer still at user level as an older installation. Extra hosts come from `local.json` |
| Tool mix | Raw MCP names | Keep `claude-flow` as the server name so history doesn't split. Add a server-to-family tag (ruflo, aqe, brain, and deja-vu as retired) through `classifyToolName` (`src/lib/live/tool-classify.mjs:5`) |
| Projects | Top Git repositories by spend; plain folders and user-level locations are left out (`src/lib/usage-project-groups.mjs:61-64`) | Becomes **Places**: every kind, with a kind column and a managed badge, and rows that add up to the total. Opt-in status is read once per root at index read time and passed into `aggregate`, never stored in the parse cache, because a project can opt in after its transcripts were indexed |
| Context and the context-tax finding | Advice points at user-level guidance blocks. Claude window size is measured only where the footer runs | Follows the header filter, and says that Claude pressure is measured only where the footer runs, so **All work** shows input-only figures for sessions outside managed projects. Split the context-tax finding into opted-in and not. Advice points at the project rule, the `managed-tools` skill and `ak audit context` |
| `ak audit context` | Reads machine guidance files, top-level `mcpServers` in `~/.claude.json`, and the Superpowers plugin cache (`src/lib/context-audit-sources.mjs:216-275`) | Project rule target (about 1.5 KB budget), frontmatter of the `managed-tools` skill, local-scope, `.mcp.json` and project Codex MCP reported by scope, and project Superpowers evidence. Machine blocks show as an older installation |
| Observability | Reads every transcript. Workspace store in `~/.config/agentic-kit` | Reads stay. Workspace store moves to the cache. `resolveProjectIdentity` gets an `optedIn` flag for a badge and filter (`src/lib/live/project-label.mjs:70-93`) |
| Telemetry | Contract v1 fixes `selection.scope`. Inventory and maintenance come from user-level stores. Identity sits next to `kit.json` | Contract v2: `selection.scope` is `all\|managed`, matching the dashboard filter; optional per-session `akScope`; inventory and maintenance come from project state or read `unavailable`. Identity moves to the cache |
| Admin | npm download trends include automatic self-update installs | Annotate the release on the sparkline. The trend breaks there, because there are no more self-update installs and `npx … init` runs count instead |
| Derived state | `usage-index.json`, `observability-workspaces.json`, `claude-context-windows/`, rate-limit files, `openrouter-activity.json` and host-setup evidence live under `~/.config` or `~/.local/state` | All move to the cache, with a one-release read fallback from the old paths. The statusline footer reads the Brain version from the cache, not `kit.json` |

### Proof that ak stays out of other projects

Add a **Footprint** card under Usage → Context. It gives the user evidence of what this design
promises.

- **Per-session field.** Each session gets a cached `akFootprint` field: MCP calls per ak family,
  `managed-tools` and Ruflo skill uses, and kit-owned hook attachments. This bumps the index
  `SCHEMA_VERSION` from 26 to 27 (`src/lib/usage-index.mjs:198`).
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
| `~/.local/state/agentic-kit/` and the rest of `~/.config/agentic-kit/` | Removed after teardown succeeds, except the user data in the next row |
| AQE store-merge archives and whole-store backups in `~/.local/state/agentic-kit/aqe-store-merge/` (ADR-0062) | **Kept by default.** These are the user's data, not ak configuration. The purge lists them and asks before deleting them |
| The user-level Ruflo memory store `~/.claude-flow/memory`, used by sessions outside a project | **Kept by default.** It holds the user's memories. The purge names it and asks before deleting it |
| A standalone global `agentdb` installed by an older ak (retired with no ownership receipt) | Removed only after confirming the package is the one older ak installed; otherwise the purge prints the command to remove it |
| Three edits an older ak made inside Ruflo's install before it kept receipts | Cannot be restored. `--purge --dry-run` says so for anyone keeping their own Ruflo, and points to reinstalling Ruflo |
| The user-scope `claude-flow` MCP entry in `~/.claude.json` | Removed. It is also what the new version's single check looks for, so leaving it would block `ak init` |
| deja-vu | Wiring removed. Package and index each confirmed separately, defaulting to keep |
| External host adapters (experimental) | Each admitted adapter's own teardown runs. Its consent and grant files go with the rest of `~/.config/agentic-kit` |

It ends by printing the new version's opt-in command. A sandboxed-`HOME` regression test proves it:
run setup, then `uninstall --purge`, and `HOME` matches its pre-setup fingerprint apart from data the
user chose to keep.

Order matters. An older prerelease `ak sync` self-updates by following both the `latest` and `next`
tags (`src/lib/versions.mjs:209`). The project-scoped betas ship on their own `beta` tag (master plan
Decision 1), so no older installation jumps to them. The exit release itself must also never
self-update: the release candidates will later go on `next`, and an exit-release `ak sync` would
otherwise install one. In the exit release, `ak sync` skips self-update entirely and prints the
upgrade steps instead. The instructions always run it by exact version through `npx`, whatever
happens to be installed globally.

### The instructions

These go in the README and `docs/upgrading.md`:

```bash
# 1. Remove the old setup with the exit release (preview first)
npx @pacphi/agentic-kit@<exit-release> uninstall --purge --dry-run
npx @pacphi/agentic-kit@<exit-release> uninstall --purge

# 2. Remove the old global runner, if you installed one
npm uninstall -g @pacphi/agentic-kit

# 3. Opt in each project you want (@beta during the betas, @latest after GA)
cd my-project
npx @pacphi/agentic-kit@beta init
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
   - A third test builds a fixture account with sessions on several hosts. The sessions are spread
     across a repository with a worktree, a plain folder, the home folder, a temporary folder and
     a deleted folder. The test asserts that each session lands in exactly one place, and that the
     per-place rows add up to the All work totals for every host.
4. **Upstream watch.** Staged initializers and sandboxed live checks report user-level writes made
   by upstream tools, and each one becomes an upstream thread.

## Phasing

Every phase updates the dashboard panels and docs it affects. P6 holds the cross-cutting
dashboard work.

| Phase | Lands |
| --- | --- |
| Prerequisites | On `main`, in any order: [A](2026-10-01-prereq-ruflo-reference-pointer.md) (dangling reference pointer), [B](2026-10-01-prereq-intelligence-no-project-writes.md) (Intelligence writes into projects; adds `paths.cacheDir()`), [C](2026-10-01-prereq-maintenance-hook-scope.md) (hook scope and inventory wiring) |
| P0 | The exit release, which includes the prerequisites on the current line: a complete `uninstall --purge` and its regression test. Then, on the new line: remove deja-vu; tag and retire the external host-adapter contract; the ADR; the write gate in report-only mode; and contract tests recording today's violations as the baseline |
| P1 | The `.agentic-kit/` layout and `ak init` in personal mode for Claude: rules, the `managed-tools` skill, `settings.local.json`, local-scope MCP launchers. Staged initializers that use existing setups. The legacy check. User-level guidance writes stop |
| P2 | Tool cache and launchers. Global npm installs, self-update and host-CLI installs removed. Daemon handling scoped to the project |
| P3 | Codex project settings and the exception register; OpenCode project settings |
| P4 | Brain knowledge-base-only mode, agent-browser, embeddings consent, Superpowers evidence. Upstream requests filed |
| P5 | `sync`, `status` and `uninstall` on project state; team mode; the command removals and folds, including `ak x harvest` |
| P6 | Dashboard: launch-anywhere with the scope filter and host facet, places of every kind, the host coverage card and `ak run` records, the project index and `optedIn` census scope, status snapshots, the work view and Managed files panel, read-only views, the System, Maintenance and Usage changes, telemetry v2, and the Footprint card |
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
- **One filter, with exceptions.** The dashboard defaults to All work. Plan limits stay
  account-wide whatever the filter. A panel that only exists for managed projects says so at All
  work, and a panel without data at the selected level says so instead of showing an empty card.
- **Observation reach.** In v4, ak reads sessions only from Claude Code, Codex and OpenCode. Other
  hosts show on the coverage card as installed but not read, until v5.
- **Hermes leaves v4.** Supervised Hermes workers stop on the new line. Anyone who needs them can
  stay on the exit release until v5 supports Hermes directly.
- **Snapshot freshness.** Aggregates are only as fresh as each project's last `ak status` or
  `ak sync`. The dashboard shows each snapshot's age and offers an explicit refresh, rather than
  re-collecting every project when it opens.
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
- Which install markers reliably identify Hermes, Gemini CLI and other known hosts for the
  coverage card, without reading their session history.
