# ADR-0022 — MetaHarness as an optional assurance companion

- **Status:** Proposed
- **Date:** 2026-08-04
- **Updated:** 2026-08-04
- **Update note:** Recorded the documentation-only PR #112 merge and topic-branch removal; no
  implementation is authorized or claimed.
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0018](0018-generalized-host-worker-execution.md),
  [ADR-0020](0020-ga-stable-surfaces.md)
- **Product proposal:**
  [MetaHarness as an Optional Assurance Companion](../METAHARNESS-COMPANION-PROPOSAL.md)
- **Replaces:** the direction, but not the ADR number, in the unpublished branch-only
  `ADR-0016 — Curate retrieval improvement while Ruflo retains promotion authority`; its
  retrieval-improvement DDD is retired rather than ported

## Context

Agentic-kit installs, configures, heals, observes, and executes a multi-host agent stack. Its
canonical `ak run` command materializes explicit per-activity routing and supervises worker
readiness, deadlines, escalation, cancellation, and cleanup. ADR-0020 deliberately reduced the GA
surface to one execution command and one host-management namespace.

MetaHarness offers a different value: a deterministic control plane and factory for agent
harnesses, with static repository scoring, policy and MCP auditing, receipts, red/blue testing,
cost-quality learning, and Darwin evolution. Its worker interface is a function; it does not
currently provide an adapter that invokes `ak run` as a subprocess and maps its evidence.

Ruflo also exposes commands under the MetaHarness name and has shipped a retrieval-flywheel
integration in specific releases. Ruflo's CLI surface and flywheel state are not the standalone
MetaHarness harness. In a flywheel workflow, Ruflo—not agentic-kit—owns receipt validation, ledger
state, active champion, and promotion.

The earlier branch-only proposal recommended a full `ak improve` lifecycle around Ruflo's retrieval
flywheel. It preserved several correct safety properties, but it conflated the standalone
MetaHarness product, Ruflo's integration, and agentic-kit's lifecycle. It also proposed new command,
configuration, and signing-key ownership before proving a stable interop contract or repeated user
need. Its ADR number now collides with the accepted ADR-0016 on `main`.

An alternative is to place MetaHarness around agentic-kit: treat a complete `ak run` pipeline as a
candidate worker, evaluate it using an external task/verifier suite, and feed the evidence back as
advice. This preserves separation of concerns, but needs a safe machine contract. The current
`ak run --json` payload is machine-readable `{plan, results}` without an explicit top-level schema
version or a companion-specific redaction and stability contract.

## Decision

### 1. Make the external companion the primary integration model

MetaHarness is optional development and assurance tooling around agentic-kit. It may:

- statically assess whether a generated harness fits the repository;
- audit bounded MCP/tool policy in read-only or dry-run mode;
- invoke a complete `ak run` through a dedicated adapter;
- score held-out outcome quality, safety, latency, and cost;
- compare agentic-kit versions, templates, or routing policies;
- produce receipts and advisory cost-quality recommendations;
- red/blue an authorized, isolated LLM/tool surface;
- evolve only its own approved harness-policy surfaces.

Agentic-kit remains fully functional when MetaHarness is absent.

### 2. Keep execution and lifecycle authority in agentic-kit

The companion treats one complete `ak run` as the initial worker boundary. It does not reschedule
the internal DAG or replace readiness, preparation, launch, observation, timeout, escalation,
cancellation, or cleanup.

MetaHarness does not install or manage hosts/providers, write configuration projections, edit
`kit.json`, change routes, infer provider identity, manage user subscriptions, or own project
memory. Any route recommendation is evidence only. The user applies an accepted change through
agentic-kit's existing canonical host/routing surface.

### 3. Require a versioned, sanitized companion result contract

Before an adapter depends on `ak run --json`, agentic-kit must define an explicit companion export
envelope. It includes:

- a schema version and correlation identifier;
- stable terminal categories and bounded failure evidence;
- observed versus configured host/model/provider provenance;
- attempt/escalation, timing, and cleanup/orphan evidence;
- cost marked as observed, estimated, unpriced, or unknown;
- field-level redaction and size limits.

It excludes raw host protocol streams, dependency handoffs, credentials, environment variables,
repository files, and unbounded prompt/task/output text. Retention is opt-in and has an explicit
location and deletion policy. Network access or metered model use requires a declared budget and
user opt-in.

Defining or implementing that envelope is not authorized by this proposed ADR; it is the first
implementation prerequisite after acceptance.

### 4. Keep MetaHarness findings honest about what they measure

Static `metaharness score` output is pre-scaffold fit and recommendation evidence. Dimensions such
as tool safety are derived from the recommended generated policy, not a live audit or proof of the
current repository's security.

Audit findings are interpreted against the owning product. Absence of a generated
`.harness/mcp-policy.json` in agentic-kit can be a MetaHarness integration gap without being an
agentic-kit vulnerability. Live safety claims require the relevant audit and product-specific
evidence.

### 5. Bound Darwin and red/blue authority

Darwin may mutate only MetaHarness's approved planner, context-builder, reviewer, retry, tool,
memory, and score policy surfaces in a dedicated workspace. It does not modify agentic-kit source,
configuration, permissions, providers, credentials, or spending authority. Variants are evaluated
against fixed and held-out tasks and require separate maintainer review before adoption.

Red/blue testing uses `@metaharness/redblue` against systems the user owns or is authorized to
test. Runs use isolated fixtures, explicit tool/network allowlists, no production credentials, and
fixed budgets. MetaHarness complements rather than replaces agentic-qe and repository tests.

### 6. Permit only a thin internal projection without a new authority

A future agentic-kit integration may capability-probe and render read-only MetaHarness/Ruflo
availability, provenance, health, evaluation state, and repair or next-command guidance. Dashboard
integration remains read-only.

This ADR does not authorize:

- a new top-level `ak improve` command;
- signing-key generation or ownership;
- copied receipt, ledger, champion, or promotion state in `kit.json`;
- evaluation during `setup` or `sync`;
- mutation from status, dashboard, hooks, daemons, or generated guidance;
- automatic route, retrieval, tool, permission, model, provider, or spending-policy promotion.

Any of those requires an explicit amendment or separate ADR after the companion proves user value
and the upstream contract is stable.

### 7. Preserve Ruflo authority for Ruflo's flywheel

Where a compatible Ruflo release exposes a retrieval flywheel, agentic-kit may show its state but
does not reproduce its gate. Ruflo remains the sole authority for candidate evaluation semantics,
signed receipts, lineage, ledger head, active champion, serving epoch, and promotion transaction.

Support is capability-probed from actual commands and structured schema, not inferred from a
package name or version alone. Agentic-kit does not generate or take custody of flywheel signing
keys until a later design proves creation, provider integration, rotation, permission, redaction,
recovery, and uninstall ownership.

## Consequences

### Positive

- Agentic-kit gains independent outcome and regression evidence without embedding a second
  orchestrator.
- Optional tooling cannot make core setup, status, sync, routing, or execution unavailable.
- MetaHarness can evolve quickly without expanding agentic-kit's zero-runtime-dependency package.
- The component operating the workflow is distinct from the component measuring it.
- Existing agentic-kit authority, trust, provider-provenance, and cleanup boundaries remain intact.
- A small internal status projection remains possible if real usage justifies it.

### Costs and limitations

- A new subprocess adapter and companion result envelope must be designed and tested.
- Useful quality/cost advice requires representative tasks, independent verifiers, and enough
  labeled outcomes; sparse data must remain inconclusive.
- Whole-pipeline evaluation provides less internal detail than letting MetaHarness orchestrate each
  worker, by design.
- Maintainers must distinguish static fit scores, live audits, deterministic QE, and empirical
  outcome evaluation in documentation and release decisions.
- Ruflo/MetaHarness command and schema drift requires capability probing and versioned adapters.

## Rejected alternatives

- **Embed MetaHarness as agentic-kit's execution engine.** Rejected because it duplicates the
  canonical runner, routing, deadlines, escalation, and lifecycle boundaries.
- **Implement the branch proposal unchanged.** Rejected because it adds a second user workflow,
  configuration, and key ownership before proving demand or a stable upstream contract.
- **Let MetaHarness rewrite routes automatically.** Rejected because evaluation evidence is not
  authorization, may be sparse, and may silently change provider cost or trust posture.
- **Let MetaHarness orchestrate each `ak run` worker.** Rejected initially because two schedulers
  would disagree over dependencies, retries, cancellation, and cleanup.
- **Generate a MetaHarness scaffold over the agentic-kit repository.** Rejected because generated
  policy/configuration could collide with checked-in host guidance and MCP settings. A companion
  uses a sibling, temporary, or dedicated workspace.
- **Treat the scorecard as a security certification.** Rejected because its safety dimension scores
  the recommended policy, while a live security conclusion requires a relevant audit.
- **Use only an internal projection.** Rejected because display without independent tasks,
  verifiers, and comparison evidence does not deliver the main assurance value.
- **Use only an external companion forever.** Not decided. A read-only internal projection remains
  available if measured usage shows it removes repeated operational friction.

## Adoption gates

1. **Boundary gate:** accept this ADR and define data classification, budgets, retention, and
   representative tasks.
2. **Contract gate:** version and test a redacted companion result envelope without changing
   routing behavior.
3. **Shadow gate:** compare whole `ak run` pipelines and collect labeled evidence with no writes to
   agentic-kit configuration or upstream ledgers.
4. **Advisory gate:** require adequate samples and surface confidence, provenance, unknowns, and
   expected cost before recommending a route.
5. **Evolution gate:** isolate Darwin mutation surfaces and require held-out evaluation plus normal
   QE/review before adoption.
6. **Projection gate:** add read-only agentic-kit UX only when repeated companion use proves the
   need and the consumed upstream schema is stable.

No gate implies the next. Mutating integration requires a later explicit decision.

## Documentation disposition

This Proposed ADR and its product proposal replaced the unique MetaHarness commit `8dcad80` from
`docs/metaharness-integration-proposal`. That branch was not used as an implementation merge base
and was neither merged nor rebased into `main`:

- the branch proposal is replaced by the companion proposal;
- the branch ADR is replaced by ADR-0022 rather than copied into the occupied 0016 slot;
- the branch retrieval-improvement DDD is retired because it models responsibilities this ADR does
  not authorize;
- the branch ADR-index edit is discarded in favor of the current `main` index.

[PR #112](https://github.com/pacphi/agentic-kit/pull/112) merged the three documentation changes as
commit [`fafd705`](https://github.com/pacphi/agentic-kit/commit/fafd7051393b151018c5cd602eebad2a428b4572)
on 2026-08-04. The old proposal branch and the replacement PR branch were then deleted locally and
remotely. That completed documentation housekeeping does not change this ADR's status: it remains
Proposed until separately accepted.

## Verification requirements

- Removing MetaHarness leaves all core agentic-kit commands and tests operational.
- Companion integration adds no agentic-kit runtime dependency.
- Contract tests reject unknown schema versions, oversized fields, secrets, raw handoffs, and
  ungrounded provider/cost claims.
- Adapter tests prove one absolute bounded invocation, cancellation propagation, and no second
  scheduler over the worker DAG.
- Filesystem tests prove the companion cannot write agentic-kit configuration or generated host
  guidance.
- Budget tests prove no network/model spend without explicit opt-in and ceilings.
- Darwin tests prove mutation is limited to its seven approved policy surfaces.
- Documentation and UI distinguish score estimates, audit findings, QE results, and outcome
  evaluations.

## References

- [Product proposal](../METAHARNESS-COMPANION-PROPOSAL.md)
- [MetaHarness repository](https://github.com/ruvnet/metaharness)
- [MetaHarness harness worker contract](https://github.com/ruvnet/metaharness/blob/main/packages/harness/src/types.ts)
- [MetaHarness repo scorecard](https://github.com/ruvnet/metaharness/blob/main/packages/create-agent-harness/src/repo-scorecard.ts)
- [MetaHarness Darwin mutation surfaces](https://github.com/ruvnet/metaharness/blob/main/packages/darwin-mode/src/types.ts)
- [Ruflo MetaHarness CLI bridge](https://github.com/ruvnet/ruflo/blob/main/v3/%40claude-flow/cli/src/commands/metaharness.ts)
- [Ruflo ADR-322 at v3.32.26](https://github.com/ruvnet/ruflo/blob/v3.32.26/v3/docs/adr/ADR-322-metaharness-flywheel-integration.md)
- [ADR-0016 — capability-driven adapters](0016-capability-driven-integration-adapters.md)
- [ADR-0018 — generalized host-worker execution](0018-generalized-host-worker-execution.md)
- [ADR-0020 — one stable GA surface](0020-ga-stable-surfaces.md)
- RuvNet Brain source:
  `ruflo/v3/@claude-flow/cli/src/commands/metaharness.ts`
