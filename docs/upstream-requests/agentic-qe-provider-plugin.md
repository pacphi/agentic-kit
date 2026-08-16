<!--
  DRAFT upstream capability request — NOT yet filed.
  Authored by agentic-kit for the ADR-0031 §4 upstream path. Review, RE-VERIFY the
  code references against agentic-qe HEAD (they are grounded against agentic-qe@3.13.10
  as cited in ADR-0031 and may have moved), then file against
  https://github.com/proffesor-for-testing/agentic-qe and record the resulting issue
  number with `ak host adapters gate <adapter> session-driving agentic-qe#NNN`
  (or the relevant tier).
-->

# Feature request: a provider-plugin registration API for `AQE_LLM_PROVIDER`

## Summary

agentic-qe's LLM provider set is a closed, upstream-defined enumeration. A downstream
integrator (agentic-kit) can select any *existing* provider via `AQE_LLM_PROVIDER`, but
cannot introduce a *new* provider type without an upstream code change. We'd like a
documented registration surface so a host that a downstream tool supervises can be
recognized as its own provider identity, rather than only borrowing the model provider
underneath it.

## Where this stands today (please re-verify against HEAD)

Grounded against `agentic-qe@3.13.10` (as cited in agentic-kit's ADR-0031):

- `ALL_PROVIDER_TYPES` is a fixed union of provider type strings.
- `createProvider` is a `switch` over those types; an unrecognized type has no arm.
- So the provider set is extended only by editing that enum + switch — there is no
  runtime/plugin registration path.

If any of this has changed on HEAD (a registration hook, an open provider map, a plugin
entrypoint), this request may already be satisfied — please close it as such.

## The concrete ask

A minimal, documented way for a downstream tool to register an additional provider type at
runtime, e.g.:

- a `registerProvider(type, factory)` entrypoint (factory conforming to the same interface
  `createProvider` returns), and inclusion of registered types in `ALL_PROVIDER_TYPES`
  for validation; **or**
- a documented "external provider" adapter interface a downstream package can implement
  and hand to the `HybridRouter` / `ProviderManager`.

We are not asking to widen the *default* provider set — only for a sanctioned extension
point so `AQE_LLM_PROVIDER=<our-host>` can resolve to a provider we supply, instead of us
either forking the enum or projecting our host onto an unrelated provider identity (which
would misrepresent which vendor served the work).

## Why (the downstream context)

agentic-kit admits external host adapters (declarative manifest + consented subprocess
hooks) and runs a tiered conformance kit against them. Quality still runs through the
*model provider underneath* a host, so QE is never blocked — but a host cannot earn an
**AQE-provider identity** of its own, because that identity is yours to define, not ours to
extend. agentic-kit deliberately refuses to fabricate one (projecting an unknown host into
your config would assert an identity you never declared you understood). This request is
the honest alternative: a real extension point, so the capability can light up when you
release it.

## Non-goals

- Not asking agentic-kit's hosts to be bundled into agentic-qe.
- Not asking to bypass any provider validation — registered providers should be validated
  exactly like built-in ones.

## References

- agentic-kit ADR-0031 §4 (the upstream-request path) and ADR-0029 (the host-adapter
  contract): the design that motivates this.
- `AQE_LLM_PROVIDER` / `HybridRouter` / `createProvider` / `ALL_PROVIDER_TYPES` in
  agentic-qe (re-verify paths against HEAD).
