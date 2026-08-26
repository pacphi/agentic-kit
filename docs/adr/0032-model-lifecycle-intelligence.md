# ADR-0032 — Model lifecycle intelligence from provenance-aware local evidence

- **Status:** Implemented
- **Date:** 2026-08-25
- **Updated:** 2026-08-25
- **Update note:** The bounded inventory, descriptor-selected source adapters, conservative snapshot
  diff, and read-only CLI/status surfaces are implemented. The operator-first Dashboard separates
  configured routes, aggregate model use in the selected 7/14/30-day window, and a progressive
  catalogue explorer. Its model detail summary collapses identical displayed provenance without
  removing independent field-level evidence references. Claude refresh combines local
  configuration with a dated bundled transcription of Anthropic's first-party model and
  deprecation records. It fills public identity, lifecycle, limits, capabilities, availability,
  and pricing without claiming account access or partner/OpenRouter routability. Ollama refresh uses bounded loopback
  `/api/tags`, `/api/show`, and `/api/ps` evidence with a partial CLI fallback. Credentials,
  endpoints, scopes, digests, aliases, evidence
  references, session identity, and history identifiers remain protected. Cited lifecycle alerts now
  name affected routes, current and recommended models, the provider notice, and a concrete planning
  action. The acceptance conditions and exact-head release proof are complete.
- **Deciders:** agentic-kit maintainers
- **Related:** [issue #110](https://github.com/pacphi/agentic-kit/issues/110),
  [implementation PR #179](https://github.com/pacphi/agentic-kit/pull/179),
  [ADR-0001](0001-one-routing-policy-many-projections.md),
  [ADR-0005](0005-dashboard-in-page-routing-reveal.md),
  [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0017](0017-opencode-host.md),
  [ADR-0020](0020-ga-stable-surfaces.md),
  [ADR-0021](0021-inference-provider-provenance.md), and
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md)

## Context

Agentic Kit knows the configured activity routes, their generated projections, and models observed
in local session evidence. It also carries a dated curated model table. Those facts cannot answer a
model's lifecycle state: a configured alias can move without the configuration changing; a public
catalogue entry does not prove account entitlement; a failed catalogue read does not prove removal;
and a first-party migration target does not prove equal quality or lower cost.

Claude Code, Codex, OpenCode, and local providers expose different configuration, catalogue, cache,
policy, and runtime shapes. Treating any one as the universal schema would collapse independent
claims and make upstream schema drift look like model churn. The same model reference can also be
consumed by canonical routes, escalation rungs, host projections, Agentic QE, Ruflo, and future
Route Intelligence evidence. A lifecycle change can invalidate any of those consumers without
authorizing Agentic Kit to rewrite them.

The existing boundaries remain load-bearing:

- top-level `kit.json.routing` is the one routing policy;
- host and inference-provider identity are independent;
- native evidence crosses source-specific anti-corruption adapters;
- unknown and degraded evidence remain visible rather than becoming false or zero; and
- the Dashboard is local, protected, read-only, and network-silent on ordinary reads.

When a host-owned Claude or Codex catalogue omits provider identity, its neutral facts may join an
independently established matching first-party `anthropic` or `openai` path. This is an exact
host/model/scope/digest join, not provider inference: custom and gateway providers remain separate.

## Decision

### 1. Establish a Model lifecycle intelligence bounded context

Model lifecycle intelligence owns normalized model inventory snapshots, lifecycle and
compatibility edges, trustworthy snapshot diffs, consumer impact, and read-model projections. It
consumes configuration intent, integration descriptors, Historical Usage and Observability
evidence, and host/provider catalogue evidence.

It does not own routing policy, host/provider configuration, transcript indexing, model quality
evaluation, or Ruflo/Agentic-QE routing. It may diagnose those consumers and produce a read-only
swap plan, but mutation remains on the canonical `ak host pick` surface.

### 2. Keep identity, state, and evidence independent

A model identity is scoped by execution host, inference provider, concrete model id, and a
non-identifying scope id. A mutable local digest participates when the provider exposes one.
Reasoning effort and service tier belong to a route binding or observed execution variant; the
model record may state which variants it supports, but those settings do not create unrelated base
model identities.

The following dimensions remain independent:

- configured;
- effective after precedence and alias resolution;
- observed in structured local evidence;
- discoverable in the active scope;
- entitled for the active account or profile;
- allowed by managed or user policy;
- routable through the complete host/provider/auth/capability path;
- lifecycle state; and
- recommended by a named first-party or evidence-backed source.

Every established field and graph edge carries an evidence reference naming its source, class, capture time,
freshness, completeness, and scope. Evidence strength never leaks from one field to another. In
particular, observed use may establish entitlement for that observed path, but it does not establish
the completeness of a catalogue.

### 3. Translate native catalogues through descriptor-driven source adapters

The immutable model-discovery registry identifies catalogue sources for a host or provider. A
bounded Model lifecycle collector loop selects those descriptors and dispatches to explicit
source-specific adapters. The descriptor determines owner, transport, network policy, schema, and
scope; command code does not maintain a parallel host switch. A descriptor is metadata, not an
executable supplied by the host, and external adapters without a supported catalogue descriptor do
not receive an inferred capability.

The initial adapter set covers:

- Claude user settings, platform-managed settings, a model-only environment allowlist, aliases,
  overrides, and policy allowlists, plus a dated bundled first-party Anthropic model/lifecycle
  record. The public record is network-silent and account-neutral; it leaves account, Claude Code
  plan, partner-platform, and OpenRouter entitlement/routability unknown;
- Codex's host-owned model cache or stable model-list protocol behind schema/version guards;
- OpenCode's project/provider-scoped model list and separately authorized online refresh; and
- Ollama installed catalogue, digest, safe model detail, and loaded runtime evidence from its
  loopback HTTP API through the same normalized contract. Raw templates, model files, and full
  license bodies are discarded; the CLI list is only a partial compatibility fallback.

OpenCode collection resolves the effective global, project, JSONC, agent, and command configuration
through `opencode debug config`. An explicitly online refresh runs `opencode models --refresh`
separately from the bounded verbose listing and joins each provider/model key exactly against a
bounded Models.dev catalogue response. Human name, family, capabilities, limits, lifecycle, and
pricing are allowlisted only after that exact public proof; provider syntax alone never proves a
public identity. Custom providers, configured variants, and ambiguous selectors remain private.
Diagnostics and catalogue input are bounded independently of subprocess output.

Interactive picker scraping and inference probes are excluded. All subprocess calls use literal
argument arrays, bounded timeouts, output-size limits, and no shell interpolation.

### 4. Persist sanitized, bounded snapshots and advance baselines conservatively

A `CatalogSnapshot` contains a schema version, id, capture time, scope, source states, normalized
models, bindings, and diagnostics. Source states are `complete`, `partial`, `stale`, `unavailable`,
`unsupported`, or `unsupported-schema`. Snapshots are rebuildable operational evidence, never
canonical configuration.

History retains at most 32 baseline-eligible snapshots per scope and no snapshot older than 90
days. An implementation may retain a newer degraded diagnostic snapshot outside the comparison
baseline, but it may not displace the last eligible baseline. Scope identity includes host,
provider, host/source schema version, and keyed non-identifying account/profile/project
fingerprints. Snapshots from different scopes are never compared as one lifecycle sequence.

An authoritative first-party retirement or removal signal may create a tombstone immediately.
Without one, removal requires absence from two consecutive complete snapshots in the same stable
scope. Partial, stale, unavailable, or schema-invalid sources never create removals and never
advance the comparison baseline.

### 5. Represent lifecycle and compatibility as typed edges

Lifecycle edges include `resolves-to`, `first-party-migration`, and `same-family-newer`.
Compatibility edges include `mechanically-compatible`, `tier-up`, `tier-down`, and
`specialized-alternative`. Each edge carries provenance and scope.

Mechanical compatibility requires an expressible host/provider transport, required modality/tool
capabilities, supported route variant, policy allowance, and established entitlement or an explicit
warning that blocks the compatibility claim. Unknown required evidence yields `unknown`, not a
compatible edge.

Only Route Intelligence may contribute `evidence-backed-equivalent`, `cheaper-equivalent`, or
`premium-justified` claims. When no such evidence exists, Model lifecycle intelligence says
`quality unknown`. Alias-target or relevant capability changes keep historical Route Intelligence
evidence visible but mark it stale; invalidation never deletes its audit history.

The implemented Route Intelligence handoff contains mechanically eligible candidates plus
lifecycle, alias, capability, digest, reasoning, context, variant, and pricing invalidations. It
may carry optional source-attributed pricing as a fact, but its contract explicitly denies quality
and economics claims. Route Intelligence must evaluate those claims under issue #109.

### 6. Ship one read-only command family

The stable noun is plural: `ak models`.

- `ak models status` reads the latest local snapshot and current local bindings;
- `ak models refresh` collects local config, caches, protocols, and observed evidence;
- `ak models refresh --online` is the only model-catalogue network boundary;
- `ak models diff` compares eligible same-scope snapshots;
- `ak models explain` discloses a model or alias evidence chain; and
- `ak models plan` reports affected routes, projections, Agentic QE/Ruflo consumers, and stale
  evidence, then emits a copyable canonical `ak host pick --route ...` command when expressible.

There is no `ak models apply`. A future transactional swap requires a separate decision and must
still mutate only canonical routing intent with preview, confirmation, verification, and undo.
`ak status --deep` remains local and does not perform remote model refresh.

The `ak status` model row may name explicit advisory actions. `ak sync` excludes them from its
executable convergence plan: it neither refreshes a catalogue nor applies a model plan.

### 7. Add cache-only status and Dashboard read models

`ak status` gains one cache-only model-health row. The Dashboard keeps its five primary areas —
About, Overview, Usage, Observability, and System — and adds Models as a secondary destination
under Usage plus a compact Overview summary. The Models destination presents attention, host
inventory, change history, consumers, swap impact, and evidence disclosure.

Normal status and Dashboard reads never refresh a catalogue or invoke a model. The Dashboard cannot
apply a plan. It fetches a compact summary before a first 50-row relevant inventory page. Search,
faceted filters, server-side sorting, and later pages operate on the sanitized projection. The
height-bounded inventory scrolls internally with a sticky header, so history and consumer panels do
not move behind the full catalogue. All model counts, badges, and warnings link to their evidence
state, freshness, completeness, and scope.

Provider history does not become local attention merely because it is public. A cited lifecycle
migration enters attention only when that model is configured/effective or observed in this scope.
Retired catalog-only records remain inspectable in the full catalogue and do not flood the in-use
view.

### 8. Protect private scope and configuration facts

Credentials, auth tokens, prompts, reasoning traces, raw private provider configuration, endpoints,
and raw account/profile/project identities never enter snapshots or Dashboard payloads. The
token-gated loopback Dashboard is an owner operator surface, so it may show bounded exact configured
or observed model selectors, display names, and providers. `/api/models` still requires the existing
owner-only per-install secret. Digests, aliases, arbitrary configuration values, edges, binding ids,
evidence references, scopes, and history identifiers remain keyed pseudonyms. Public identity does
not prove serving provider, entitlement, policy, routability, capability, or quality. Filtering and
sorting run after privacy projection, a missing or invalid key fails closed, and an ordinary read
never creates one.

Snapshot files are owner-only and atomically replaced. Native cache/protocol data is untrusted and
subject to byte, schema, enum, and timeout bounds. Dashboard delivery retains loopback binding,
session-token authorization, CSP/origin protections, `no-store`, and secret scanning.

## Consequences

- Model existence, access, policy, use, lifecycle, and recommendation can disagree honestly without
  collapsing to one availability boolean.
- Failed discovery cannot manufacture a mass removal or erase the last trustworthy baseline.
- Host-native schema changes degrade one source behind its adapter instead of corrupting the domain
  model.
- `kit.json.routing`, `ak host pick`, Ruflo, Agentic QE, and Route Intelligence keep their existing
  ownership; inventory is a diagnostic and planning consumer.
- The local cache adds bounded disk state and a per-install fingerprint secret that uninstall and
  privacy documentation must account for.
- Supporting a new host catalogue requires a descriptor, an anti-corruption adapter, fixtures, and
  explicit evidence semantics; host identity alone grants nothing.
- Exact owner-visible model identity makes the local ledger operational without weakening credential,
  endpoint, account, scope, or configuration-value protection.
- First-party public facts remove avoidable Claude lifecycle/specification unknowns while preserving
  `unknown` for local configuration, entitlement, policy, and routability.
- Catalogue enrichment cannot rewrite Historical Usage sessions/transcripts or Observability
  live/history records; those contexts remain upstream owners of their data.

## Acceptance conditions

The decision may be marked Implemented only when:

1. all independent state dimensions and evidence references survive human and JSON projections;
2. Claude, Codex, OpenCode, and local-provider fixtures normalize deterministically;
3. partial or cross-scope snapshots cannot create removals or advance the baseline;
4. alias, migration, capability, visibility, local-digest, reasoning, context, variant, and pricing
   changes diff correctly;
5. plans enumerate canonical routes and independent Agentic QE/Ruflo consumers without mutation;
6. ordinary CLI/Dashboard reads are proven network-silent and token-silent;
7. snapshot and Dashboard payloads pass credential, prompt, endpoint, private-id, path, keyed
   pseudonym, and fail-closed disclosure checks;
8. Dashboard keyboard, responsive, and screen-reader contracts pass; and
9. exact-head project, Agentic QE, privacy, security, and release gates are recorded.

## Implementation and release proof

The implementation branch was validated on 2026-08-25 with the following exact-head evidence:

- `pnpm run check` passed TypeScript checking, ESLint, Markdown lint, packaging, CLI-load checks,
  and the full unit/integration suite. Native instrumented coverage was 87.15% lines, 80.15%
  branches, and 85.19% functions against 70% repository floors.
- `pnpm run test:ui` passed the 331-check deterministic browser matrix, including Models-only panel
  ownership across every Usage submenu, readable Ollama build/runtime detail, lazy Models
  loading, paired evidence filters, clickable ascending/descending column sorting, snapshot-bound
  pagination with safe reset, append retry without row loss, keyboard movement in the bounded
  scrolling table, Claude public-fact/access/routability disclosure, tab navigation, evidence
  disclosure, responsive behavior, and network-silent page loading.
- A production-sized OpenCode 1.18.23 fixture yielded all 402 models without truncation. Exact
  Models.dev proof normalized the catalogue's omitted active status, while malformed successful
  responses degraded to partial evidence rather than public identity.
- Agentic QE 3.13.12's native Node-test execution passed 16/16 focused Dashboard projection/API
  tests. Its SAST scanner inspected all 16 model-inventory files and all 13 Dashboard files and
  reported no vulnerabilities. The repository's native coverage report remains the coverage
  authority; no Agentic QE score was inferred from separate process-local evidence.
- A 179-test boundary suite covering Usage indexing, OpenCode/OpenRouter usage, live sessions,
  selected transcripts, and Observability identity passed. It proves public catalogue enrichment
  does not change those live or historical projections.
- Privacy and security tests proved owner-only atomic snapshots, bounded subprocess output,
  cache-only reads, explicit no-write/no-network online dry runs, source-proven public identity,
  keyed private Dashboard pseudonyms, fail-closed missing-key behavior, and absence of raw private
  identifiers from `/api/models`.
- `pnpm audit --prod` reported no known vulnerabilities. No runtime dependency was introduced;
  the implementation uses Node's built-in filesystem and cryptography APIs.
- The package dry run included this ADR, the DDD model, and `docs/MODELS.md`; internal Markdown
  links and the stable command-surface guards passed.

Current official Claude Code, OpenCode, OpenAI, Ollama, and Node documentation was rechecked on
2026-08-25 before freezing source commands, selector parsing, model lookup semantics, and runtime
API usage. Public provider catalogues remain discovery evidence only; they are not promoted to
host entitlement evidence.
