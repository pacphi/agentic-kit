# Host-neutral hook healing validation — 2026-09-02

## Outcome

The host-neutral hook audit now has a deliberately narrow healing companion. `ak heal
hooks` is dry-run by default and can mutate only an exact, previewed, content-bound action
after the operator repeats the action id and plan digest with `--apply --yes`. The same
authorization model applies to undo and interrupted-transaction recovery.

Executable healing is limited to verified Codex 0.151.0 and Claude Code 2.1.258
user-owned canonical JSON `SessionEnd` timeout normalization on POSIX. OpenCode 1.18.25,
external adapters, unknown or future versions, generated/plugin caches, JSONC, TOML,
noncanonical JSON, Windows replacement, trust state and executable plugin modules remain
observable but non-executable. No cache edit, trust bypass or optimistic future-version
inheritance is permitted.

## Assurance boundary

Each preview binds the selected action to the source bytes, metadata, provider profile and
complete deterministic plan. Apply repeats the audit and plan, checks exact equality,
validates the target and parent identity, creates a private durable transaction journal,
writes and syncs exact backups, uses same-directory atomic replacement, re-audits the
result and records a committed receipt. A later mismatch stops before mutation.

Rollback is conditional: undo refuses to overwrite later user changes, and explicit
recovery first validates every target and backup before restoring any target. A missing,
malformed or unfinished journal blocks a new apply as recovery-required. Multi-target
apply uses compensating rollback; it is not presented as globally atomic.

The receipt digest detects accidental or unsophisticated tampering but is not a signature
or an authenticity claim. User-space realpath and inode checks narrow path races but cannot
eliminate a malicious same-user directory race without native directory-fd operations.

## Mechanical verification

- `npm run typecheck`: pass.
- `npm run lint`: pass with warnings only; no errors.
- `npm run lint:cc`: pass; the two reported file-length warnings predate this change.
- `npm run lint:md`: pass across 80 Markdown files.
- `npm run build`: pass, including syntax checks for 266 shipped files and a 300-file
  package inspection.
- `npm test`: pass with exit code 0 in the repository's loopback-enabled test environment.
- Focused Node suite: 90 tests passed, 0 failed.
- Measured focused coverage for the new remediation boundary: `engine.mjs` 87.22% line,
  `fs-port.mjs` 88.39%, `planner.mjs` 98.36% and `store.mjs` 86.85%. The same run measured
  `hook-audit` files from 85.96% to 100% line coverage and `integrity.mjs` at 83.81%.
- `git diff --check`: pass.

The adversarial fixtures exercise stale plans, action substitution, duplicate actions,
candidate tampering, source replacement, profile drift, noncanonical JSON, special/symlink
paths, transaction-root permissions, missing and corrupt journals, backup tampering,
partial failure, conditional undo, interrupted recovery, exact metadata restoration,
Windows non-executability and a second-run no-op proof.

## Agentic-QE review

The real Agentic-QE fleet was used after implementation:

- Defect prediction found no file above its defect threshold (`riskScore: 0`).
- Narrow SAST scans found zero findings in `hook-remediation`, `adapters/integrity.mjs`
  and `adapters/admission.mjs`.
- The hook-audit scan produced three lexical false positives: `RegExp.exec()` was labeled
  dynamic execution, and two static `../` import specifiers were labeled runtime path
  traversal. Inspection confirmed that none is an executable evaluation or user-controlled
  traversal site.
- The repository-wide scan also matched longstanding command names, test fixtures and
  secret-detector test strings. It is retained as triage input, not asserted as 813 real
  vulnerabilities.
- AQE coverage analysis explicitly reported `static-estimation`, `measured: false` and
  confidence 0.2. Its approximately 20% estimate was therefore rejected as coverage
  evidence in favor of Node's instrumented results above.
- AQE's aggregate quality gate returned 18/block because it consumed the same static
  estimate and repository-wide complexity. This is recorded as an unresolved aggregate
  gate, not silently relabeled as a pass; the focused mechanical oracle is green.
- AI-enhanced test generation was denied because it could transmit private source to an
  external model service. No workaround or indirect export was attempted.
- AQE's parallel test executor returned per-file `failed` statuses while simultaneously
  reporting `failed: 0`; that contradictory synthetic receipt is excluded from acceptance
  evidence. The directly executed Node suite is the test oracle.

## Upstream lifecycle

`config/agentic-dependency-constraints.json` is schema-versioned and separates registry
validity, evidence freshness and installed-version applicability. Entries require unique
ids, valid dependency references, semantic verification dates and canonical GitHub issue
URLs; future verification dates are invalid rather than fresh.

Issue payloads remain drafts. No upstream issue was published because publication is an
external side effect and no separate approval was granted. Workarounds have objective
sunset evidence and remain local until a released upstream artifact is independently
verified.

## Review limitations

The Ruflo swarm completed architecture, compatibility and QE-design reviews. Claude Code
was unavailable because the local host required login, so the cross-host participant check
is degraded and must not be described as independent dual-host acceptance. OpenCode
ownership evidence remains conservative at document level, which can over-prohibit a
repair but cannot authorize an unsafe one.

See [the operator guide](../HOOKS.md),
[ADR-0041](../adr/0041-host-neutral-hook-configuration-assurance.md) and the
[DDD boundary](../ddd/hook-configuration-assurance.md) for the lasting contracts.
