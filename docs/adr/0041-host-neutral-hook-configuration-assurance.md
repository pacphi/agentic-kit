# ADR-0041 — Host-neutral hook configuration assurance

- **Status:** Accepted; static assurance, transactional healing, bounded receipts, and read model implemented
- **Date:** 2026-09-01
- **Updated:** 2026-09-02
- **Deciders:** agentic-kit maintainers
- **Extends:** [ADR-0040](0040-codex-hook-audit-and-conservative-remediation.md)
- **Related:** [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0029](0029-host-adapter-extension-point.md),
  [ADR-0031](0031-capability-graduation-and-upstream-requests.md),
  [ADR-0032](0032-model-lifecycle-intelligence.md)
- **DDD:** [Hook configuration assurance](../ddd/hook-configuration-assurance.md)
- **Evidence:** [Host-neutral follow-up](../audits/host-neutral-hooks-follow-up-2026-09-01.md)

## Context

ADR-0040 proved the Codex problem but left the abstraction named and shaped around one
host. Claude Code composes settings, managed policy and plugin hook documents. Codex
composes JSON, inline TOML, managed policy and plugin sources, then applies independent
definition trust. OpenCode loads configuration and full-process plugins rather than a
settings-hook document. External agentic-kit host adapters declare subprocess hooks in
validated manifests and require separate consent and capability grants.

Treating these as one file format would lose the differences that matter. Treating them
as unrelated would repeat the original timeout-unit, generated-copy and provenance
failures for every new host. Releases also change schemas and lifecycle events, while
Ruflo, Agentic-QE, RuvNet Brain and other managed dependencies can require bounded local
workarounds until an upstream issue is released and proven.

## Decision

### 1. One bounded context, multiple evidence providers

Hook configuration assurance owns a normalized read model and remediation proposals. It
consumes host identity and admitted adapter manifests from Integration Management, but
it is not a host lifecycle adapter, execution runner, plugin runtime or trust authority.

Built-in providers are registered for `codex`, `claude`, `opencode` and `external`.
`ak audit hooks` keeps Codex as its compatibility default; repeatable `--host` selects a
provider and `--host all` runs the complete registry. Every provider returns sources,
occurrences, diagnostics, coverage gaps and proposals without executing hook code.

### 2. Effective state is never guessed

Every report states `complete`, `partial` or `unsupported` coverage. Static discovery may
record a selected state only when the inspected layers prove it. Trust hashes, project
trust, organization policy, environment overrides, runtime reachability, consent and
capability grants remain independent facts. Unknown effective selection is `null`, not
`true`.

OpenCode plugin modules are hashed and inspected as text but never imported. JSONC is
reported as an opaque later layer rather than rewritten or weakly parsed. Remote adapter
manifests are reported but never fetched by the default offline audit.

### 3. Behavior identity includes every material execution field

The behavior fingerprint includes host, event, matcher, handler type, command identity,
Windows command, MCP server/tool/input contract, asynchronous mode, context limit,
status message, timeout and effective working directory. Occurrences from different
working directories are not deduplicated merely because their command strings match.
Public reports redact credential-shaped command assignments and retain only the original
command digest for identity.

### 4. Version profiles are exact and evidence-bearing

Profiles name the exact locally verified host versions and a primary documentation
source. Unknown versions receive syntax-only validation and no automatic compatibility
repair. A newer version does not inherit a prior profile by optimistic range matching.

The verified profiles are Codex CLI `0.151.0` and `0.152.1`, Claude Code `2.1.258`, and
OpenCode `1.18.25`. Codex `0.152.1` adds the `Interrupt` event; both `SessionEnd` and
`Interrupt` default to one second and clamp at three seconds. The profile registry is
updated only after source or authoritative docs and
fixtures agree. Host releases trigger the conformance suite before widening a range or
adding a new exact profile.

### 5. Remediation authority has four classes and an explicit writer

- `safe-automatic`: proven agentic-kit ownership, exact schema, semantics-preserving
  change and matching preimage.
- `approval-required`: user/project sources or any behavioral change.
- `upstream-required`: generated dependency behavior whose authoritative repair belongs
  in the producing project.
- `never-automatic`: trust bypasses, generated/cache targets, unsafe files, unknown
  schemas, opaque modules or unproven canonical ownership.

`ak heal hooks` is dry-run by default. Apply requires the exact displayed action IDs,
the exact plan digest, `--apply`, and `--yes`. Only compiled `safe-automatic` and
`approval-required` recipes can reach the mutation port. The first recipes normalize
the already-clamped `SessionEnd` timeout in canonical user-owned JSON for exact Codex
`0.151.0`/`0.152.1` and Claude Code `2.1.258` profiles. An approval-required Codex
`0.152.1` recipe also retires only an exact allowlist of legacy Ruflo Claude-helper
projections from canonical project JSON when the selected `ruflo-core@ruflo` plugin is
present. It preserves unrelated and AutoMemory hooks and refuses near-matches, ambiguous
helper occurrences, and noncanonical files. The writer never approves or bypasses host
trust.

Those exact Codex profiles also support one user-owned TOML recipe for the verified
`codex@openai-codex` 1.0.6 placement error. The package is Claude Code's companion for invoking
Codex, not a Codex-host plugin; that policy is bound to OpenAI's signed 1.0.6 release
revision `db52e28f4d9ded852ab3942cea316258ae4ef346`. The recipe replaces only its unambiguous
`enabled = true` scalar with `false`; it preserves all sibling bytes and never changes
the installed package, plugin cache, Claude Code enablement, or trust state. Table-shaped
multiline-string content is ignored. Malformed TOML, duplicate tables or assignments,
unverified versions, symlink-managed or otherwise unsafe files, and Windows fail closed
to a visible non-executable action.

The retirement is behavior-changing: the selected Ruflo plugin is evidence for the
lifecycle events it actually covers, not a feature-for-feature replacement for removed
session-start, prompt-routing, or subagent side effects. Removing an earlier handler can
also shift retained handler indexes, so Codex may require definition re-review. Both
impacts are bound into the preview and receipt.

### 5a. The mutation port is transactional and recovery is explicit

Before writing, the engine re-audits, rebuilds the plan, verifies exact versions and
profiles, and checks digest, size, mode, owner, special bits, parent inode and containment
for every selected target. It creates private transaction-specific backups, persists a
state journal, uses same-directory atomic replacement, re-audits the result, and proves a
second plan plus third no-op pass. A multi-target failure conditionally restores only
targets whose bytes still equal the recorded postimage.

`--undo RECEIPT` is for committed transactions. `--recover RECEIPT` is a separate,
explicit path for interrupted journals; both are dry-run first and validate every target
and backup before writing. Receipt hashes detect accidental corruption and unsealed
editing, but they are not signatures or an authenticity boundary against the same user.
Filesystem durability requires file and directory `fsync`; a failure is reported rather
than silently called committed. Mutation is currently supported on POSIX. Windows retains
the complete audit and plan, but replacement stays non-executable until replace-existing
atomicity has a proven platform port.

### 6. External adapters stay declarative and independently authorized

Local external manifests are validated through the existing adapter contract and their
declared hook files are content-hashed through bounded descriptor reads with real-path,
inode and path rechecks. Contract pins, host identity and built-in shadowing are refused
before a normalized occurrence exists. The audit does not import adapter code, admit the
adapter, grant capabilities or run a hook. Because the current contract does not declare
a target host-version compatibility range, every external hook carries an explicit
human-review proposal until a later contract version adds and validates that evidence.

### 7. Upstream constraints are lifecycle data

`config/agentic-dependency-constraints.json` records dependency, affected versions,
primary issue, independently tracked issue state, bounded strategy, verification date
and an objective sunset condition. It is not a grant store and never authorizes a patch.

Registry validity, evidence freshness and installed-version applicability are distinct
fields. Constraints are rechecked weekly, before a managed upgrade, and when host/dependency
release automation observes a new version. A workaround is removed only after a released
artifact passes the relevant host-neutral audit and conformance tests. Issue closure alone
does not prove a fix; an open issue does not by itself prove the installed version is
affected.

### 8. Runtime receipts are sibling evidence, not static audit proof

The supervised external-adapter hook runner now returns a bounded receipt for every process-level
outcome. It records host, verb, effective timeout, monotonic duration, exit code, typed outcome,
timeout state, captured stdout/stderr byte counts, and truncation state. Duration is capped at 24
hours. Each byte count saturates at 262,145 bytes—one byte above the 256 KiB capture ceiling—so a
consumer can distinguish overflow without retaining an attacker-controlled unbounded count.

The outcome vocabulary is `success`, `nonzero-exit`, `signal-exit`, `spawn-failed`, `timed-out`,
and `integrity-rejected`. It does not claim that native Claude, Codex or OpenCode hooks emitted a
runtime outcome: their host processes do not currently feed this receipt stream. A static `Stop`
occurrence is configured evidence; a timeout receipt is execution evidence. Neither substitutes
for the other.

`buildHookDashboardReadModel` may join a static audit with those typed receipts, but it strips
commands, source paths, stdout/stderr, failure detail, diagnostic prose and messages. Labels are
control-stripped and capped at 64 characters; runtime input is capped to the last 1,000 receipts
and the recent list to 50. Dashboard Delivery exposes that model through authenticated, no-store
`/api/hooks?host=all`, collected lazily only when the Hooks view opens. The server reuses one
30-second bounded cache and one in-flight collection. The default collector supplies the static
audit only; runtime remains `not-recorded` unless the dashboard process is explicitly given a
bounded receipt source. Durable native-host receipt storage is still a separate decision.

### 9. Exact Agentic-QE Stop risks are upstream-only

Claude audit recognizes an Agentic-QE runner only when bounded source inspection proves all three
parts of the generated shape: the AQE hook command, both local bundle candidates, and the exact
`npx -y --prefer-offline agentic-qe hooks` fallback. It emits
`aqe-npx-hot-path-fallback` only when both local candidates are absent. It emits
`aqe-claude-timeout-unit-mismatch` only for the exact verified Claude Code `2.1.258` seconds
profile and millisecond-shaped AQE timeout values.

Both actions are always `upstream-required`, name `proffesor-for-testing/agentic-qe`, and require
explicit user approval before issue publication. A modified helper, refused path, unknown host
version or ambiguous local bundle state produces no ownership inference. Agentic-kit does not
rewrite the generated project settings, generated helper or plugin cache.

## Consequences

### Positive

- One command exposes the same evidence model across built-in and external hosts.
- Host-specific semantics remain visible instead of being flattened into Codex JSON.
- Releases fail safely into syntax-only/partial coverage.
- Generated dependency defects have a durable notification, workaround and sunset path.
- No audit path executes hooks, changes trust, imports plugins or fetches remote manifests.
- Supervised adapter executions now produce finite, typed, output-bounded receipts suitable for a
  sanitized read model.
- Exact AQE generator defects are actionable without turning their generated copies into
  agentic-kit write authority.

### Negative

- Partial coverage is expected for runtime-only and organization-controlled state.
- OpenCode modules remain opaque without execution, and JSONC remains unnormalized.
- Exact profiles require maintenance when hosts release.
- External adapter compatibility cannot be complete until its versioned contract grows a
  target-host range.
- A same-user receipt digest is integrity evidence, not third-party authenticity.
- Windows healing remains a visible non-executable plan until atomic replacement is proven.
- Native-host runtime outcomes remain `not-recorded`; only supervised external-adapter hook
  executions currently produce the bounded receipt contract.
- The dashboard route is observation-only and cached in memory for 30 seconds; it is not a durable
  event store or a native-host receipt collector.

## Implementation status

Implemented in this decision:

- provider registry and host-neutral orchestrator;
- Claude, Codex, OpenCode and external manifest discovery;
- Codex inline TOML and inline plugin-hook discovery;
- material-field fingerprints, source containment, size bounds and command redaction;
- explicit provider coverage gaps;
- upstream constraint registry;
- repeatable `--host` and `--host all` CLI selection;
- adversarial cross-host fixtures and read-only tests.
- post-open inode/path verification for every bounded source read;
- Claude optional-manifest plugin provenance and host-specific `SessionEnd` budget rules.
- exact Codex `0.152.1` event/timeout semantics and legacy Ruflo projection diagnostics;
- approval-required, per-project legacy Ruflo retirement with selected-plugin evidence;
- exact-identity Claude companion placement detection and approval-required Codex-only disablement;
- deterministic public plans with content-bound private candidates;
- explicit `ak heal hooks` apply, undo and interrupted-transaction recovery;
- private backups, strict durability ordering, atomic replacement, guarded rollback,
  re-audit and idempotency proof;
- plan and receipt schemas plus tamper, drift, partial-failure and platform refusal tests;
- bounded real-path-confined external adapter hook-file hashing.
- bounded external-adapter execution receipts with stable outcomes, duration, byte counts,
  truncation and timeout state;
- a sanitized static-plus-runtime Hook read-model seam;
- authenticated, lazy, no-store Hooks dashboard delivery with a bounded cache, single-flight
  collection, and explicit unknown runtime state;
- exact AQE `npx` hot-path and Claude timeout-unit diagnostics with upstream-only proposals;
- negative ownership tests proving generated and cache findings never become automatic.

Still deferred:

- host trust inspection or mutation;
- JSONC normalization;
- network retrieval of remote adapter manifests;
- automatic upstream issue creation;
- external adapter target-version declarations.
- durable native-host hook outcome acquisition and receipt retention.
