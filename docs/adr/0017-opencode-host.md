# ADR-0017 — OpenCode as a managed, observable host through native surfaces

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** agentic-kit maintainers

## Context

ADR-0016 separates execution hosts, inference providers, projections, observability,
ownership, and lifecycle capabilities. At this ADR's adoption, OpenCode was registered as a
managed, non-primary, non-routable host. This ADR applies that
architecture to OpenCode's native surfaces — ak's standing rule is "write the host's
own config, never a parallel config layer." **OpenCode** is a third agent
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

### 1. A managed host adapter — opt-in, `hosts.opencode: false` by default

The ADR-0016 host registry declares `canDriveSession:true`, `canBePrimary:false`, and now
`canRouteActivities:true`, plus the `opencode-ai` npm package and native OpenCode
projection. Brew/mise/native installs report `external` and are never touched.
`providers.hosts.opencode` remains the compatibility intent field and `--opencode` opts in.
No `ENABLE_*` env exists for opencode (ruflo's ADR-034 backend flags don't cover it), so
wiring is entirely config-file based — the `MANAGED_ENV_KEYS` surface is unchanged.
ADR-0018 supplies the subsequent execution proof and limits this capability to explicit `ak run`
routes; it does not make OpenCode primary or an AQE provider.

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
- **Ownership:** on first write ak records `providers.opencodeMcp='ak'` plus value
  receipts (`opencodeManaged: {mcp:{}, paths:[], permissions:{}, artifacts:{}}`) in
  kit.json. Artifact receipts are SHA-256 hashes of the exact last-written content.
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
  **no-clobber**: only content matching the exact last-written SHA-256 receipt may be
  refreshed or removed; marker-bearing user edits are preserved and reported. Failure
  policy: hooks never break the host. Bash screening is explicitly defense-in-depth and
  fails open when the local handler errors or times out.
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
  standalone script's marker alone is not treated as proof of ownership). The stamp
  (`.ak-agents-stamp.json`) records the source id, actually-deployed file list, and
  content hashes; kit.json retains the authoritative last-written receipts. Status
  distinguishes user-modified files from repairable structural/version drift.
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
naming, plugin bridge, converted agents) and `ruvnet-brain-opencode-reference` (the
`ruvnet-brain_search_ruvnet` tool name) — both **enablement-gated**
(`flag: opencodeEnabled`: the template asserts active wiring, so an installed-but-disabled
host must not receive it; `ak host off` / pick-disable strip them on the next
reconcile) — while `ruflo-preamble` (host-agnostic operating rules) is shared:
`guidanceFiles: ['claude', 'agents-opencode']`. The claude-only twins
(`ruflo-reference`, `ruvnet-brain-reference`) deliberately do **not** target
`agents-opencode`, and `retiredForTarget` force-strips them if they ever land there.

### 4. Sync/status/setup/pick/teardown wiring — the two-tier host model

`ak` manages **three managed host integrations** (claude, codex, opencode). All three can be
explicit activity-routing targets through `ak run`; the Claude/Codex pair remains the only
primary-host, AQE-projection, and deprecated `ak dual` compatibility set. OpenCode participates
in install/config/guidance/status/sync/teardown exactly like the others, and is never
`primaryHost` or an AQE provider. Managed, primary, and routing sets are
derived from ADR-0016's `canDriveSession`, `canBePrimary`, and `canRouteActivities`
capabilities rather than parallel descriptor flags or hardcoded id lists.

`status.collect` gains an `opencode` subsystem (config convergence via
`opencodeConverged` — deep value comparison, not key presence — plus plugin currency,
agent-set drift, platform skill; gated on the CLI being present). `sync` applies via
the same rows, AFTER the hosts install branch and likewise CLI-gated (enabled-but-absent
never creates the config home), and its **blocks branch runs after the opencode branch
with an `opencode` guard**, so a fresh enable creates the config home *and* converges
the `agents-opencode` guidance target in one sync (a second sync is then a true no-op).
`setup --opencode` runs the identical machine-step and deploys the guidance blocks
immediately.

**`ak host pick` manages OpenCode like any managed host** (the post-install adoption path,
replacing the first revision's "rerun setup" gap): `--host` is the complete desired
enabled-host set across both tiers; an unknown token is a hard error before any
mutation (a typo never tears a host down); interactive defaults are currently-enabled
hosts ∪ newly-detected routing hosts (an enabled-but-absent host is never dropped by a
bare enter, and an installed-but-disabled integration host is never opted in by one).
Excluding opencode **disables** it through the same marker-gated teardown as
`off`/`uninstall` — ak wiring stripped, user priors restored, user-owned config
preserved — and `--primary-host` stays validated against the routing pair. Every pick
rewrite preserves **all** ownership markers (`codexMcp`, `rufloCodexMcp`,
`opencodeMcp`, `opencodeManaged`, `opencodeCatalogDir`) — a retune never strands the
teardown proof for either host.

All five mutating commands share **one owner-module composition** (`opencodeStack` for
enable, `retireOpencode` for teardown, `reconcileOpencodeGuidance` for guidance) — no
merge/ownership logic lives in any command. Two honesty rules hardened the teardown
itself: a **converged file with stale/missing markers** still re-persists them
(`markersChanged` — otherwise the next teardown can't prove ownership), and a
**JSONC-refused config fails the teardown honestly** (markers retained, wiring reported
as still active, manual remediation named) while an **absent config clears the
now-stale markers** instead of chasing a phantom.

`detectHosts` reads the config-file host's wired state from its own config (no
`env[null]`). `versions.mjs` tracks `opencode-ai` only when npm-managed (external
installs are visible as host state but never claimed as ak-owned update drift).

The **dashboard** categorizes the subsystem into the Hosts tab alongside
`mcp`/`codex-mcp` (its designed fallback is Runtime, so nothing was ever dropped — this
is categorization, not plumbing; the rows flow through the same `collect()` payload
`ak status` prints, so the two surfaces cannot disagree). The **drift nudge** (`nudge.mjs`)
switches from its hardcoded two-target block list to the shared `guidanceTargets` +
`retiredForTarget` composition — its stated contract is "never disagrees with
`ak status`", which a frozen subset silently breaks whenever a guidance target is added
(this also closes a pre-existing gap: codex's `agents-user` drift never surfaced there
either). The `pick` rework in §4 replaces the first revision's behavior (opencode was
excluded and merely preserved) with full two-tier management. ADR-0018 subsequently adds
explicit OpenCode routing through `ak run`.
Out of scope (matching Codex's own asymmetry): AQE provider wiring (no opencode provider type
exists),
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
- Teardown is surgical: `ak host off` / `uninstall` remove only receipt-matching
  ak-managed keys and files plus ak's blocks. User edits and customizations persist.
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

- ADR-0016 defines the registry, lifecycle, ownership, and normalized-fact contracts
  implemented here. ADR-0018 records the generalized execution contract implemented by #82.
- `src/lib/opencode.mjs` (the owner module: `opencodeStack`, `retireOpencode`,
  `reconcileOpencodeGuidance`), `src/lib/hosts.mjs` (adapter),
  `src/lib/providers.mjs` (registry-derived managed host projection,
  `--opencode` flag handling, `hostAuthState` home seam),
  `src/lib/blocks.mjs` (`agents-opencode` target, new registry rows),
  `src/commands/{sync,status,setup,uninstall}.mjs`, `src/commands/x/provider.mjs`
  (`pick` two-tier management + `off` teardown), `src/lib/nudge.mjs` (shared targets),
  `src/lib/dashboard/client.mjs` (Hosts-tab categorization),
  `src/lib/versions.mjs` (drift), `src/templates/opencode-ruflo-hooks.js`,
  `claude/ruflo-opencode-reference.md`, `claude/ruvnet-brain-opencode-reference.md`.
- opencode config schema: `https://opencode.ai/config.json`; opencode plugin/docs:
  `https://opencode.ai/docs/{plugins,agents,skills,rules,mcp-servers}`.
- ruflo env parity: `v3/@claude-flow/cli/src/init/mcp-generator.ts`; hook verbs:
  `.claude/helpers/hook-handler.cjs` (in the ruflo repo / marketplace clone).
- Tests: `tests/kit/opencode.test.mjs` (owner module), `tests/dashboard.test.cjs`
  (opencode rows, rendered grouping, update banner), the command-level suites
  `tests/kit/{setup-command,setup-host-flags,status-command,sync-command,uninstall-command,provider-cli,providers}.test.mjs`
  (enable/disable/dry-run/teardown orchestration, sandboxed),
  `tests/kit/opencode-version-drift.test.mjs` (npm-managed vs external update
  ownership), `tests/kit/{hosts,guidance-targets}.test.mjs` (extended).
