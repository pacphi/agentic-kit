# Ubiquitous Language

This glossary is normative for agentic-kit code, CLI help, ADRs, tests, and documentation. A
bounded-context document may refine a term but should link back here rather than assign a
contradictory meaning.

## Integration language

| Term | Meaning |
|------|---------|
| Host | CLI or runtime that drives an agent session, such as Claude Code, Codex, or OpenCode |
| Inference provider | Service or local runtime that performs model inference, such as Anthropic, OpenAI, OpenRouter, or Ollama |
| Model | Provider-addressable inference target used for an execution |
| Provider binding | Persisted intent connecting one host to one inference provider through a transport and configuration projection |
| Transport | Protocol used by a binding, such as native, OpenAI-compatible, or Anthropic-compatible |
| Integration adapter | Built-in descriptor and behavior for one host, provider, configuration projection, or observability source |
| Configuration projection | Native configuration surface derived from canonical intent, such as Claude JSON, Codex TOML, or an AQE router file |
| Observability source | Bounded evidence channel that may establish specific facts |
| Source adapter | Anti-corruption layer that translates native evidence into canonical facts or events |
| Capability | Explicit behavior supported by an adapter; identity alone never implies it |
| Integration intent | Desired, persisted host and binding configuration |
| Integration facts | Immutable normalized observations about hosts, providers, and bindings |

## State and evidence language

| Term | Meaning |
|------|---------|
| Present | An executable, file, endpoint, or other surface was detected |
| Enabled | Persisted user intent permits a host or integration to be used |
| Authenticated | A host login or credential mechanism is known to be usable |
| Configured | Required provider or projection configuration is present |
| Reachable | A bounded probe successfully contacted its target |
| Routable host | Host whose capabilities permit assignment of development activities |
| Primary host | Routable host selected to lead defaults and determine missing-host severity |
| Evidence | Observation supporting a fact |
| Provenance | Strength and origin of a fact: `observed`, `configured`, `inferred`, or `unknown` |
| Unknown | The available evidence cannot establish a value; it does not mean false, zero, free, absent, or unreachable |
| Ownership receipt | Exact record of a value written by `ak`, permitting narrow undo only while that value is unchanged |
| Drift | Current state differs from the last value written or expected by `ak` |

Billing is a fact about a credentialed access path or observed execution, not an immutable vendor
identity. A vendor may support subscription-backed host login and metered API-key use. Local
billing means inference is performed by a local runtime; it does not follow merely from a zero or
missing price.

## Routing and observability language

| Term | Meaning |
|------|---------|
| Activity | Canonical category of development work, such as architecture, implementation, testing, or review |
| Route | Activity assignment to a host and model, optionally followed by escalation rungs |
| Routing policy | Persisted activity-to-route intent |
| Route provenance | Whether a route is a default, seeded by `ak`, or deliberately set by the user |
| Escalation rung | Alternate host and model tried after failure when escalation is requested |
| `ak run` | Canonical host-neutral execution of a materialized routing plan |
| Read-model projection | Derived query or UI state, distinct from a configuration projection |
| Transcript host | Host whose native artifact supplied a transcript |
| Inference identity | Provider and model supported by provider-specific or out-of-band evidence |

`Dual-host` describes two enabled peer hosts, not an execution command and not evidence that two
inference vendors served a workflow. Generalized execution belongs to `ak run`.

## Usage rules

- Say **host** when referring to Claude Code, Codex, OpenCode, session drivers, leadership, or
  activity routing.
- Say **inference provider** when referring to Anthropic, OpenAI, OpenRouter, Ollama, billing,
  provider credentials, or inference endpoints.
- Qualify **projection** as configuration projection or read-model projection when ambiguity is
  possible.
- Qualify **adapter** as integration adapter or source adapter when ambiguity is possible.
- Do not infer an inference provider from a transcript host alone.
- Do not replace an unknown fact with a convenient default.

## Persisted names

- `ak host` and `ak x host` manage execution hosts and routing; they do not redefine inference
  providers.
- `kit.json.integrations.hosts` records enabled hosts. Top-level `routing` records `version`,
  `primaryHost`, and per-activity `routes`; route entries use `provenance` and `escalation`.
- Derived exports in `hosts.mjs`, `providers.mjs`, and `routing.mjs` are views, not independent
  domain registries.
