# ADR-0041 — Host-neutral hook configuration assurance

- **Status:** Accepted; transactional Wave 2 implemented
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

The initial profiles are Codex CLI `0.151.0`, Claude Code `2.1.258` and OpenCode
`1.18.25`. The profile registry is updated only after source or authoritative docs and
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
`0.151.0` and Claude Code `2.1.258` profiles. The writer never approves or bypasses
host trust.

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

## Consequences

### Positive

- One command exposes the same evidence model across built-in and external hosts.
- Host-specific semantics remain visible instead of being flattened into Codex JSON.
- Releases fail safely into syntax-only/partial coverage.
- Generated dependency defects have a durable notification, workaround and sunset path.
- No audit path executes hooks, changes trust, imports plugins or fetches remote manifests.

### Negative

- Partial coverage is expected for runtime-only and organization-controlled state.
- OpenCode modules remain opaque without execution, and JSONC remains unnormalized.
- Exact profiles require maintenance when hosts release.
- External adapter compatibility cannot be complete until its versioned contract grows a
  target-host range.
- A same-user receipt digest is integrity evidence, not third-party authenticity.
- Windows healing remains a visible non-executable plan until atomic replacement is proven.

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
- deterministic public plans with content-bound private candidates;
- explicit `ak heal hooks` apply, undo and interrupted-transaction recovery;
- private backups, strict durability ordering, atomic replacement, guarded rollback,
  re-audit and idempotency proof;
- plan and receipt schemas plus tamper, drift, partial-failure and platform refusal tests;
- bounded real-path-confined external adapter hook-file hashing.

Still deferred:

- host trust inspection or mutation;
- JSONC normalization;
- network retrieval of remote adapter manifests;
- automatic upstream issue creation;
- external adapter target-version declarations.
