# Agentic Environment Review Method

Status: baseline method v1.0
Last exercised: 2026-08-31 (America/Los_Angeles)
Companion baseline: `2026-08-31-agentic-environment-review.md`

## Purpose

This procedure produces a repeatable, evidence-grounded health check of a multi-host
agentic development environment. Its design objective is monotonic simplification:
each audit should reduce permanent context, duplicate assets, mutable executable
configuration, and ambiguous ownership unless measured evidence justifies them.

The audit is host-aware. Claude Code, Codex, Gemini CLI, OpenCode, Hermes Agent, and
GitHub Copilot do not share one configuration or precedence model. Portable artifacts
are treated as portable only where each host's current documentation says they are.

## Evidence contract

Every claim and recommendation receives one or more evidence labels:

- **MEASURED (`M`)** — observed from a local file, client command, session store,
  version response, hash, permission mode, or repeatable behavioral measurement.
- **DOCUMENTED (`D`)** — supported by a dated primary source: official documentation,
  release notes, source repository, or a tool's own schema/help text.
- **HYPOTHESIS (`H`)** — a causal interpretation. It is never promoted to fact without
  the validation named beside it.

Record command time, local timezone, exit status, client version, and source URL.
When local behavior and documentation disagree, preserve both observations and mark
the conflict. Do not silently choose the more convenient account.

## Safety and redaction

The default mode is read-only:

1. Do not install, update, enable, disable, sync, migrate, initialize, authenticate,
   accept trust, or start a daemon.
2. Do not invoke commands whose documented behavior mutates configuration. Prefer
   `--help`, `--version`, `doctor`, `debug`, `list`, and direct file inspection.
3. Inspect credential-bearing files only for key names, value type, length, reference
   syntax, and mode. Never include values in logs, inventories, or reports.
4. Omit MCP environment values. Record only variable names, executable, arguments,
   transport, enablement, and scope.
5. Hash reusable text assets to establish identity without copying their contents into
   the inventory.
6. Record any accidental side effect. During the 2026-08-31 baseline,
   `gemini --list-sessions` initiated OAuth and updated client-managed project metadata;
   the command is therefore excluded from future unattended read-only runs.

Before publishing, scan every output for known token formats and exact secret values
read from local configuration. A report fails closed if this check is inconclusive.
The record-level inventory is private by default: publish aggregate findings unless the
owner explicitly approves disclosure of project paths, activity metadata, MCP commands,
and installed capability topology.

## Phase 1 — Discover clients from themselves

Use `command -v`, then the installed client's own version, help, doctor, debug, path,
plugin, MCP, extension, skill, session, and model commands. Do not start with assumed
home directories.

Minimum evidence per host:

| Host | Required local evidence |
|---|---|
| Claude Code | executable, version/doctor, settings scopes, effective model, plugins, MCP, trust/session roots |
| Codex | executable, version/doctor JSON, `CODEX_HOME`, effective model/reasoning, features, plugins, MCP, auth storage mode |
| OpenCode | executable, version, `debug paths`, `debug info`, resolved config, plugins, providers/models, session database |
| Gemini CLI | executable, version/help, settings, skill/extension/MCP lists, trust state, project-history locations without authentication |
| Hermes Agent | executable/package presence, version, config/state path from official docs, plugin/MCP surfaces |
| GitHub Copilot | CLI presence/version, editor extensions, `gh` extension presence, instruction/agent/skill surfaces |

Also record package managers and runtime paths. A package-manager version and the
version first on `PATH` are separate facts; disagreement is drift, not an averaging
opportunity.

## Phase 2 — Verify current upstream state

For every installed client, retrieve the current official release and publication date
from the vendor's release repository or official release notes. Compare exact installed
and current versions; do not infer staleness from memory.

For behavior and precedence, prefer current official documentation. For technical
research, use primary sources. Record:

- source URL and retrieval date;
- documented version, if scoped;
- whether the statement is normative documentation or an engineering practice article;
- any version boundary that could invalidate the conclusion.

## Phase 3 — Recover the real project population

Build the union of projects recorded by every available session/history store, not just
the current directory:

1. Parse host-native session metadata for working directories.
2. Resolve symlinks and normalize paths.
3. Retain vanished paths in `everSeen`; do not count them as measurable on-disk roots.
4. For surviving paths, resolve Git common directory/worktree identity and collapse
   nested working directories into one repository identity while retaining every
   observed directory as a presence record.
5. Recover hash-only paths only from client-maintained mappings or other direct local
   evidence. Do not guess from repository names.
6. Publish completeness per host. A missing/unreadable store makes a count a lower
   bound, never zero.

The baseline native collector covers Claude, Codex, and OpenCode. Gemini requires a
supplemental collector; Hermes and Copilot histories were unavailable. This limitation
must stay visible until the collector is expanded.

## Phase 4 — Build the canonical inventory

Inventory active user surfaces, installed plugin roots, and surviving project surfaces.
Exclude session transcripts, build output, dependency directories, dormant marketplace
checkouts, and test fixtures unless they are themselves the artifact under review.

Each record contains:

```text
host/client | version | scope | artifact type | path | provenance
upstream source/version | local modifications | applicable models
overlapping/overriding artifacts | content hash | notes
```

Artifact classes are skills, commands, agents, instruction/rule files, plugins,
MCP/tool configuration, MCP server registrations, host configuration, and reusable
prompt assets.

Keep two simultaneous views:

- **Native catalog** — the names and counts each host/collector exposes.
- **Filesystem catalog** — active artifact presences and hashes.

Join identical names across scopes into overlap groups and count content variants.
Same-name/different-hash is version or semantic drift; same-hash/many-path is redundant
deployment. Neither is automatically wrong, but both require an owner and a reason.

## Phase 5 — Review in precedence order

For each host, reconstruct its documented instruction and configuration precedence.
Then inspect:

1. permanent global context before project context;
2. project roots before nested just-in-time rules;
3. native capabilities before plugin workarounds;
4. deterministic controls (permissions, hooks, tests, policy) before prose;
5. executable configuration for credentials, unpinned packages/images, broad shell
   allowances, and stale trust entries;
6. marketplace installations against upstream manifests and clean worktrees;
7. behavior telemetry against the configuration that could plausibly cause it.

Correlation is not causation. For example, high startup tokens plus a large global
instruction file supports an ablation test; it does not prove that file caused all
token use.

Every material finding uses this fixed record:

```text
EVIDENCE — exact path/behavior and M/D/H labels
WHY IT MATTERS — expected behavioral effect
DIAGNOSIS — root cause
ACTION — KEEP/TUNE/MOVE/CONSOLIDATE/REPLACE/DELETE/UPSTREAM
SCOPE — global/host/project
CONFIDENCE — high/medium/experimental
VALIDATION — smallest falsifiable test
```

## Phase 6 — Compare with the prior snapshot

The first audit is a baseline. On later runs compare:

- client, model, plugin, MCP, and package versions;
- config and instruction hashes;
- new/deleted/moved artifacts and overlap variants;
- project population and collector completeness;
- security posture and permission/trust entries;
- fixed eval outcomes and cost/behavior metrics.

Do not treat a partial operational snapshot as a prior completed audit. Compare only
fields with equal definitions and complete collection status.

## Phase 7 — Run a small regression suite

Use 15–25 tasks sampled from real repositories, with a 6–8 task smoke subset. Freeze
the fixture commit, configuration hash, permissions, tool schema, and resource limits.

Score separate dimensions:

- deterministic correctness: tests, build, static checks, and required diff;
- instruction adherence and prohibited actions;
- tool calls, unnecessary calls, retries, and ordering;
- startup and total tokens;
- recovery after a failing test or unavailable tool;
- human interventions, review defects, and review minutes;
- harness/infrastructure failure versus model failure.

Run one trial for deterministic smoke checks and three trials for noisy or autonomy
cases. Change one scaffold variable at a time. Keep raw event logs and grader outputs;
never preserve only a composite score.

## Phase 8 — Patch without accumulating policy

Order fixes by leverage and reversibility:

1. rotate/externalize credentials;
2. remove mutable executable dependencies and narrow permissions;
3. delete contradictory or corrupt guidance;
4. consolidate identical assets at their source and regenerate projections;
5. move rare workflows from permanent context into on-demand skills;
6. add deterministic validation only where a measured failure remains.

For user-owned changes, draft minimal diffs without applying them. For third-party
changes classify: safe local override, local patch, fork, upstream issue, or upstream
PR. State rollback and the exact test required before the next patch.

## Exit criteria

An audit is complete only when:

- versions and release dates are current as of the audit date;
- every session source has a completeness statement;
- every on-disk project identity has project coaching or an explicit no-finding entry;
- the inventory and overlap indexes validate structurally;
- every material recommendation has evidence, scope, confidence, and a test;
- outputs contain no credential values;
- no environment/configuration file was modified without approval;
- the new snapshot is suitable as the next run's baseline.
