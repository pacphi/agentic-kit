# ADR-0028 — One generic local OpenAI-compatible provider, not a vendor enumeration

- **Status:** Accepted
- **Date:** 2026-08-11
- **Updated:** 2026-08-25
- **Update note:** Accepted with corrections after review of PR #131: the quoted Hermes
  `api_mode: openai` value is annotated as invalid rather than reproduced as valid (F-30), and the
  AQE-projection asymmetry between `ollama` and `local-openai` is now stated explicitly as
  intentional (F-29). Implemented with in-tree projections `['ruflo', 'codex', 'opencode']`.
  Reconciled after ruvnet/ruflo#2962: projection is configuration eligibility, not proof that
  Ruflo's direct `agent_execute` dispatcher implements an arbitrary provider id.
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0011](0011-local-model-provenance-zero-cost-and-transcript-fidelity.md),
  [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0021](0021-inference-provider-provenance.md)

Proposed by [@adrianco](https://github.com/adrianco) in
[PR #131](https://github.com/pacphi/agentic-kit/pull/131); accepted with the corrections recorded
below.

## Context

[ADR-0016](0016-capability-driven-integration-adapters.md) separates inference **providers** from
execution **hosts**, and [ADR-0011](0011-local-model-provenance-zero-cost-and-transcript-fidelity.md)
governs what a local provider may claim. The provider registry declared exactly **one** local
provider — `ollama` — and `BUILTIN_BINDINGS` carried exactly two local bindings,
`ollama-via-claude` and `ollama-via-codex` (`src/lib/adapters/registries.mjs`,
`src/lib/adapters/bindings.mjs`).

Ollama is not the only way a local model is served, and on real machines it is frequently not the
one in use. A local inference server is normally reached as an **OpenAI-compatible HTTP endpoint on
loopback**: MLX/`mlx_lm.server`, LM Studio, `llama.cpp`'s server, and vLLM all present that shape.
Nothing in ak could name such an endpoint as a provider, so a machine running one had its local
inference either invisible or misfiled.

This was observed on the proposer's reference machine. `~/.hermes/config.yaml` declared:

```yaml
provider: mlxlocal
providers:
  mlxlocal:
    api: http://127.0.0.1:8080/v1
    api_mode: openai
    default_model: mlx-community--Qwen3-Coder-Next-4bit
```

`api_mode: openai` is not a valid Hermes value — verified against `NousResearch/hermes-agent`
v0.20.0's `_parse_api_mode`, which silently **drops** an unrecognized value rather than raising.
The valid set is `{chat_completions, codex_responses, anthropic_messages, bedrock_converse,
codex_app_server}` (the newer key spelling is `transport`); `chat_completions` is the correct value
here, and it is also the default the parser falls back to, which is why the endpoint worked despite
the invalid setting. The quote above is reproduced verbatim because it is what the proposer's
machine observed — but `api_mode: openai` is not read as valid Hermes configuration by this ADR.

Two facts survive that correction. First, the endpoint is a plain OpenAI-compatible loopback URL —
the generic shape, not a vendor-specific protocol. Second, **the provider name is user-chosen**
(`mlxlocal`). No enumeration of vendor ids can cover that case; a registry that lists `mlx`,
`lmstudio`, `llamacpp`, and `vllm` still has no row for `mlxlocal`.

The binding machinery already accommodates this. `validateEndpoint` accepts loopback `http://`
while rejecting remote `http://`, embedded credentials, fragments, and secret-bearing query
parameters (`src/lib/adapters/config.mjs`). `http://127.0.0.1:8080/v1` was already a legal binding
endpoint; only the provider row was missing.

## Decision

### 1. Add one generic provider row: `local-openai`

A single provider represents "an OpenAI-compatible model server the user runs locally", regardless
of which program serves it:

- `billing: 'local'`, `credentials: { kind: 'none' }`, `capabilities.pricing: 'zero'` — required by
  the registry's own construction invariants for a local provider (`validateRegistries`), and
  correct: a loopback server bills nothing. A server that wants a placeholder token does not make
  the credential *required*, so `kind: 'none'` remains accurate.
- `transports: ['openai-compatible']` — the only transport the row may claim. Anthropic-compatible
  and native shells stay Ollama's, established separately.
- `capabilities.modelDiscovery: false`, `runtimeDiscovery: false`, `quota: false`,
  `cacheAccounting: 'unknown'`. A generic endpoint exposes no catalogue ak may rely on. Claiming
  `/v1/models` discovery would assert a uniformity across MLX, LM Studio, llama.cpp, and vLLM this
  ADR has not measured.
- `observability: []`. Ollama keeps `ollama-catalog` / `ollama-runtime`; the generic row gets
  neither, because it has no daemon API ak has verified.

`ollama` is unchanged. It keeps its richer transports and its two observability sources precisely
because those rest on a specific, known daemon.

### 2. The endpoint carries the identity; the provider row does not

Which program serves a `local-openai` binding is recorded as the **binding's** endpoint and model,
not as provider identity. A user running MLX on `:8080` and LM Studio on `:1234` has two bindings
against one provider — the same relation ADR-0011 already names for `ollama-via-claude` /
`ollama-via-codex`, one level more general.

Consistent with [ADR-0021](0021-inference-provider-provenance.md), such a binding establishes
**configured** provenance and nothing stronger. The endpoint is user-declared, so it may not be
displayed as observed, and it does not upgrade model, token, cache, or digest claims. The `$0`
claim is the one exception and is a property of the billing type, not of evidence about the run.

### 3. No built-in bindings for the generic provider

`BUILTIN_BINDINGS` gains nothing here. Ollama's two rows are justified by a fixed, well-known
default port; a generic local endpoint has no default ak may presume. Bindings are declared by the
user in `kit.json` and validated by the existing `assertValidBinding` path. "Local" is a billing
claim (user-run, `$0` — ADR-0011), not a topology constraint: a binding may name a user-run server
on another machine over `https`, while plain `http` remains loopback-only per `validateEndpoint`.

### 4. Replace the derived capability block with per-entry data

`providerEntries` previously derived capabilities from identity comparisons inside a `.map`
(`modelDiscovery: id === 'ollama'`, `pricing: id === 'ollama' ? 'zero' : …`). That construction does
not survive a second local provider: `local-openai` needs `pricing: 'zero'` without
`modelDiscovery`, which the `id === 'ollama'` coupling cannot express. Provider entries become
explicit records carrying their own capability block, matching how `hostEntries` is already
written.

### 5. `local-openai` projects to `['ruflo', 'codex', 'opencode']`, and is not an AQE provider type

The in-tree row declares projections `['ruflo', 'codex', 'opencode']`. Two omissions, both
deliberate:

- **No `'claude'` projection.** The row claims only the OpenAI-compatible transport; Claude's
  projection expects an anthropic-compatible surface, which is Ollama's arrangement, not this
  provider's.
- **No `'aqe'` projection — `local-openai` is not an AQE provider type; `ollama` is.** AQE's
  provider set is upstream's own enumeration (`ollama`, `onnx` are its local types), not something
  ak may extend by adding a row to its own registry. Projecting `local-openai` into AQE would
  fabricate a provider identity AQE has never declared it understands. This is an intentional
  asymmetry, not a bug: `ollama` gets AQE projection because AQE names it; `local-openai` does not,
  because AQE does not. `ak status`'s provider surface reflects this distinction; surfacing it
  clearly is a sibling work package's scope, not this ADR's.

`'ruflo'` has the same bounded meaning as every projection in this domain: the relationship can be
represented on Ruflo's provider-configuration surface. It does **not** claim that Ruflo's direct
agent executor dispatches an arbitrary provider name. Ruflo 3.38.8 fixed persisted provider
selection for its implemented Ollama and OpenRouter branches (ruvnet/ruflo#2962); it did not add a
generic `local-openai` branch. Therefore a `local-openai` binding is not direct-agent-execution
evidence, and agentic-kit must not present registration as successful selection or execution.

## Consequences

- A machine serving models from MLX, LM Studio, llama.cpp, vLLM, or anything else speaking
  OpenAI-compatible HTTP on loopback can be described to ak without a new ADR per vendor, and
  without inventing a provider id the user did not choose.
- Every host with a concrete OpenAI-compatible projection can gain a nameable local provider; a
  registry projection alone does not make another tool's direct executor support that provider id.
- The generic row deliberately supports **less** than `ollama`: no catalogue, no runtime probe, no
  digest. Surfaces that show local-model detail for Ollama will show less for `local-openai`, and
  that gap is the honest reading of the evidence, not a defect to paper over.
- `local-openai` is not an AQE provider type and is not projected as one. AQE's own local routing
  (`ollama`, `onnx`) is a separate axis, defined upstream, and untouched by this ADR.

## Alternatives considered

- **Named rows per runtime (`mlx`, `lmstudio`, `llamacpp`, `vllm`).** Rejected for this revision on
  two grounds. It cannot cover a user-named provider such as the observed `mlxlocal`, so the
  generic row is required regardless and the named rows would be additive decoration. And each row
  would assert transport and discovery facts for a server this repository has not measured —
  precisely the derivation-without-measurement that
  [docs/LOCAL-MODEL-VALIDATION.md](../LOCAL-MODEL-VALIDATION.md) exists to correct. Named rows
  remain available later, gated on an evidence pass of the same kind, and would then be able to
  claim real `/v1/models` discovery instead of guessing at it.
- **Extend `ollama` to mean "any local server".** Rejected: it would make an established provider
  id lie about which daemon is answering, and `ollama-catalog` / `ollama-runtime` would be attached
  to endpoints that serve neither.
- **Infer the runtime by probing the endpoint.** Rejected as a default: ak would be spawning
  network probes during status collection to manufacture an identity claim that ADR-0021 would then
  have to grade as inferred anyway. The user naming their own binding is cheaper and more honest.

## References

- `src/lib/adapters/registries.mjs` (`providerEntries`, `validateProviderAdapter`,
  `validateRegistries` local-billing invariants), `src/lib/adapters/bindings.mjs`
  (`BUILTIN_BINDINGS`, `assertValidBinding`), `src/lib/adapters/config.mjs` (`validateEndpoint`
  loopback rule).
- ADR-0011 (local-model provenance, `$0`, transcript fidelity), ADR-0016 (provider/binding
  separation), ADR-0021 (provenance is carried, never upgraded).
- Observed local configuration: `~/.hermes/config.yaml` on the proposer's reference machine
  (`api: http://127.0.0.1:8080/v1`); the file's `api_mode: openai` is not a valid Hermes value (see
  Context) and is not cited as correct usage.
- Hermes source verified for the `api_mode` correction: `NousResearch/hermes-agent` v0.20.0,
  `_parse_api_mode`.
- [PR #131](https://github.com/pacphi/agentic-kit/pull/131) — original proposal, including
  companion proposals for a host-adapter extension point (that PR's ADR-0029) and a Hermes reference
  adapter (that PR's ADR-0030), neither adopted into this repository by this ADR.
- Tests: `tests/kit/adapter-registries.test.mjs` (deep-equality pin for the five pre-existing
  providers, registry invariants for a second local provider, binding validation against a
  loopback OpenAI-compatible endpoint).
