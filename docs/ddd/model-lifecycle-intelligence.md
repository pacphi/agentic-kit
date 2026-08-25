# Model Lifecycle Intelligence Domain

This document defines the bounded context accepted by
[ADR-0032](../adr/0032-model-lifecycle-intelligence.md). It describes the target contract; until
ADR-0032 is Implemented, commands and read models named here are planned rather than shipped.

## Purpose

Model lifecycle intelligence answers which models are configured, selected, observed, discoverable,
usable, changing, and consequential to local consumers. It preserves the evidence and uncertainty
behind each answer and produces read-only status, diff, explanation, and swap-impact projections.

It does not select the best model, mutate routing, own host/provider configuration, or replace the
Ruflo, Agentic QE, or Route Intelligence routers.

## Context boundary

```text
Configuration Intent ------> binding collector --------+
Integration descriptors ---> catalogue adapters -------+
Historical Usage ----------> observed-use collector ---+--> CatalogSnapshot
Host/provider evidence -----> source adapters ----------+          |
                                                                  +--> ModelChange
                                                                  +--> ConsumerImpact
                                                                  +--> SwapPlan
                                                                  +--> read models
```

Model lifecycle intelligence consumes facts from four neighboring contexts:

- Configuration Intent supplies canonical routes, escalation rungs, integration bindings, and
  provider configuration references.
- Integration Management supplies capability and observability descriptors, projection identity,
  and bounded host/provider facts.
- Evidence Acquisition supplies source-adapted catalogue, policy, lifecycle, and runtime evidence.
- Historical Usage and Observability supply structured observed host/provider/model facts without
  surrendering ownership of transcripts, sessions, or live events.

Its outputs are advisory inputs to Routing and Orchestration, Dashboard Delivery, Agentic QE/Ruflo
diagnostics, and Route Intelligence.

## Aggregate and value objects

### ModelIdentity

```text
ModelIdentity
  host
  provider
  modelId
  scopeId
  digest?
```

Identity is host- and scope-qualified because equal strings can name different deployments,
accounts, projects, gateways, or local model bytes. `digest` participates only where a source
establishes a mutable local artifact digest. Reasoning effort and service tier belong to a binding
or execution variant, not to the base identity.

### ModelRecord

A ModelRecord carries display identity, aliases, lifecycle state, supported variants and
capabilities, optional pricing metadata, and field-level evidence references. No record-level
confidence may silently strengthen a weaker field.

The independent state dimensions are configured, effective, observed, discoverable, entitled,
policy allowed, routable, lifecycle, and recommended. Each is `true`, `false`, or `unknown` where
applicable and names the evidence that established it.

### ModelBinding

```text
ModelBinding
  consumer
  activity?
  host
  provider
  configured reference
  effective concrete identity?
  execution variant?
  provenance
  evidenceRefs[]
```

Consumers include canonical routes, escalation rungs, host projections, Agentic QE overrides and
fallbacks, Ruflo candidates, and Route Intelligence cohorts. A configured alias remains in the
binding even after an effective concrete target is resolved.

### CatalogSource

A source identifies its host or provider, local or online collection mode, source/schema version,
capture time, non-identifying scope fingerprint, status, completeness, and diagnostics. Status is
one of `complete`, `partial`, `stale`, `unavailable`, `unsupported`, or `unsupported-schema`.

### CatalogSnapshot

The aggregate root is a sanitized, immutable snapshot:

```text
CatalogSnapshot
  schemaVersion
  snapshotId
  capturedAt
  scope
  sources[]
  models[]
  bindings[]
  diagnostics[]
```

Changes, opportunities, and plans are derived from snapshots plus current bindings; they are not
written back as catalogue truth.

### LifecycleEdge and CompatibilityEdge

Lifecycle relations are `resolves-to`, `first-party-migration`, and `same-family-newer`.
Compatibility relations are `mechanically-compatible`, `tier-up`, `tier-down`, and
`specialized-alternative`. Every edge has source, scope, confidence, and evidence references.

`evidence-backed-equivalent`, `cheaper-equivalent`, and `premium-justified` belong to Route
Intelligence. This context can preserve and invalidate those imported claims but cannot create them.

### ModelChange

A change names its kind, subject, before/after values, severity, scope, and evidence. Additions,
visibility, alias, lifecycle, capability, reasoning, context, and digest changes require comparable
same-scope evidence. Removal additionally requires an authoritative signal or two consecutive
complete same-scope absences.

### SwapPlan

A SwapPlan is a read-only impact report. Each item links a source binding to affected canonical
routes, projections, Agentic QE/Ruflo consumers, compatibility blockers, and evidence that becomes
stale. When expressible, it supplies a copyable `ak host pick --route ...` command. It has no apply
operation.

## Evidence rules

Evidence classes, strongest first for the field they actually establish, are:

1. observed successful execution with concrete host/provider/model identity;
2. host-owned entitled catalogue or explicit lifecycle metadata;
3. host-owned discoverable catalogue/cache in the active scope;
4. managed policy/configuration after precedence resolution;
5. canonical Agentic Kit intent and generated projection;
6. provider-published public catalogue;
7. dated locally curated metadata;
8. inferred family relationship; and
9. unknown.

Strength is field-local. A successful execution proves that path worked at that time; it does not
prove catalogue completeness, future entitlement, or global provider identity. Negative evidence
requires completeness and stable scope.

## Snapshot lifecycle

- Retain at most 32 baseline-eligible snapshots per scope and no snapshot older than 90 days.
- Advance a baseline only from a sufficiently complete snapshot in the same stable scope.
- Preserve the last eligible baseline when a later collection is partial, stale, unavailable, or
  schema-invalid.
- Compare account/profile/project scopes only when their keyed fingerprints match.
- Allow an authoritative first-party removal immediately; otherwise require two consecutive
  complete absences.
- Keep stale recommendation history auditable after alias, capability, provider, host-version, or
  harness changes.

## Discovery contract

The collector selects catalogue observability descriptors and invokes a bounded source adapter.
The command layer never switches on a hard-coded host id. Descriptors authorize no arbitrary code:
built-in adapters own parsing and external hosts without a supported descriptor report
`unsupported`.

Local refresh reads configuration, local caches/protocols, and observed evidence. Online refresh is
separate and explicit. Neither path invokes a model or sends a prompt.

## Privacy and delivery

Snapshots exclude credentials, raw provider configuration, prompts, reasoning traces, and raw
private deployment identities. An owner-only per-install secret keys scope and private-identity
fingerprints. Snapshot replacement is atomic and owner-only. Native inputs have size, timeout,
schema, and enum bounds.

CLI status and Dashboard reads are cache-only. The Dashboard receives sanitized read models behind
its existing loopback, session-token, origin, CSP, and `no-store` boundary and cannot apply a plan.

## Invariants

1. Host, provider, model, scope, and execution variant remain separate facts.
2. Configured, effective, observed, discoverable, entitled, allowed, and routable never collapse.
3. Every fact and edge carries source, freshness, completeness, and scope.
4. Unknown or degraded evidence never becomes removal, unavailability, or compatibility.
5. Snapshots from different scopes never produce lifecycle churn.
6. Inventory never mutates canonical routing or downstream router state.
7. First-party migration is not a quality or economic recommendation.
8. Route Intelligence evidence stays visible but stale after invalidation.
9. Ordinary reads make no network request and consume no inference tokens.
10. Private configuration and transcript content never enter snapshots or aggregate APIs.
