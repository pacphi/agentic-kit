# ADR-0058 — Managed ruflo components

- **Status:** Accepted (not yet implemented)
- **Date:** 2026-09-23
- **Updated:** 2026-09-23 — accepted after maintainer review; implementation plan at
  [docs/superpowers/plans/2026-09-23-managed-ruflo-components.md](../superpowers/plans/2026-09-23-managed-ruflo-components.md)
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0016](0016-capability-driven-integration-adapters.md) (value-precise ownership),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md) (explicit degradation),
  [ADR-0031](0031-capability-graduation-and-upstream-requests.md) (upstream requests),
  [ADR-0055](0055-aqe-embedding-lifecycle.md) (owned host environment projection),
  ADR-0059 (encryption at rest for ruflo data; separate, to be written)

## Context

Ruflo ships optional components faster than users can track them. Between 3.34.0 and 3.44.0
(31 July – 23 September 2026) it added several opt-in capabilities, each switched on by an
environment variable, an extra package, a project file or a CLI command. None are on by
default, and agentic-kit (`ak`) neither enables them nor reports whether they are enabled.

An audit on 2026-09-23 against the installed ruflo 3.43.0 and the full text of every GitHub
release from v3.34.0 to v3.44.0 found:

| Component | Ruflo source | Default | Switch |
|---|---|---|---|
| Typesafe agent picker | v3.43.0 release notes §3; `dist/src/ruvector/typesafe-router.js` | off | `@ruvector/typesafe` package + `CLAUDE_FLOW_ROUTER_TYPESAFE=1` |
| MiniLM agent picker | v3.44.0 release notes §2 (ADR-390) | off | `CLAUDE_FLOW_ROUTER_EMBEDDER=minilm` |
| MCP tool governance | v3.42.0 release notes; `dist/src/mcp-tools/policy-enforcer.js` | off | `RUFLO_MCP_ENFORCE_POLICY=1` + `<project>/.harness/mcp-policy.json` |
| Learning profile | v3.42.1 release notes; `@claude-flow/memory` `learning-bridge.js` | `balanced` | `RUFLO_INTELLIGENCE_MODE` |
| MetaHarness turn-credit | v3.36.0 release notes | bundled optional dependency | none |
| Memory durability fix (#2887) | v3.36.0 addendum | needs `@claude-flow/memory` ≥ 3.0.0-alpha.22 | none |
| Funnel (promotional surfaces) | `ruflo funnel` | on (package default) | `ruflo funnel disable` |

Behaviour the design must respect, verified in ruflo 3.43.0 source:

- **Governance fails closed.** With `RUFLO_MCP_ENFORCE_POLICY=1`, every stdio MCP tool call is
  refused unless `<cwd>/.harness/mcp-policy.json` exists and parses. Nothing in ruflo creates
  that file. Only `auditLog` and `maxToolCallsPerTurn` (a rolling `turnWindowMs` window,
  default 60 s) are enforced. The audit log is always `os.tmpdir()/ruflo-mcp-audit.jsonl`,
  shared by all projects, and records `timestamp, sessionId, toolName, allowed, reason`.
- **The typesafe package is resolved from ruflo's own module tree** (`createRequire` inside
  `@claude-flow/cli`). A global install resolves; a project-local install does not.
- **Hosts read settings from their launch environment.** A value in the user's shell does not
  reach Claude Code hooks, the ruflo MCP server, Codex or OpenCode.
- **`ruflo doctor --component <x>`** reports install/enable state for 21 components as text
  only; 3.43.0 has no JSON output. It has no component for the MiniLM picker or governance.
- **Learning profiles** (`@claude-flow/neural` `sona-manager.js`): `real-time` 0.5 ms / 25 MB,
  `balanced` 18 ms / 50 MB, `research` 100 ms / 100 MB, `edge` 1 ms / 5 MB, `batch`
  50 ms / 75 MB. On the audited machine the SONA engine the profile tunes was not loaded,
  so a profile value alone says nothing about whether learning is happening.
- **Ruflo's own evaluation (v3.44.0, ADR-391)** found that neither new picker yet beat the
  default by its acceptance bar. They are enabled here at the maintainer's request, so the
  evidence of which picker actually chose must be visible.

Encryption at rest is also wanted but needs storage-level machinery on three operating
systems. It is decided separately in ADR-0059 and appears here only as a catalogue entry.

## Decision

### 1. One catalogue of ruflo components

A new module, `src/lib/ruflo-components/`, holds one descriptor per component. Setup, status,
sync, uninstall and the dashboard read the catalogue and nothing else, so adding a component
is one descriptor and its tests.

A descriptor declares:

- `id`, `label`, and the minimum ruflo version;
- the managed value and the allowed values (the learning profile lists all five with their
  budgets);
- `explain`: what it does, its benefit, its cost, and how to change it, in plain language;
- `detect`, `plan`, `apply`, `verify` and `undo`, following ADR-0016's lifecycle (detect and
  plan are read-only; apply converges; verify reads the real surface; undo touches only owned
  values);
- its evidence sources and how fresh they must be.

Managed values:

| Component | Managed value | Minimum ruflo | Applied by | Verified by |
|---|---|---|---|---|
| `typesafePicker` | on | 3.43.0 | global `@ruvector/typesafe` + `CLAUDE_FLOW_ROUTER_TYPESAFE=1` | module resolves from ruflo's tree; `doctor -c typesafe` |
| `minilmPicker` | on | 3.44.0 | `CLAUDE_FLOW_ROUTER_EMBEDDER=minilm` | a `hooks route` probe with the managed environment reports `embedder=minilm` |
| `mcpGovernance` | on; 120 calls per 60 s; audit on | 3.42.0 | `.harness/mcp-policy.json` + project-scoped `RUFLO_MCP_ENFORCE_POLICY=1` | policy file valid; variable present only where the file is valid; audit log activity |
| `learningProfile` | `balanced` | 3.42.1 | `RUFLO_INTELLIGENCE_MODE=balanced` | mode reported by `hooks intelligence stats`, plus learning-activity evidence |
| `turnCredit` | on | 3.36.0 | nothing (bundled) | `doctor -c metaharness` declared packages |
| `memoryFix2887` | on | 3.36.0 | nothing | `@claude-flow/memory` ≥ 3.0.0-alpha.22 resolvable from ruflo's tree |
| `funnel` | off | any ruflo that has `ruflo funnel` (detected, not assumed) | `ruflo funnel disable` | `ruflo funnel status` reports a user-tier disable |
| `encryptionAtRest` | on | — | ADR-0059 | ADR-0059 |

`kit.json` gains a `rufloComponents` block. Defaults hold the managed values above. Any value
may be changed; `false` means "ak does not manage this component". Turning a component to
`false` restores, by receipt, the value that existed before ak changed it, so off really is
off. `ak uninstall` undoes every receipted change.

```json
"rufloComponents": {
  "typesafePicker": true,
  "minilmPicker": true,
  "mcpGovernance": { "maxCallsPerMinute": 120 },
  "learningProfile": "balanced",
  "turnCredit": true,
  "memoryFix2887": true,
  "funnel": false
}
```

Setup and sync upgrade ruflo first when a managed component needs a newer version, using the
existing ruflo upgrade path.

### 2. States always travel with their meaning

Each component resolves to exactly one state. Every surface shows the state together with its
meaning and the action available; a bare label is never shown.

| State | Meaning shown to the user | Action |
|---|---|---|
| `active` | Applied and confirmed by ruflo's own evidence. | none |
| `applied, not verified` | Set, but not yet confirmed — usually the hosts have not restarted. | restart Claude Code, Codex and OpenCode |
| `needs ruflo ≥ X` | The installed ruflo is too old for this component. | `ak sync` upgrades ruflo |
| `not applied` | ak has not applied the managed value yet. | `ak sync` |
| `drifted` | Something changed a value ak set. | `ak sync` restores it, or set the component to `false` to keep yours |
| `user-managed` | You set your own value or opted out; ak reports it and leaves it alone. | none |
| `partial` | Applied for some hosts only; the ones missing are named. | shown per host |
| `blocked` | Applying failed; the reason is shown. | the specific next step |
| `unknown` | No current evidence, so ak does not claim the component is on. | `ak status` refreshes evidence |

A value ak finds already set by someone else is `user-managed`; ak never adopts or overwrites
it (ADR-0016 §4). Evidence older than its freshness bound downgrades to `unknown` instead of
staying `active`.

### 3. One owned environment projection for every host

A pure resolver, `componentEnv(projectRoot, cfg)`, returns the variables a project should
have. Every host projection calls it, so hosts cannot disagree. It includes
`RUFLO_MCP_ENFORCE_POLICY` only when that project's policy file is present and valid.

The projection engine is ADR-0055's `aqe-embedding-projection.mjs` generalized from one key
to a set of keys: per-file receipts with a pending guard, a preimage check before writing, a
backup copy, atomic writes, JSON and TOML editors, conflicts preserved rather than
overwritten, repository-root scoping for project targets, and one planning function shared by
inspection and reconciliation. AQE's embedding endpoint becomes one client of the engine and
keeps its behaviour and tests. The engine does not reuse `provider-ownership.mjs`, whose
sidecar receipts remain for provider variables.

Targets:

- **Claude Code.** Hooks and the ruflo MCP server inherit the `env` block of Claude settings.
  Machine-wide variables (pickers, learning profile) go in the user `~/.claude/settings.json`;
  the governance variable goes in the project's `.claude/settings.local.json`, next to its
  policy file. `replaceableRufloRegistration` (`src/lib/mcp.mjs`) learns to treat keys ak holds
  receipts for as ak-owned instead of user-owned. Verified 2026-09-23: Claude Code passes the
  settings `env` block to stdio MCP servers and hooks; the ruflo MCP registration is unchanged.
- **Codex.** The ruflo MCP server already starts through ak's launcher (`ak x ruflo-mcp` →
  `rufloMcpLaunch`), which knows the workspace; it adds `componentEnv(workspace)` at launch.
  Whether ruflo's Codex hooks receive variables ak sets could not be verified without changing
  Codex trust state (2026-09-23 spike); until upstream request 4 is answered, the pickers and
  learning profile report `partial` for Codex hooks when Codex is enabled.
- **OpenCode.** The generated gateway takes its environment from `componentEnv` instead of the
  fixed `RUFLO_MCP_ENV`. The lifecycle hooks template stops hardcoding only the memory pin and
  reads the generated environment. Both artifacts stay content-hash receipted.

The same change closes an ADR-0016 drift found by this work: the Claude memory pin written by
`pinProjectMemoryDbPath` (`src/commands/setup.mjs`) has no receipt and is never removed by
`ak uninstall`. It moves onto the engine and gains both.

Hosts read their environment at start-up, so changes take effect in the next session.
Components stay `applied, not verified` until ruflo's own check, run with the managed
environment, confirms them. Setup and sync end with a restart reminder when anything changed.

### 4. The typesafe package

`ak` installs `@ruvector/typesafe` globally with the shared reviewed install policy
(`globalInstallArgs`). It is a library with no binary, so the post-install proof is a module
resolution run from ruflo's install directory, followed by `doctor -c typesafe`. An install
receipt follows the agent-browser pattern; `ak uninstall` removes the package only when the
receipt exists. If a Node version switch drops the global, detection reports `not applied`
and the next sync reinstalls it.

### 5. MCP governance policy file

For each ruflo project ak manages (a git repository root containing `.claude-flow/`), ak writes
`.harness/mcp-policy.json`:

```json
{
  "_about": "Managed by agentic-kit (ADR-0058). Ruflo enforces auditLog and maxToolCallsPerTurn per rolling turnWindowMs.",
  "auditLog": true,
  "maxToolCallsPerTurn": 120,
  "turnWindowMs": 60000
}
```

The file is content-hash receipted. A hand-edited file is `user-managed` and preserved. Before
projecting `RUFLO_MCP_ENFORCE_POLICY`, ak parses the file; if it is missing or invalid, ak
removes the variable for that project and reports `blocked` ("policy file is invalid, so
ruflo would refuse every tool call"). A typo can therefore never lock a project out.

ak enforces only a policy file it wrote (its `_about` begins "Managed by agentic-kit"). A
project that already has its own `.harness/mcp-policy.json` — for example one generated by
MetaHarness or Agentic-QE — is reported `user-managed`, and ak does not turn on enforcement
for it.

### 6. Funnel

`ruflo funnel disable` writes ruflo's own user-tier state in `~/.ruflo`. ak runs it, confirms
with `ruflo funnel status`, and records that it did so. Undo runs `ruflo funnel enable` only if
ak's record exists and the status still shows the user-tier disable ak set.

### 7. Surfaces

The catalogue's `explain` text and the state meanings are written once and reused everywhere.

- **`ak setup`, before changes:** a "ruflo components" group in the existing trust disclosure
  (`setupTrustManifest`, `src/lib/trust-manifest.mjs`), modelled on the agent-browser group.
  For each component: the change, one line of benefit and cost, and how to opt out.
- **`ak setup`, after changes:** a results table (component, state, meaning) and the restart
  reminder.
- **`ak status`:** a `ruflo-components` section headed with the installed ruflo version, one
  row per component carrying state, meaning and fix.
- **`ak sync`:** repairs rows that carry a fix and reports the outcome in the same form.
- **Dashboard, Overview > Runtime:** a grouped "ruflo components" panel. The new status
  section lands there through `groups.mjs`. Each card shows the state badge beside its meaning,
  the current value, the options, who controls it, when and where the evidence came from, and
  live evidence:
  - pickers: `routedByCounts` for which picker chose recently;
  - governance: audited and refused calls in the last 24 hours and recent refusal reasons;
  - learning profile: engine loaded or not, time since last training, trajectory growth;
  - funnel: the deciding source.
- **Dashboard, About:** a summary chip on the ruflo card ("ruflo components: 6 of 8 active")
  linking to the panel.

The dashboard stays read-only: it names the command or `kit.json` change instead of acting.

### 8. Upstream requests

Tracked under ADR-0031 and shown as "waiting on upstream" where relevant:

1. `ruflo doctor --json`, so ak can stop parsing text.
2. A configurable, per-project, rotated MCP audit log (today: one shared file in the temp
   directory whose path can only be changed in tests).
3. `doctor` components for the MiniLM picker and MCP governance.
4. A supported way to give ruflo's Codex hooks environment variables, if the plan confirms
   the gap.
5. Encryption for the AgentDB store (ADR-0059).

## Consequences

- Users get every managed component without reading release notes, and can see, per component,
  what it does, whether it is really working, and how to change it.
- Each new ruflo component costs one descriptor and its tests.
- ak takes on the risk of enabling opt-in upstream features, including two pickers ruflo has
  not yet made default. The mitigation is evidence: which picker chose is visible, and each
  component opts out with one `kit.json` value.
- Governance adds a small tracked file to each ruflo repository. Committing it is the user's
  choice; ak does not commit.
- The audit log sits outside ADR-0059's encrypted storage until upstream request 2 lands. It
  holds metadata only (tool names and decisions, no arguments).
- Parsing `doctor` text is brittle. Unreadable output degrades to `unknown`, and fixtures pin
  each supported ruflo version.

## Verification

- **Unit:** catalogue validation; `componentEnv`, including "no governance variable without a
  valid policy file"; state classification for every state; `doctor` parsing against captured
  3.43.0 and 3.44.0 output; multi-key projection engine planning, conflict preservation, and
  exact, repeatable undo; AQE's existing projection tests unchanged and passing.
- **Hermetic:** every test uses a temporary home and project with the existing real-config
  tripwire.
- **Real machine, disposable project:** install typesafe into an isolated npm prefix and run
  the real `doctor -c typesafe`; run a real `hooks route` with the managed environment and
  check which picker chose; with enforcement and a policy file, make a real MCP call and see an
  audit record; without the file, see the refusal.
- **Hosts:** snapshots of Claude settings, the Codex launcher environment and OpenCode
  generated artifacts.
- **Dashboard:** the existing UI suite plus a browser check of the panel and chip.

## Implementation status

| Piece | Status |
|---|---|
| Spike: environment reach per host | Done (2026-09-23) |
| Component catalogue and states | Not started |
| Multi-key owned projection engine (from ADR-0055) | Not started |
| Host projections (Claude, Codex launcher, OpenCode) | Not started |
| Typesafe package install and receipt | Not started |
| Governance policy file and lockout guard | Not started |
| Funnel disable and undo | Not started |
| Setup disclosure and results, status section, sync | Not started |
| Dashboard panel and About chip | Not started |
| Memory pin receipt (ADR-0016 drift) | Not started |
| Upstream requests filed | Not started |
