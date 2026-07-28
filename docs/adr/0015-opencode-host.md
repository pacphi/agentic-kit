# ADR-0015 — opencode as a third host: ruflo/ruvnet-brain wiring through opencode's native surfaces

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** agentic-kit maintainers

## Context

`ak` models two frontier hosts (`claude`, `codex`) behind the host-adapter abstraction in
`src/lib/hosts.mjs`, each wired to the same rUv stack (ruflo MCP, ruvnet-brain, skills,
guidance) through that host's *native* surfaces — ak's standing rule is "write the host's
own config, never a parallel config layer." **opencode** (opencode.ai) is a third agent
CLI in the same class, and its native surfaces are different again:

- **Config:** `~/.config/opencode/opencode.json` (JSONC-tolerant schema), holding `mcp`
  local-server entries (`{type, command[], environment, enabled, timeout}`), `skills.paths[]`,
  and `permission` as wildcard tool-name patterns. MCP tools surface as `<server>_<tool>`
  (so `claude-flow_memory_search`, not `mcp__claude-flow__memory_search`).
- **Hooks:** none. There is no settings-hooks surface; lifecycle extension happens through
  plugin files (`~/.config/opencode/plugins/*.js`) exporting event handlers
  (`event`, `chat.message`, `tool.execute.before/after`, …).
- **Guidance:** `~/.config/opencode/AGENTS.md` — and when it exists, opencode prefers it
  **over** falling back to `~/.claude/CLAUDE.md` (Claude Code compatibility). So opencode
  needs its *own* managed copy of the machine guidance; inheriting claude's file silently
  stops working the moment ak creates opencode's.
- **Agents/skills:** opencode reads subagents from `~/.config/opencode/agents/*.md`
  (frontmatter `description` + `mode`, body = prompt) and skills from
  `~/.claude/skills/` + `skills.paths`. ruflo ships its agent set in Claude Code's
  different frontmatter format (`name`, `tools: …` string list) with bodies referencing
  `mcp__claude-flow__*` tool names.

Without an adapter, a ruflo upgrade leaves opencode's wiring stale: the agent copies,
the plugin, the config entries, and the guidance file are static artifacts with no owner.

## Decision

### 1. A third host adapter — opt-in, `hosts.opencode: false` by default

`HOST_ADAPTERS.opencode` in `hosts.mjs` (`configFormat:'json'`, `statuslineSupported:false`,
`aqeProvider:null`, no session env markers), a `HOSTS` row (`bin:'opencode'`,
`pkg:'opencode-ai'` — brew/mise installs report `external` and are never touched), and
`providers.hosts.opencode` in kit.json's defaults. `--opencode` on `ak setup` opts in.
No `ENABLE_*` env exists for opencode (ruflo's ADR-034 backend flags don't cover it), so
wiring is entirely config-file based — the `MANAGED_ENV_KEYS` surface is unchanged.

### 2. One owner module: `src/lib/opencode.mjs`

Every ak-managed byte on opencode's surfaces lives behind one module, following the
`settings.mjs`/`mcp.mjs` contracts (backup-first, merge-not-clobber, idempotent):

- **`opencode.json` wiring** (`applyOpencode`): `mcp.claude-flow` (command
  `claude-flow-mcp` when the dedicated stdio bin is present — it answers `initialize`
  directly — else `ruflo mcp start`, ak's claude/codex registration), `mcp.ruvnet-brain`
  (the stable-spine shim `~/.claude/ruvnet-brain/mcp/server.mjs`, which hot-swaps brain
  versions so the registration never needs rewriting), `skills.paths`, and
  `permission` allow-patterns for both separator spellings. A file that is not plain
  JSON (legal JSONC comments) is **refused, never clobbered** — detected via a strict
  reader, since `settings.readJson`'s fallback parameter cannot distinguish
  "absent" from "unparseable".
- **Ownership is VALUE-precise, not name-precise** (hardened after cross-vendor
  review): every managed key is recorded as `{prior, written}`. A pre-existing entry
  whose value DIFFERS from ak's desired value (and was not previously ak-written) is a
  **collision** — preserved and reported, never adopted or torn down. Teardown restores
  the user's prior value rather than deleting the key, and only while the current value
  still equals what ak wrote (a user edit survives both pruning and teardown).
  Previously-managed keys that fall out of the desired set (brain shim removed, catalog
  source changed) are pruned under the same ==-written guard. Scalar `permission`
  shorthand is lifted to its documented object equivalent (`{"*": v}`) before merging
  and restored on undo.
- **Ownership:** on first write ak records `providers.opencodeMcp='ak'` plus the exact
  managed key set (`opencodeManaged: {mcp[], paths[], permissions[]}`) in kit.json.
  `undoOpencode` strips exactly that set — user MCP servers, user skills paths, and user
  permissions survive teardown (mirrors the `codexMcp`/`rufloCodexMcp` ownership guards,
  made precise for a shared JSON document).
- **Hooks as a plugin file:** `src/templates/opencode-ruflo-hooks.js` maps opencode's
  plugin events to ruflo's local hook-handler verbs (`session-restore`/`session-end` on
  session lifecycle, `pre-bash` blocking only explicit `[BLOCKED]` verdicts,
  `post-edit`/`pre-task`/`post-task` feeding the learning substrate, `route` injecting
  routing context on `chat.message` as a fully-formed `synthetic` text part —
  opencode validates id/messageID/sessionID on persisted parts). Deployed
  content-diffed (`deployPlugin`), refreshed whenever the template changes, and
  **no-clobber**: a foreign (marker-less) file at any deploy slot is preserved and
  reported, never overwritten. Failure policy: hooks never break the host.
- **Agents converted, not copied:** `convertAgents` rewrites Claude-format frontmatter to
  `{description, mode: subagent}` (dropping the `tools:` string list — opencode uses
  permissions, and subagents inherit the invoker's tools, matching the broad lists these
  agents declare), emits descriptions as JSON double-quoted scalars (valid YAML 1.2 —
  unquoted colon-space content would corrupt frontmatter), rewrites body refs across
  all three
  catalog spellings (`mcp__claude-flow__`/`mcp__claude_flow__`/`mcp__ruflo__` →
  `claude-flow_`), prefixes basename collisions with the category dir, and skips
  `type: documentation` files. Generated files carry an ak marker; `syncAgents`
  rewrites/removes marked files only and leaves user files untouched (the earlier
  standalone script's marker is adopted, not orphaned). The stamp
  (`.ak-agents-stamp.json`) records the source id **and the actually-deployed file
  list** (user-occupied slots are never in it), written only when the set changes —
  so status detects structural divergence (deleted/extra generated files), not just
  version drift.
- **Catalog source resolution** (`catalogSource`): kit.json `opencodeCatalogDir` override
  → `$RUFLO_REPO` → the claude marketplace clone `~/.claude/plugins/marketplaces/ruflo`
  (full repo mirror — all agents, all plugin skills, platform `SKILL.md` — auto-updated
  by claude) → the published `@claude-flow/cli` package (the ADR-128 substrate agents +
  core skills) → the nested copy under `ruflo/node_modules` (the layout a plain
  `npm i -g ruflo` produces). Candidates are lazy thunks so the npm-root lookups
  (which spawn `npm root -g`) only run when earlier candidates miss — status probes
  stay spawn-free on marketplace machines. The source id (`kind@version`, read from
  its `package.json`) drives drift detection: a ruflo upgrade or marketplace
  auto-update diverges the stamp, `ak status` flags it, `ak sync` re-converts.
- **Platform skill:** the repo-root `SKILL.md` deploys to
  `~/.config/opencode/skills/ruflo/` with a deployed-marker for gated teardown.

### 3. Guidance target `agents-opencode` + opencode-flavored block templates

`guidanceTargets` gains `agents-opencode` → `~/.config/opencode/AGENTS.md` under the same
dir-exists gate as `~/.codex` (never `mkdir`'d; existence = install signal). Two new
registry rows carry opencode-correct content — `ruflo-opencode-reference` (opencode tool
naming, plugin bridge, converted agents) gated on `command: opencode`, and
`ruvnet-brain-opencode-reference` (the `ruvnet-brain_search_ruvnet` tool name) gated on
the KB dir — while `ruflo-preamble` (host-agnostic operating rules) is shared:
`guidanceFiles: ['claude', 'agents-opencode']`. The claude-only twins
(`ruflo-reference`, `ruvnet-brain-reference`) deliberately do **not** target
`agents-opencode`, and `retiredForTarget` force-strips them if they ever land there.

### 4. Sync/status/setup/teardown wiring

`status.collect` gains an `opencode` subsystem (config convergence via
`opencodeConverged` — deep value comparison, not key presence — plus plugin currency,
agent-set drift, platform skill; gated on the CLI being present); `sync` applies via
the same rows, AFTER the hosts install branch and likewise CLI-gated (enabled-but-absent
never creates the config home); `setup --opencode` runs the identical machine-step and
deploys the guidance blocks immediately. `ak x provider off` and `ak uninstall` strip
the config wiring (ownership-gated, priors restored), the deployed artifacts
(marker-gated, precise to ak's files), and the guidance blocks — with `uninstall`'s
cfg read hoisted above any kit.json purge so ownership is known at teardown time.
`x provider pick` (the claude↔codex routing chooser) deliberately excludes opencode and
preserves its flag + ownership markers verbatim. `detectHosts` reads the config-file
host's wired state from its own config (no `env[null]`). `versions.mjs` tracks
`opencode-ai` when npm-managed.

The **dashboard** categorizes the subsystem into the Hosts tab alongside
`mcp`/`codex-mcp` (its designed fallback is Runtime, so nothing was ever dropped — this
is categorization, not plumbing; the rows flow through the same `collect()` payload
`ak status` prints, so the two surfaces cannot disagree). The **drift nudge** (`nudge.mjs`)
switches from its hardcoded two-target block list to the shared `guidanceTargets` +
`retiredForTarget` composition — its stated contract is "never disagrees with
`ak status`", which a frozen subset silently breaks whenever a guidance target is added
(this also closes a pre-existing gap: codex's `agents-user` drift never surfaced there
either). **`x provider pick`** is the claude↔codex *routing* tool; it now preserves
`hosts.opencode` and the opencode ownership markers verbatim instead of rebuilding the
`providers` object without them (previously a pick would have silently unwired the host).
Out of scope (matching codex's own asymmetry): routing-table integration
(`routing.mjs` untouched), aqe provider wiring (no opencode provider type exists),
statusline (no upstream surface), `drivingHost` session detection (opencode sets no
session env marker), and usage/cost attribution (`usage-index.mjs` reads claude/codex
transcripts only — the pricing surface has no opencode input and shows nothing for it,
which is the honest shape).

## Consequences

- `ak sync` now converges opencode alongside claude/codex: a ruflo upgrade re-keys the
  agent set + skills paths + plugin; a brain update hot-swaps through the shim with zero
  opencode-side writes; drift shows in `ak status` with a fix attached.
- opencode machines with no claude marketplace clone still work, degraded to the npm
  package's substrate agent/skill set; the override (`opencodeCatalogDir` / `$RUFLO_REPO`)
  covers git-checkout power users.
- Machines without opencode see zero new writes: the guidance target is gated on the
  config home existing, and every apply path is gated on `hosts.opencode`.
- Teardown is surgical: `x provider off` / `uninstall` remove only ak-managed keys,
  marked files, and ak's blocks — user customizations to `opencode.json` persist.
- opencode's config is rewritten as plain JSON: legal JSONC comments in a pre-existing
  `opencode.json` would be lost on merge — so ak **refuses** unparseable files with a
  manual-merge message instead of silently normalizing them.

## Alternatives considered

- **Register MCP via `opencode mcp add`.** Rejected: the CLI's add surface cannot
  reliably express the env block + request timeout + global scope in one
  non-interactive call, and ak still needs a merge writer for `skills.paths` and
  `permission` regardless — one writer with backup/idempotence beats two mechanisms.
- **Point skills/agents at a git checkout (`/opt/ruflo`) by default.** Rejected as a
  default: machine-specific and undiscoverable. The marketplace clone (auto-updated,
  full catalog) and the published package (universal fallback) cover the spectrum;
  the checkout remains available as an explicit override.
- **Copy agents unconverted.** Rejected: Claude-format `tools:` strings are not valid
  opencode frontmatter, and `mcp__claude-flow__*` body refs name tools that don't exist
  under opencode's naming. Conversion is required for correctness, not just style.
- **No plugin (skip hooks).** Rejected: the learning substrate (`post-edit` outcome
  recording, session consolidation) and `pre-bash` safety screening are half the value
  of the ruflo integration; opencode's plugin events are the only hook surface and they
  map cleanly.
- **Share `ruflo-reference`/`ruvnet-brain-reference` with opencode.** Rejected: both
  templates name claude-only tool spellings and claude-specific management paths.
  Twin templates keep each file honest; the preamble stays shared because it is
  genuinely host-agnostic.

## References

- `src/lib/opencode.mjs` (the owner module), `src/lib/hosts.mjs` (adapter),
  `src/lib/providers.mjs` (`HOSTS` row, `--opencode` flag handling, `hostAuthState`
  home seam), `src/lib/blocks.mjs` (`agents-opencode` target, new registry rows),
  `src/commands/{sync,status,setup,uninstall}.mjs`, `src/commands/x/provider.mjs`
  (`off` teardown + `pick` preservation), `src/lib/nudge.mjs` (shared targets),
  `src/lib/dashboard-server.mjs` (Hosts-tab categorization),
  `src/lib/versions.mjs` (drift), `src/templates/opencode-ruflo-hooks.js`,
  `claude/ruflo-opencode-reference.md`, `claude/ruvnet-brain-opencode-reference.md`.
- opencode config schema: `https://opencode.ai/config.json`; opencode plugin/docs:
  `https://opencode.ai/docs/{plugins,agents,skills,rules,mcp-servers}`.
- ruflo env parity: `v3/@claude-flow/cli/src/init/mcp-generator.ts`; hook verbs:
  `.claude/helpers/hook-handler.cjs` (in the ruflo repo / marketplace clone).
- Tests: `tests/kit/opencode.test.mjs`, `tests/dashboard.test.cjs` (opencode rows +
  categorization), `tests/kit/{hosts,guidance-targets}.test.mjs` (extended).
