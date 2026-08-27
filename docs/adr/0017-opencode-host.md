# ADR-0017 — OpenCode as a managed, observable host through native surfaces

- **Status:** Accepted; compatibility references amended by
  [ADR-0020](0020-ga-stable-surfaces.md)
- **Date:** 2026-07-28
- **Updated:** 2026-08-25
- **Update note:** ADR-0032 implements project/provider-scoped OpenCode model discovery through a
  bounded descriptor-driven source adapter and an explicit online refresh; release proof remains
  pending. That reader does not change OpenCode's opt-in, non-primary, non-AQE routing boundary.
  Clarified that the AQE boundary applies to inference-provider routing, not
  AQE's upstream OpenCode platform assets, and recorded the implemented OpenCode transcript,
  token, observed-cost, and provider-id analytics path. ADR-0023 adds classified SQLite source
  health, preserves last-good OpenCode usage when a present store is temporarily unreadable,
  and requires pre-mutation disclosure of OpenCode's wildcard approvals, MCP registrations,
  lifecycle plugin, and managed host assets. The 2026-08-15 amendment keeps Ruflo and Agentic QE
  connected in stock OpenCode while blacklisting their eager tool catalogues from model requests
  and projecting a compact, lazy Agentic Kit gateway instead. The 2026-08-17 amendment adds a
  bounded cross-assistant-message repeated-tool guard to the managed lifecycle plugin. The
  2026-08-26 complexity-program wave 2 split the owner module's implementation across
  `opencode-core.mjs`/`opencode-agents.mjs`/`opencode-artifacts.mjs`/`opencode-lifecycle.mjs`
  (ADR-0037's file-size gate); `opencode.mjs` is now a re-export barrel, not a behavior change.
- **Deciders:** agentic-kit maintainers

> **GA amendment:** OpenCode remains opt-in, non-primary, and outside AQE inference-provider
> routing. AQE may still provision OpenCode platform agents, skills, permissions, and MCP
> configuration. Historical references to the removed compatibility executor do not describe a
> supported 4.0 surface.

**Model-lifecycle amendment (2026-08-25):** OpenCode's configured model references,
project/provider-scoped `models` output, and explicitly refreshed catalogue are evidence sources
under ADR-0032. Public discovery does not prove current-project entitlement, and ordinary
status or Dashboard reads will not invoke OpenCode or perform network refresh.
Provider-qualified CLI selectors preserve both axes as `opencode:provider/model`.

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

### 2026-08-15 amendment: connected MCPs with a compact model projection

Agentic Kit keeps its managed `claude-flow` and `agentic-qe` MCP entries enabled. Operators must
see both integrations as connected in OpenCode; hiding hundreds of eager schemas from the model
must not be implemented by disabling either MCP integration.

The OpenCode-only gateway separates process connectivity from model-facing catalogue exposure:

- the managed MCP processes remain enabled and available to the host;
- direct `claude-flow_*` and `agentic-qe_*` tool families are blacklisted from the provider
  request at runtime;
- compact `ak_ruflo_search`, `ak_ruflo_call`, `ak_aqe_search`, and `ak_aqe_call` tools discover
  and execute the live catalogues lazily; and
- RuvNet Brain remains a small direct MCP integration rather than being folded into the lazy
  Ruflo/AQE projection.

This projection is provider- and model-neutral. It belongs only to Agentic Kit's OpenCode host
adapter and does not change the Claude or Codex integrations. Receipt ownership, user permission
policy, explicit tool-policy collisions, and teardown protections still apply: the gateway may
hide or proxy only the exact family entries Agentic Kit can prove it owns.
Because stock OpenCode loads `opencode.jsonc` after `opencode.json`, a sibling later override makes
the effective MCP and permission values unprovable. Agentic Kit preserves that user file and fails
closed before writing config or deploying executable projections; status names the collision.

The first load-bearing acceptance slice is intentionally narrower than full rUv-stack parity.
Isolated exact-stock OpenCode 1.18.18 runs (binary SHA-256
`4f5979c2dadb06fbff1335335afaaea274e58f92e79aa43cf2ed98618d555422`) proved:

- `/mcp` reported both `claude-flow` and `agentic-qe` as `connected`;
- the Brain route additionally reported `ruvnet-brain` as `connected`;
- the deterministic fixture run advertised 18 provider tools and the installed-service run
  advertised 21; both included seven compact `ak_*` gateway tools and zero direct Ruflo/AQE
  tools;
- `ak_ruflo_search` selected `memory_search`, `ak_ruflo_call` executed it through a real MCP
  protocol child, and the resulting tool output continued through the stock OpenCode session in
  both modes;
- `ak_aqe_search` independently selected `fleet_init`, `ak_aqe_call` executed it without a
  gateway or MCP error, and its result continued through the same stock session;
- direct `ruvnet-brain_search_ruvnet` executed a grounded AgentDB capability search and continued
  through the stock session;
- `ak_skill_search` selected the receipt-known `memory` skill and the stock `skill` tool loaded
  its exact body;
- `ak_agent_search` selected `memory-specialist`, the stock `task` tool created an
  `ak-specialist` child session, and that child loaded the exact profile through
  `ak_agent_load`; and
- the installed `marketplace@3.35.0` catalogue independently loaded the real `memory-search`
  skill and dispatched the real `coder` profile from its 107 converted profiles; and
- the installed-service modes used the machine's installed `claude-flow-mcp`, `aqe-mcp`, and
  RuvNet Brain shim rather than fixture servers.

The fixture mode provides deterministic argument and call-ID inspection; the installed mode
proves one live Ruflo operation, one live Agentic QE initialization operation, and one live Brain
grounding operation. Together they prove host, gateway, protocol, schema-projection, and
continuation behavior—not full rUv-stack outcome parity. The deterministic fixture checks and
installed-catalogue checks prove loading and dispatch mechanics, not that every profile's optional
dependencies are installed or every specialist outcome is correct. `ak_agent_load` therefore names
remaining external MCP families in the selected profile, states that this adapter does not provision
them, and requires the specialist to report an unavailable dependency instead of inventing a call or
result. Full acceptance still requires
broader representative operations, command/status and collision/rollback coverage,
packed-artifact replay, and measured initial-provider-request reduction. Those gates must pass
before the adapter is described as full-stack parity or release-ready.

The matched installed-service projection capture quantifies the initial-load objective. With the
gateway removed, stock OpenCode advertised 429 tools, including 415 direct Ruflo/AQE tools; tool
schemas occupied 335,442 bytes and the serialized provider request occupied 413,542 bytes. With
the compact gateway enabled, the same stock binary and installed MCPs advertised 21 tools, zero
direct Ruflo/AQE tools, 27,458 schema bytes, and a 37,501-byte provider request. That is a 95.10%
tool-count reduction, 91.81% schema-byte reduction, and 90.93% total-request reduction. The direct
Brain route advertised 24 tools, 29,492 schema bytes, and a 39,650-byte request, remaining inside
the same compact ceilings. The stock
acceptance gate therefore enforces both sides: at least 400/300,000 direct tools/schema bytes in
the installed eager control, and no more than 25 tools, 30,000 schema bytes, or 45,000 request
bytes in the compact candidate. These are serialized request sizes, not tokenizer-specific token
estimates or end-to-end inference timings.

### 1. A managed host adapter — opt-in, `hosts.opencode: false` by default

The ADR-0016 host registry declares `canDriveSession:true`, `canBePrimary:false`, and now
`canRouteActivities:true`, plus the `opencode-ai` npm package and native OpenCode
projection. Brew/mise/native installs report `external` and are never touched.
`integrations.hosts.opencode` is the canonical intent field and `--opencode` opts in.
No `ENABLE_*` env exists for opencode (ruflo's ADR-034 backend flags don't cover it), so
wiring is entirely config-file based — the `MANAGED_ENV_KEYS` surface is unchanged.
ADR-0018 supplies the subsequent execution proof and limits this capability to explicit `ak run`
routes; it does not make OpenCode primary or an AQE provider.

### 2. One owner module: `src/lib/opencode.mjs`

Every ak-managed byte on opencode's surfaces lives behind one module, following the
`settings.mjs`/`mcp.mjs` contracts (backup-first, merge-not-clobber, idempotent).
`src/lib/opencode.mjs` is the single import path every consumer uses; since 2026-08-26 its
implementation is split by size (not by ownership) across `opencode-core.mjs` (config-wiring),
`opencode-agents.mjs` (catalog + agent conversion/sync/status), `opencode-artifacts.mjs`
(plugin + skill deployment/teardown), and `opencode-lifecycle.mjs` (the stack composition below)
— `opencode.mjs` itself re-exports their combined public surface, so this remains one owner
module from every caller's point of view:

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
- **Ownership:** on first write ak records `integrations.ownership.opencode.mcp='ak'` plus
  value receipts under `integrations.ownership.opencode.managed`
  (`{mcp:{}, paths:[], permissions:{}, artifacts:{}}`) in kit.json. Artifact receipts are
  SHA-256 hashes of the exact last-written content.
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
  policy: lifecycle, routing, and learning integration failures never break the host. Bash
  screening is explicitly defense-in-depth and fails open when the local handler errors or times
  out. One host-local safety condition fails closed: after three completed calls with the same
  tool name, recursively canonicalized arguments, and exact output in one user turn, a fourth
  identical call aborts that session. A changed tool/argument/output or new user message resets
  the trailing streak; sessions are isolated and compaction does not erase it. This closes stock
  OpenCode 1.18.18's current-message-only detector gap without copying the over-broad upstream
  proposal that counts nonconsecutive matches anywhere in compacted history. Focused tests cover
  reordered object keys, changed-call/output reset, user-turn reset, session isolation, and the
  wired session-abort path.
- **Agents converted into a lazy receipt-owned catalogue:** `convertAgents` normalizes the
  complete upstream profile set, deterministically resolves name collisions, and embeds the
  resulting metadata and bodies in the exact-receipted gateway. OpenCode scans only one managed
  `ak-specialist` subagent. The parent chooses a profile with `ak_agent_search`, stock `task`
  creates the child, and the child loads the exact body with `ak_agent_load`. Managed Ruflo/AQE
  references are translated at load time from the capabilities the gateway actually captured;
  remaining external MCP families are named as optional dependencies and never claimed as
  installed. Migration removes only receipt-matching legacy generated agents after the gateway
  and dispatcher are both current; user-modified files and a user-owned dispatcher name collision
  preserve the eager fallback and are reported rather than overwritten.
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
registry rows carry opencode-correct content — `ruflo-opencode-reference` (connected MCPs,
compact gateway, lazy skills/specialists) and `ruvnet-brain-opencode-reference` (the
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
Out of scope (matching Codex's own asymmetry): AQE **provider routing** (no OpenCode provider
type exists), AQE `agentOverrides` projection, statusline (no upstream surface), and
`drivingHost` session detection (OpenCode sets no session env marker). AQE itself can provision
OpenCode platform agents, skills, permissions, and MCP configuration; agentic-kit does not
currently request or own that platform initialization.

OpenCode historical analytics are now implemented: `usage-opencode.mjs` reads its SQLite store
read-only, and `usage-index.mjs` carries transcripts, tokens, observed cost, and provider id into
the shared dashboard/session shape. This does not manufacture provider identity for live worker
leases and does not create account-quota or subscription evidence. The registry's `usage:false`
capability is stale relative to this implemented analytics path and remains an explicit contract
discrepancy until reconciled.

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
- `src/lib/opencode.mjs` (the owner module's public entry point, re-exporting
  `opencodeStack`/`retireOpencode`/`reconcileOpencodeGuidance` from
  `src/lib/opencode-lifecycle.mjs`, plus `src/lib/opencode-core.mjs`,
  `src/lib/opencode-agents.mjs`, and `src/lib/opencode-artifacts.mjs`), `src/lib/hosts.mjs` (adapter),
  `src/lib/providers.mjs` (registry-derived managed host projection,
  `--opencode` flag handling, `hostAuthState` home seam),
  `src/lib/blocks.mjs` (`agents-opencode` target, new registry rows),
  `src/commands/{sync,status,setup,uninstall}.mjs`, `src/commands/x/host.mjs`
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
- Compact-gateway tests: `tests/kit/opencode-ruflo-gateway.test.mjs` (gateway protocol,
  lifecycle, policy, and ownership contracts) and
  `tests/kit/opencode-stock-ruflo-gateway.test.mjs` (isolated exact-stock OpenCode acceptance).
