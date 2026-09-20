# Fleet evidence export implementation plan

**Goal:** A documented, private, versioned fleet data contract with working export, validation and aggregation.

**Architecture:** Telemetry is an application read model over Usage and retained Maintenance evidence.
Pure projection/admission/reduction modules are separate from local file access and CLI dispatch.
No runtime dependency or remote service is added.

**Spec:** [ADR-0054](../adr/0054-fleet-evidence-export.md).

## Ownership and authority

Root is the only writer in the isolated `feat/fleet-evidence-export` worktree. Research/review
workers are read-only. User authorization covers local branch, architecture, documentation,
implementation and tests. No commit, push, merge or publication is authorized.
Ruflo policy receipt: `sha256:e21b09352327083b5d4b154805efb12db33692905cff727746fbf9da3115e070`
(legacy-default-allow; not an independent security assurance).

## Execution gates

- [x] Contract: write failing `tests/kit/telemetry-contract.test.mjs`; implement `schema.mjs`,
  `contract.mjs` and `projection.mjs`. Verify hostile field exclusion, null evidence and digest checks.
- [x] Reducer: write failing `tests/kit/telemetry-aggregate.test.mjs`; implement `aggregate.mjs`.
  Verify replay, permutation, replacement, conflict and weighted arithmetic against fixed fixtures.
- [x] I/O and CLI: write failing `tests/kit/telemetry-cli.test.mjs`; implement `store.mjs`,
  `collect.mjs`, `src/commands/telemetry.mjs`, path helper and dispatch entry. Verify bounded reads,
  private stable identity, no-clobber file writes and hermetic end-to-end commands.
- [x] Document: publish `docs/TELEMETRY.md`, metric semantics, schema discovery, examples,
  operational/privacy limits; amend relevant ADR cross-references and package documentation list.
- [x] Validate: focused tests, independent review, typecheck, lint, markdown, build and full tests.
  Bind evidence to source digest, report failures/limitations, update ADR status and this checklist.

## Acceptance

`ak telemetry export` yields a validated snapshot; repeated exports preserve installation identity.
`ak telemetry schema` provides JSON Schema; `validate FILE` rejects malformed/unsupported records.
`aggregate FILE...` gives deterministic fleet totals without duplicate exports inflating counters.
Exported objects contain no copied arbitrary source strings. Missing sections remain unavailable.
No command starts a server, submits remote telemetry, executes a maintenance change or exposes keys.

## Verification receipt

See [source-bound local results](fleet-evidence-export-verification.json). Native Node tests are
authoritative for this run; the AQE executor returned inconsistent evidence and is not counted as
a successful quality gate. No overall repository quality score is claimed.
