# Model Lifecycle Intelligence Domain

This document defines the bounded context accepted by
[ADR-0032](../adr/0032-model-lifecycle-intelligence.md). The implementation and exact-head release
proof are recorded by ADR-0032, whose current status is Implemented.

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

The Claude adapter combines two independent sources: local Claude configuration/policy and a
dated, bundled transcription of Anthropic's first-party public model and deprecation records. The
public supplement is network-silent and account-neutral. It can establish publication, public
specifications, and lifecycle only; it cannot establish Claude Code plan entitlement, API-key
availability, partner-platform availability, or an OpenRouter path.

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

Host-owned Claude and Codex catalogues may be provider-neutral. If independent evidence establishes
the exact same host/model/scope/digest under the host's expected first-party provider (`anthropic`
or `openai`), the neutral catalogue fields join that provider-qualified record. The join never
targets a custom or gateway provider, so equal model strings on distinct serving paths remain
distinct identities.

### ModelRecord

A ModelRecord carries display identity, aliases, lifecycle state, typed edges, supported variants
and capabilities, optional pricing metadata, and field-level evidence references. No record-level
confidence may silently strengthen a weaker field. Optional pricing is a dated source fact; it is
not an economic recommendation.

The independent state dimensions are configured, effective, observed, discoverable, entitled,
policy allowed, routable, lifecycle, and recommended. Each is `true`, `false`, or `unknown` where
applicable and names the evidence that established it.

### CatalogIdentityProjection

The Dashboard projection separates the execution host, serving provider, publisher/lab, human
name, exact public selector, and catalogue source. These axes cannot be derived from one another.
A controlled source may mark an identity public only when its bounded parser established that
catalogue metadata. The bundled Anthropic public record makes its exact documented Claude ids and
aliases public product vocabulary and carries first-party specifications/lifecycle evidence. Codex
cache display names qualify only through host-owned discovery evidence. OpenCode identity becomes
public only after an exact provider/model-key join with the
bounded Models.dev catalogue; provider syntax does not establish proof. A custom
provider, configured variant, gateway deployment, local tag, or observed-only id remains a keyed
pseudonym. Trusted documentation and catalogue links are server-produced HTTPS links on a fixed
host allowlist. The browser never guesses a link from a model-name substring.

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

A source identifies its owner and owner type, file/command/HTTP/index transport, `never`/`local`/
`explicit` network policy, local or online collection mode, source/schema version, capture time,
non-identifying scope fingerprint, status, completeness, and diagnostics. Status is one of
`complete`, `partial`, `stale`, `unavailable`, `unsupported`, or `unsupported-schema`.
Bundled public sources also carry a verification date. The Anthropic source becomes `stale` after
90 days; an operator must upgrade Agentic Kit to receive revised public facts before refreshing the
snapshot.

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
visibility, alias, lifecycle, capability, reasoning, context, other variant, optional pricing,
typed-edge, and digest changes require comparable same-scope evidence. Alias and digest continuity
pair one model lineage before evaluating fields. Removal additionally requires an authoritative
signal or two consecutive complete same-scope absences.

Lifecycle, pricing, and edge comparison uses semantic fields and ignores evidence-reference ids and
capture timestamps. A refresh that restates the same fact with new evidence does not create churn.

### SwapPlan

A SwapPlan is a read-only impact report. Each item links a source binding to affected canonical
routes, projections, Agentic QE/Ruflo consumers, compatibility blockers, and evidence that becomes
stale. When expressible, it supplies a copyable `ak host pick --route ...` command. It has no apply
operation.

Unknown catalogue discovery blocks planning unless a structured successful observation proves the
exact target path; that exception remains an explicit warning. `discoverable: false` always blocks.
OpenCode selectors retain both axes as `opencode:provider/model`.

### RouteIntelligenceFeed

The feed to issue #109 contains mechanically eligible candidates and audit-preserving invalidation
markers for lifecycle, alias, capability, digest, reasoning, context, variant, and pricing changes.
It can carry optional source-attributed pricing but sets quality and economics claims to false.
Route Intelligence owns any later evidence-backed equivalence or cost conclusion.

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

The collector selects immutable model-discovery descriptors and invokes a bounded built-in source
adapter. Each descriptor establishes owner, transport, network policy, schema, and scope. The
command layer does not keep a parallel host switch, and descriptors authorize no arbitrary code.
An external host receives no inferred catalogue capability without an admitted descriptor and
matching adapter.

Claude collection reads user settings and the platform-managed settings path. It accepts only
`ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` from the process environment;
credentials, endpoints, and unrelated environment values remain outside the collector.

Local refresh reads configuration, local caches/protocols, and observed evidence. OpenCode first
resolves its effective configuration with `opencode debug config`, including global, project,
JSONC, agent, and command model bindings. Online refresh is separate and explicit: it refreshes the
OpenCode catalogue, obtains a bounded Models.dev response, then parses a separately bounded verbose
listing. Display name, family, capabilities, limits, lifecycle, and pricing are public only after
an exact provider/model-key catalogue join. Arbitrary bounded selectors remain usable without
making custom provider URLs, headers, options, or ids public. Neither path invokes a model or sends
a prompt.

Ollama refresh contacts only its loopback `/api/tags`, `/api/show`, and `/api/ps` endpoints. It
keeps installed name, digest, size, update time, format/family/build, bounded capability/context and
license summaries, plus loaded memory/VRAM/context/expiry. Raw templates, model files, parameters,
and full license bodies are discarded. A bounded `ollama ls` compatibility fallback is marked
partial because it cannot establish runtime facts. Installed and loaded never imply observed use.

## Privacy and delivery

Snapshots exclude credentials, raw provider configuration, prompts, reasoning traces, endpoints,
and raw account/profile/project identities. The atomic owner-only cache may retain bounded exact
configured model or deployment identifiers for an explicit local CLI read. An owner-only
per-install secret keys scope fingerprints and the separate Dashboard projection.

CLI status and Dashboard reads are cache-only. CLI reads are deliberate exact local disclosure. The
Dashboard's token-gated loopback `owner-visible-v2` projection carries bounded exact model display
names, selectors, and recorded providers, so a route can answer what it is actually configured to
use. Digests, aliases, replacement internals, edges, binding ids, evidence, scope, history,
credentials, endpoints, and arbitrary provider configuration remain pseudonymous. Source-proven
public catalogue identity may retain its publisher and trusted links; public identity never makes
entitlement or routability known. The summary projection omits the large model array, and the
inventory projection filters, sorts, and pages only the already-sanitized rows. Later pages carry
the privacy-projected snapshot id; a changed snapshot is rejected and the browser restarts from page
one rather than mixing generations. Missing key material fails closed without creating state.
Delivery remains behind the loopback, session-token, origin, CSP, and `no-store` boundary and cannot
apply a plan.

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
10. `ak sync` does not execute model refresh or model-plan advisories.
11. Private configuration and transcript content never enter snapshots or aggregate APIs.
12. Inventory search, filtering, and sorting operate after privacy projection.
13. Inventory pagination never mixes rows from different privacy-projected snapshots.
