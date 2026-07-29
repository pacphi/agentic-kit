# Integration Management Domain

This document describes the integration model implemented by
[ADR-0016](../adr/0016-capability-driven-integration-adapters.md) and `src/lib/adapters/`.

## Purpose

Integration management turns user intent and bounded observations into safe configuration actions
and honest facts. It keeps execution hosts, inference providers, configuration projections, and
observability sources independent so that adding one integration cannot accidentally grant
unrelated behavior.

The shared terms in [Ubiquitous language](ubiquitous-language.md) are normative.

## Model

```text
Host -------- ProviderBinding -------- InferenceProvider
  |                 |                         |
  |                 +-- transport             +-- billing/credentials
  |                 +-- model                 +-- provider capabilities
  |                 +-- endpoint
  |                 +-- provenance
  |
  +-- ConfigurationProjection
  +-- ObservabilitySource(s)
  +-- host capabilities
```

The four adapter registries are closed, validated, built-in code. A provider binding is persisted
relationship data, not a fifth executable adapter family.

### Host

A host describes an execution driver, install surface, native configuration projection,
observability sources, authentication hints, and explicit capabilities. Capabilities decide
whether it may drive a session, become primary, receive activity routes, expose transcripts, or
participate in other workflows.

### Inference provider

An inference provider describes credentials, transports, projections, observability sources, and
bounded capabilities such as discovery, quota, pricing, and cache accounting. Provider identity
does not imply a host or routing capability.

### Provider binding

A binding connects exactly one known host and one known provider. It names a supported transport,
configuration projection, optional model and endpoint, provenance, and ownership. Resolution
returns a binding only when the supplied criteria identify exactly one candidate.

Endpoints reject embedded credentials, fragments, secret-bearing query parameters, unsupported
protocols, and non-loopback plaintext HTTP.

## Capability rules

- Primary and activity-routing capabilities require session-driving capability.
- Commands select adapters by capability rather than recognized ID.
- Adding OpenCode does not make it primary or routable.
- Adding OpenRouter does not make it a host.
- Provider claims are rendered only when the provider declares and evidence supports them.
- Compatibility collections are derived from registries.

## Integration facts

Facts keep the axes separate:

```text
HostFact       = present + enabled + version + auth/wiring evidence
ProviderFact   = configured + reachable + billing + credential presence
BindingFact    = host + provider + model + billing + provenance + reachability
ExecutionFact  = observed host + provider + model + transport + billing
```

Presence, enablement, authentication, configuration, and reachability are independent. Missing
evidence produces `unknown` or `null`; it never produces a fabricated success, failure, cost, or
provider.

Provenance strength is `unknown < inferred < configured < observed`. Host transcripts prove host
and model fields they actually carry. Provider identity becomes observed only through
provider-specific evidence, such as response metadata or a bounded local runtime/catalog lookup.

Billing follows the access path. Anthropic or OpenAI host login may be subscription-backed, while
their API keys are metered. Ollama is local and may be priced at exact zero only after provider
identity is established.

## Managed projection lifecycle

Every managed configuration projection follows:

```text
detect -> plan -> apply -> verify -> undo
```

- `detect` is read-only and reports observed state.
- `plan` is deterministic for the same intent and facts.
- dry-run detects and plans but does not apply.
- repeated apply converges without additional writes.
- `verify` observes the target independently of the plan.
- `undo` reverses only values still equal to values written by `ak`.

Malformed, unavailable, or unsupported surfaces yield diagnostics and unknown facts rather than
guessed success.

## Ownership and drift

Presence is not ownership. External installations and pre-existing configuration remain usable but
unmanaged. An ownership receipt records the exact prior and written value for one surface or key
path. Undo restores that prior value only if the current value still equals the written value.
User or external drift is preserved.

Receipts never authorize deletion of sibling keys, containing tables, external executables, or
credential values.

## Configuration migration

`integrations.version` identifies the canonical integration envelope. Loading configuration
normalizes legacy state in memory without writing. An explicit save persists the current envelope.
Migration is additive, preserves existing bindings, and infers legacy default bindings with
`inferred` provenance.

Future schema versions and malformed binding collections are preserved opaquely rather than
downgraded or rewritten.

Historical paths under `kit.json.providers` remain compatibility surfaces during alpha. Their name
does not collapse the host and provider domains.

## Proving integrations

| Case | What it proves |
|------|----------------|
| OpenCode host | A host can be managed and observed without becoming primary or routable |
| OpenRouter provider | A provider can serve existing hosts without becoming a host |
| Ollama via Claude and Codex | One provider can have independent bindings to multiple hosts |

## Invariants

1. Host and provider namespaces are distinct.
2. Identity never grants an undeclared capability.
3. A host observation alone never proves an inference provider.
4. Unknown never silently becomes free, subscription-backed, reachable, or absent.
5. Credential values never enter registries, normalized facts, receipts, or output.
6. Loading and normalization do not mutate external state.
7. Apply is idempotent and dry-run is non-mutating.
8. Undo cannot overwrite drift.
9. Existing and future configuration survives additive migration.
10. Status, setup, sync, verify, and uninstall consume the same normalized model.
