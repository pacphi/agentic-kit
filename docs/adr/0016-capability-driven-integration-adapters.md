# ADR-0016 — Capability-driven host, provider, binding, projection, and observability adapters

- **Status:** Accepted; compatibility clauses superseded by
  [ADR-0020](0020-ga-stable-surfaces.md); closed-registry clause superseded by
  [ADR-0029](0029-host-adapter-extension-point.md)
- **Date:** 2026-07-28
- **Updated:** 2026-08-25
- **Update note:** Added read-only Codex plugin-hook compatibility facts,
  runtime-selected Ruflo project-memory store proofs, and the non-correlatable
  OpenRouter account-analytics boundary; removed the pre-GA compatibility command,
  persisted fields, and adapter bootstrap. ADR-0023 now requires each host adapter
  to declare its setup trust posture and changes for host-neutral preflight.
  Phase 0 consistency pass (2026-08-14): host adapters gained a required
  `enabledByDefault` boolean and the three enabled-host default literals now
  derive from it via `defaultHostMap()` (F-15); the `observability` axis remains validation
  metadata for implemented integrations: no general-purpose collector loop
  exists (F-12). ADR-0032 implements one narrow exception: Model lifecycle intelligence selects
  catalogue descriptors and dispatches only to built-in, bounded source adapters. It does not turn
  descriptors into arbitrary executable plugins; release proof for the narrow collector remains
  pending.
  The non-throwing `validateBinding` is wired into `ak host status` as per-entry
  warnings (F-16); and the integrations migrator derives each host's native
  default provider from the provider registry's host-login entries instead of a
  literal map, inferring no binding at all for hosts without one (F-13).
  2026-08-15: [ADR-0029](0029-host-adapter-extension-point.md) supersedes §1's
  closed-registry requirement — the registry admits an explicitly registered,
  hash-pinned, subprocess-only external host adapter behind an experimental
  flag; every other property that clause protected (zero-runtime-dependency,
  offline-first normal operation, no in-process third-party code) remains
  intact.
  2026-08-20: the read-only Codex plugin fact now covers portable skill
  frontmatter and version-bounded runtime-output advisories as well as hook
  documents. Setup and sync explicitly install or enable no Codex plugins. The
  project-memory pin is now projected through host-specific launch context:
  Claude project env, Codex's workspace-aware MCP launcher, and OpenCode's
  project-aware MCP/lifecycle processes.
  2026-08-25: [ADR-0033](0033-retire-codex-mcp-and-bound-qe-court-participants.md)
  retires the deprecated Claude→Codex MCP projection while retaining this ADR's
  value-precise ownership boundary. OpenAI's Claude Code plugin remains external and
  user-owned; Ruflo and Agentic-QE registrations are independent Codex integrations.
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0001](0001-one-routing-policy-many-projections.md),
  [ADR-0003](0003-auto-seed-dual-host-provenance.md),
  [ADR-0006](0006-primary-host-and-ambidextrous-mirroring.md),
  [ADR-0008](0008-guidance-target-scope-split.md),
  [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0010](0010-provider-mediated-quota-reads.md),
  [ADR-0011](0011-local-model-provenance-zero-cost-and-transcript-fidelity.md),
  [ADR-0012](0012-observability.md),
  [ADR-0015](0015-managed-codex-native-statusline.md),
  [issue #59](https://github.com/pacphi/agentic-kit/issues/59),
  [issue #71](https://github.com/pacphi/agentic-kit/issues/71)

> **GA amendment:** the capability axes and lifecycle contracts remain authoritative. Sections
> that preserve compatibility exports, commands, or persisted fields are historical after 4.0.

## Context

Agentic-kit currently describes related integration behavior in several adjacent structures:
`HOST_ADAPTERS` in `hosts.mjs`; `HOSTS`, `API_PROVIDERS`, provider credentials, and AQE provider
types in `providers.mjs`; routable hosts and constructible providers in `routing.mjs`; and further
host/provider lists in setup, sync, status, verify, uninstall, transcripts, Live, usage, and the
dashboard. The lists serve different purposes and can legitimately contain different members, but
their similar names make drift and category errors likely.

The categories are not interchangeable:

- Claude Code, Codex CLI, and OpenCode are execution hosts.
- Anthropic, OpenAI, OpenRouter, Ollama, Gemini, Bedrock, and Azure OpenAI are inference
  providers or endpoints.
- Claude settings, Codex TOML, OpenCode JSON, the ruflo router, and the agentic-qe router are
  configuration projections.
- Host transcripts, vendor response metadata, quota channels, and the Ollama catalogue are
  observability sources.

A Claude transcript proves that Claude was the host. It does not by itself prove that Anthropic
served the model. An Ollama model may be reached through both `ollama launch claude` and
`ollama launch codex`; those are two host bindings to one provider, not two providers. OpenRouter
may serve a model used by an existing host without becoming a third host. OpenCode may support
install, configuration, MCP, guidance, transcripts, and teardown while remaining ineligible as a
primary host or activity-routing target.

Adding integrations by extending every incidental list would permit invalid routing choices,
partial lifecycle support, destructive ownership assumptions, and fabricated provider, billing,
quota, cache, or pricing claims. It would also make issue #59's OpenRouter attribution depend on an
incorrect “transcript provider equals inference provider” assumption.

Agentic-kit remains a plain-ESM, zero-runtime-dependency CLI. Its normal operation is offline-first.
The design must therefore be a closed, validated registry of built-in code, not an arbitrary
third-party plugin runtime.

## Decision

### 1. Keep four adapter axes and one relationship type

Agentic-kit defines separate, validated built-in registries:

1. **Host adapters** describe execution drivers and their native surfaces.
2. **Provider adapters** describe inference, transport, credentials, billing, and evidence
   capabilities independently of a host.
3. **Projection adapters** implement a native configuration surface.
4. **Observability adapters** read and normalize a bounded evidence source.

A **provider binding** is persisted intent connecting a host and provider through a projection and
transport. It is data, not a fifth executable adapter registry.

All registries are static modules shipped with `ak`. Registration validates the complete built-in
set at module/test boundaries. Agentic-kit does not dynamically import adapter paths from
`kit.json`, npm packages, or user directories.

The conceptual descriptors are:

```js
// HostAdapter
{
  id, label,
  install: { bin, method, package, externalPolicy },
  capabilities: {
    driveSession, primary, activityRouting, install,
    mcp, guidance, statusline, transcripts, usage
  },
  auth: { kind, keyEnv, loginProbe },
  trust: { approvalPolicy, changes: [] },
  projections: [],
  observability: [],
  defaultProvider
}

// ProviderAdapter
{
  id, label,
  billing, // local | subscription | metered | unknown
  credentials: { kind, env }, // none | env | host-auth
  transports: [],
  capabilities: {
    modelDiscovery, runtimeDiscovery,
    pricing, // zero | dated | none
    quota,
    cacheAccounting // exact | approximate | none | unknown
  },
  projections: [],
  observability: []
}
```

Projection and observability descriptors contain metadata plus references to built-in lifecycle or
normalizer functions. Registry validation rejects duplicate IDs, unknown capabilities or enum
values, unresolved projection/observability references, invalid billing/credential combinations,
and invalid capability implications. A host must explicitly declare whether agentic-kit manages
approval grants or leaves host policy unchanged, plus every setup-time approval, registration,
lifecycle extension, and host integration it can apply. In particular, `primary` and `activityRouting` require
`driveSession`; a provider with `pricing: 'zero'` must be local; and a required credential is
described by environment-variable name, never by its value.

Host and provider namespaces are typed. An ID appearing on the provider axis can never satisfy a
host reference, and vice versa. Compatibility exports may derive the old arrays and maps from the
registries during migration, but they are not independent sources of truth.

### 2. Derive choices from capability, not identity

Commands ask the registry what an adapter can do instead of comparing its ID:

- host selection lists managed host integrations;
- primary-host selection includes only `capabilities.primary`;
- activity routing includes only `capabilities.activityRouting`;
- install, MCP, guidance, status-line, transcript, and usage work runs only for adapters exposing
  that capability;
- provider pricing, quota, cache, discovery, and billing views render only supported facts;
- update and uninstall actions apply only to artifacts `ak` owns;
- verification selects host, provider, binding, projection, and observation proof contracts by
  capability.

Consequently, adding OpenCode to the host registry alone does not make it primary or routable.
ADR-0018 subsequently enables explicit `ak run` routes after adding a supervised execution adapter;
it remains non-primary and outside AQE projection. Adding OpenRouter to the provider registry does
not make it a host.

### 3. Use one lifecycle contract for managed projections

Every mutating built-in projection uses the same lifecycle:

```text
detect(context)                 -> facts + health + diagnostics
plan(context, intent, facts)    -> operations + preconditions + diagnostics
apply(context, plan, options)   -> operation results + ownership receipts
verify(context, intent)         -> independently observed facts + proofs
undo(context, receipts)         -> operation results
```

- `detect` is read-only.
- `plan` is deterministic for the same intent and facts.
- `apply({dryRun:true})` performs no writes or mutating process calls.
- repeated apply converges without additional writes.
- `verify` reads the target surface rather than trusting the plan or prior apply result.
- `undo` runs in reverse dependency order and touches only owned values.
- malformed, absent, unsupported, or unavailable surfaces produce honest diagnostics and unknown
  facts rather than guessed success.

Setup, status, sync, provider selection, verify, and uninstall consume this lifecycle and the same
normalized facts. Commands remain responsible for presentation and orchestration, not native
surface semantics.

Network and process probes are bounded and explicit. Ordinary config loading and normalization
perform no network access. A loopback runtime probe may run where the command contract calls for
it, with a short timeout and an honest unreachable result. Remote provider verification is
explicit verification, not an implicit side effect of ordinary status.

### 4. Generalize value-precise ownership without adopting external state

An apply operation records a safe receipt shaped as:

```js
{
  adapterId, surface, scope, target, keyPath,
  prior: { present, value },
  written: { present, value },
  managedBy: 'agentic-kit',
  recordedAt
}
```

Large or sensitive values may use a stable value hash, provided comparison remains exact for the
owned field. Credential values are never included.

Undo restores or removes a field only when its current value still equals `written`. If a user or
external tool changed it, `ak` reports drift and preserves the current value. A receipt never
authorizes rewriting sibling keys, deleting a containing table, uninstalling an externally
installed executable, or adopting a host-native profile.

Install ownership is separate from presence. An npm package installed by `ak` can be updated or
removed under its install receipt. A Homebrew, system, vendor-installer, or otherwise external
installation remains detectable and usable but unmanaged. This extends PR #67 and ADR-0015's
no-clobber behavior across JSON, TOML, environment projections, and CLI-managed surfaces without
weakening it.

#### Externally-owned plugin cache and runtime-selected memory

Codex plugin configuration and `~/.codex/plugins/cache` are externally owned. Agentic-kit installs
or enables no Codex plugin. It reads every explicitly enabled plugin's newest cached manifest,
follows its declared hook paths (or the default `hooks/hooks.json`), validates the Codex hook-file
contract and portable skill frontmatter, and applies version-bounded runtime-output advisories. It
does not refresh, rewrite, delete, or adopt any plugin cache entry. An invalid newest cached bundle is a diagnostic fact
with native remediation: open Codex `/plugins` to refresh or disable the plugin, then start a new
session. The row has no `sync` fix.

Project memory is also detected at fact level rather than inferred from package presence or a
single historical filename. Current native Ruflo bridges can preserve a compatibility/sql.js (or
encrypted) `.swarm/memory.db` while writing native plaintext rows to the sibling
`.swarm/agentdb-memory.db`. When the native sibling exists it is the active writer; the
compatibility store may coexist without representing drift. Read-only status identifies the active
writer and counts observable entries. Setup and `ak x verify memory` prove persistence by storing
a disposable row, locating it in the runtime-selected store, retrieving it through the real CLI,
and removing it. File or package presence alone is never reported as a persistence proof.
Claude carries the absolute compatibility path in project settings. Codex's user-scoped MCP entry
uses an agentic-kit launcher that derives the same absolute pin from each runtime workspace;
agentic-kit migrates only a legacy entry it previously registered and preserves user-owned Codex
entries. OpenCode's receipt-owned gateway and lifecycle processes set their cwd and pin from the
host-provided project directory. These are host projections of one project-memory contract, not
separate stores.

### 5. Normalize field-level facts before rendering conclusions

Detection and observation return facts, not pre-rendered status rows:

```js
{
  subject: { kind, id },
  field,
  value,
  provenance, // observed | configured | inferred | unknown
  sourceAdapter,
  evidenceRef,
  observedAt,
  freshness,
  confidence
}
```

Facts merge at field level. `observed` evidence normally outranks `configured`, which outranks
`inferred`, which outranks `unknown`, but conflicting evidence is retained for diagnostics rather
than erased. A record never receives one blanket confidence when its host, provider, model, billing,
and endpoint have different sources.

Consumers receive a resolved execution projection with independently proven dimensions:

```js
{
  host:      { id, provenance },
  provider:  { id, provenance },
  model:     { id, digest, provenance },
  transport: { id, provenance },
  endpoint:  { class, display, provenance },
  billing:   { kind, provenance },
  capabilities: { pricing, quota, cacheAccounting },
  bindingId
}
```

An absent provider remains unknown. A legacy host-to-provider default may be labelled `inferred`;
it is never upgraded to observed merely because a transcript host is known. Price, quota, and cache
fields are absent when no supporting source exists. `$0` is reserved for grounded local-provider
evidence under ADR-0011; unknown and unpriced are not rendered as free.

Status rows, setup/sync plans, verification results, dashboard cards, Live events, and usage
attribution project from these facts. Collection returns immutable snapshots or ordinary values,
not a mutable global registry cache.

### 6. Add versioned provider bindings without replacing legacy configuration

The initial persisted shape is additive:

```json
{
  "integrations": {
    "version": 1,
    "hosts": {
      "claude": true,
      "codex": false
    },
    "bindings": [
      {
        "id": "ollama-via-claude",
        "host": "claude",
        "provider": "ollama",
        "projection": "claude",
        "transport": "anthropic-compatible",
        "endpoint": "http://127.0.0.1:11434",
        "model": "qwen3.6:latest",
        "provenance": "configured",
        "managedBy": "agentic-kit"
      }
    ]
  }
}
```

`integrations.version`, `integrations.hosts`, and `integrations.bindings` are the canonical
versioned integration envelope. The legacy `providers` object continues alongside it:
`providers.hosts`, `primaryHost`, `dualRouting`, `aqeProvider`, `aqeFallback`, and `models` remain
valid during the compatibility window because they still drive the existing downstream
projections. They are not an alternate location for new bindings.

Loading a legacy Claude-only or Claude+Codex file produces the same effective behavior and does not
rewrite the file. The loader normalizes legacy `providers.hosts` intent into
`integrations.hosts` in memory. The next intentional save persists the canonical
`integrations: { version, hosts, bindings }` envelope alongside the legacy fields; repeating the
migration produces byte-equivalent intent.

`dualRouting` remains activity-to-host/model/escalation intent. Provider resolution is a separate
binding lookup rather than an optional provider field on every route. This preserves ADR-0001's
semantics and permits one route to resolve through a host profile without duplicating provider
configuration. A route with no grounded matching binding has provider `unknown`, or an explicitly
`inferred` legacy default. Migration may materialize a deterministic native default binding for an
enabled legacy Claude/Codex host, but stamps it `provenance: 'inferred'` and
`managedBy: 'unknown'`; it does not fabricate observed evidence or agentic-kit ownership.

Bindings initially live at the project `kit.json` scope. A binding may reference an external
machine/user host-native profile, but reference does not transfer ownership. Machine-wide binding
precedence is deferred until it has a concrete need and an explicit scope model.

A binding has a stable explicit or deterministically generated ID; array position is never
identity. Disabling or undoing one binding cannot affect another binding to the same provider.

### 7. Validate endpoints and never persist secrets

Endpoint validation distinguishes:

- trusted local HTTP only on literal loopback addresses (`127.0.0.0/8`, `::1`, or `localhost`);
- remote endpoints only over HTTPS;
- unknown or malformed endpoints, which are rejected rather than repaired by guessing.

Endpoints containing user information, fragments, or secret-bearing query parameters are rejected.
Normalization does not follow redirects or resolve hostnames to infer trust. An endpoint is stored
only as non-secret configuration.

Provider adapters list credential environment-variable names. `kit.json`, ownership receipts,
plans, diagnostics, and serialized facts never contain API keys, OAuth tokens, authorization
headers, or credential-bearing URLs. Credential detection reports only states such as present,
missing, not-required, or unknown.

### 8. Prove the model with Ollama, OpenRouter, and OpenCode

#### Ollama through two hosts

The first multi-host provider proof is two independent bindings to the one `ollama` provider:

```text
ollama-via-claude: host=claude, provider=ollama,
  transport=anthropic-compatible, endpoint=http://127.0.0.1:11434

ollama-via-codex: host=codex, provider=ollama,
  transport=openai-compatible, endpoint=http://127.0.0.1:11434/v1
```

Host-specific transcript parsing remains unchanged. Provider attribution becomes configured when
the binding establishes it and observed only when bounded runtime/catalogue or correlated evidence
does. Exact model digest and local `$0` claims remain gated by ADR-0011 and
`docs/LOCAL-MODEL-VALIDATION.md`. Until that evidence is captured, representation of the bindings
does not claim that compatibility-layer behavior has been observed. Each binding has independent
ownership and teardown.

This is a **structural proof**, not a runtime-local-model proof. It establishes that one provider
can be represented behind two hosts without collapsing their identities, configuration,
ownership, or teardown. It does not establish that an Ollama-backed session ran, that its
transcript semantics match a compatibility specification, or that usage may be classified and
priced as local.

#### Dependency boundary with ADR-0011

ADR-0016 owns the general integration architecture: adapter axes, capabilities, bindings,
lifecycle, migration, ownership, normalized facts, and provenance. Its acceptance depends on
those contracts being implemented and tested.

ADR-0011 independently owns evidence-backed local-model usage behavior: Ollama catalogue reads,
digest identity, index-time local provenance, alias ambiguity, local/unpriced cost states,
metered/local token splits, and transcript-fidelity notes. ADR-0011 remains Proposed until its
validation sessions and implementation are complete.

Therefore ADR-0011 does **not** block acceptance of ADR-0016. It blocks only claims that an actual
Ollama-backed execution has been observed, identified, priced, or characterized. The Ollama
catalogue/runtime descriptors and bindings introduced here are extension seams for ADR-0011, not
evidence that ADR-0011 has been implemented.

#### OpenRouter behind a host

OpenRouter is a metered provider/gateway with environment-only credentials and compatible
transports. It binds behind Claude, Codex, OpenCode, ruflo, or AQE where a concrete projection
supports it. It never enters the host registry.

A host transcript proves the host. OpenRouter response metadata can prove the provider and exact
model. The two evidence streams describe one execution only when correlation is grounded. The
normalized fact/resolution seam remains the future integration point for correlated execution
evidence. Issue #59 found that OpenRouter's supported activity endpoint exposes no such correlation
key, so ADR-0009 §9 keeps its explicitly refreshed account analytics separate from transcript and
host totals instead of manufacturing a join.

#### OpenCode at initial adoption

OpenCode uses the same host lifecycle, normalized facts, projections, and observability contracts
for its supported surfaces. Its initial adapter declared `primary: false` and
`activityRouting: false`. ADR-0018 is the subsequent grounded routing design: it enables explicit
`ak run` activity routes while retaining `primary: false`, no AQE-provider projection, and no
provider inference from the configured model selector.

### 9. Deliver in compatibility-preserving slices

Implementation proceeds test-first:

1. Add registry contract tests and pure schema validation.
2. Extract existing Claude/Codex and provider metadata into registries; retain derived
   compatibility exports and CLI-output parity where practical.
3. Add the shared lifecycle/conformance harness and move native writes behind projection adapters.
4. Make setup, status, sync, provider selection, verify, and uninstall consume the same normalized
   facts and lifecycle results.
5. Add versioned binding migration, resolver, provenance, and endpoint validation.
6. Prove the two Ollama bindings, OpenRouter's provider-only identity, and OpenCode's negative
   routing capabilities.
7. Migrate dashboard, Live, usage, and transcript consumers away from incidental lists.
8. Align README, provider, routing, usage, transcript, local-model, managed-tool, upgrading, and
   troubleshooting vocabulary.

Compatibility exports and hardcoded lists are removed only after every consumer has migrated.
Each slice must keep runtime dependencies at zero and use fixtures or injected adapters so tests do
not write real home/global configuration.

## Compatibility and non-goals

- Existing Claude/Codex behavior, `kit.json`, routing defaults, and primary-host mirroring remain
  valid. ADR-0018 keeps `ak dual` as a deprecated compatibility projection and makes `ak run` the
  canonical executor.
- Provider count does not change host identity or create an inference-provider execution host.
- It does not implement every provider, a public adapter SDK, or arbitrary third-party code
  loading.
- It does not persist credentials.
- It does not make every managed host primary or routable.
- It does not make OpenCode routable.
- It does not claim that OpenRouter account analytics is a transcript or per-session evidence source.
- It does not claim provider provenance from host evidence alone.
- It does not add dashboard writes or controls.
- It does not silently adopt or overwrite externally managed configuration.
- It does not mutate Codex's plugin cache; plugin refresh and disable remain Codex-native actions.
- It does not collapse Ruflo's compatibility and native project-memory stores into one database.
- It does not implement or make unverified Ollama execution, usage-pricing, catalogue-metadata, or
  transcript-fidelity claims; those remain gated independently by ADR-0011.

## Consequences

New built-in hosts and providers become additive registry entries plus their own adapters and
contract tests. A new host cannot validate without a setup trust declaration, and setup/host-pick
preflight derives its disclosure from that registry rather than adding a host-specific branch.
Commands and UI use a common vocabulary and cannot accidentally expose a provider
as a routing host. One provider can be represented behind several hosts, while ownership and
teardown remain binding-specific.

The cost is a larger explicit domain model, a compatibility layer while consumers migrate, and
field-level provenance throughout status and observability. Those costs are intentional: a simple
combined “provider” abstraction would preserve today's ambiguity and make its conclusions easier,
but less truthful.

## Acceptance mapping

| Issue #71 acceptance criterion | Decision and proof |
|---|---|
| ADR covers axes, capabilities, migration, ownership, provenance | Sections 1–7 |
| Existing Claude/Codex behavior/config remain compatible | Section 6 and compatibility list |
| Four registries have validation tests | Sections 1 and 9 |
| Lifecycle commands derive behavior from capabilities | Sections 2, 3, and 9 |
| Primary/activity routing is capability-limited | Section 2; OpenCode negative test |
| One provider binds to multiple hosts | Section 8; two Ollama bindings |
| Ollama through Claude and Codex is represented | Section 8 structural binding proof; runtime and usage claims remain ADR-0011 scope |
| OpenRouter is a provider behind a host | Section 8; typed registry rejection as host |
| Status/dashboard separate host, provider, model, billing, provenance | Section 5 |
| npm-managed vs external ownership is truthful | Section 4 |
| API keys are never persisted | Section 7 and serialization tests |
| Dry-run/idempotence/undo/no-clobber are shared and tested | Sections 3 and 4; conformance suite |
| External plugin hooks and runtime-selected memory are truthful | Section 4; read-only plugin diagnostics and isolated memory round-trip |
| Issue #59 can consume the abstraction without being subsumed | Sections 5 and 8 |
| Documentation uses one vocabulary | Section 9 |

The registries, lifecycle conformance suite, compatibility fixtures, consumer migration, and
structural proving integrations are implemented and tested, so this ADR is **Accepted**. That
status does not advance ADR-0011: local-model runtime evidence and usage behavior remain Proposed
work under ADR-0011's own validation requirements.
