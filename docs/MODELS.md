# Model lifecycle intelligence

Model lifecycle intelligence answers three questions without changing your routing:

1. Which concrete models are configured, observed, or discoverable for each host?
2. What changed between trustworthy, same-scope snapshots?
3. Which routes and consumers would a model swap affect?

The inventory is evidence, not configuration. `kit.json.routing` and `ak host pick` remain the
canonical routing surfaces.

## Quick start

```bash
ak models refresh
# After upgrading Agentic Kit, refresh only Claude evidence if that is all you need:
ak models refresh --host claude
ak models status
ak models diff
ak models explain codex:gpt-5.6-terra
ak models plan --activity testing --from codex:gpt-5.4 --to codex:gpt-5.6-terra
```

Only `refresh` contacts model sources or writes a snapshot. `status`, `diff`, `explain`, `plan`,
the `ak status` models row, and the Dashboard's **Usage → Models** view read the local cache.

Use `--json` with any command for the normalized evidence contract. Use `--host HOST` to select
one source, `--all` for Claude, Codex, OpenCode, and Ollama, and `refresh --online` to permit
OpenCode's explicit catalogue refresh. Ordinary refresh does not opt into an online catalogue
request. Claude refresh includes Agentic Kit's dated, bundled transcription of Anthropic's public
model and deprecation records; it does not require an Anthropic API key or make a network request.

## What each state means

The states are deliberately independent:

| State | Meaning |
|---|---|
| Configured | A local route or host setting names the model. |
| Effective | Host precedence or alias resolution currently selects it. |
| Observed | Structured local usage evidence recorded it. |
| Discoverable | The current host/provider catalogue included it. |
| Entitled | The active account or profile is proven able to use it. |
| Policy allowed | Managed or user policy permits it. |
| Routable | The complete host, provider, auth, and capability path is proven. |
| Lifecycle | Active, preview, hidden, deprecated, retiring, removed, or unknown. |
| Recommended | A named first-party or evidence-backed source recommends it. |

`unknown` is not `false`. For example, a Codex cache entry can prove discovery without proving
account entitlement; a configured Claude alias can be effective without proving catalogue
completeness.

## Sources and scope

The source adapters are:

- Claude user settings, platform managed policy, model aliases, a model-only environment allowlist,
  and a dated first-party public record transcribed from Anthropic's model overview and model
  deprecation tables;
- the Codex model cache plus top-level `config.toml` model selection;
- OpenCode's project/provider-scoped verbose `models` output plus its resolved `debug config` view;
- the local Ollama `/api/tags`, bounded `/api/show`, and `/api/ps` catalogue/runtime facts; and
- sanitized model ids from the existing local usage index.

The collector selects these adapters from the immutable model-discovery descriptor registry. Each
source record retains its owner and owner type, file/command/HTTP/index transport, `never`/`local`/
`explicit` network policy, local/online collection mode, schema, freshness, completeness, and scope.
A descriptor authorizes only its matching built-in parser; it cannot supply executable code or give
an external host an inferred catalogue capability.

Claude managed policy is read from the platform path when present:

- macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`;
- Linux: `/etc/claude-code/managed-settings.json`; and
- Windows: `C:\ProgramData\ClaudeCode\managed-settings.json`.

The process environment contributes only `ANTHROPIC_MODEL` and the three
`ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` alias targets. Other environment values, including
credentials and endpoints, do not enter collection.

Native inputs are untrusted. Parsers cap bytes and row counts, guard schemas and enums, and invoke
commands with literal argument arrays and no shell. Interactive picker scraping and inference
probes are excluded.

The lookup contracts were checked against current first-party documentation in August 2026:

- Anthropic's [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
  establishes current API ids, aliases, published availability, input/output modalities, context
  and output limits, thinking support, and list prices. Its
  [Model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations) page
  establishes lifecycle terms, retirement commitments or dates, and recommended replacements.
  Lifecycle dates apply to Anthropic-operated platforms; Amazon Bedrock and Google Cloud can use
  different schedules. Agentic Kit dates this bundled source and marks it stale after 90 days, so
  updating Agentic Kit—not repeatedly refreshing the same installed version—is how public facts are
  renewed.
- Anthropic's authenticated [List Models API](https://platform.claude.com/docs/en/api/models/list)
  can identify models available to one Anthropic API account and returns limits and capabilities.
  Agentic Kit does not silently call it: an API-key-scoped result cannot prove Claude Code plan
  access or partner/OpenRouter availability, and credentials never enter the inventory.
- Claude accepts aliases or a full model name through its documented model selection surfaces. Its
  `[1m]` suffix selects an extended-context variant and is stripped before Claude Code sends the
  base model id to the provider
  ([Claude Code model configuration](https://code.claude.com/docs/en/model-config)). Agentic Kit
  therefore retains the full selector as configuration/alias evidence while joining its facts to
  the base model identity.
- OpenCode exposes `opencode models [provider] --verbose`; `--refresh` refreshes its
  Models.dev-backed cache ([OpenCode models](https://opencode.ai/docs/models/)). Agentic Kit runs
  refresh separately from the verbose list so OpenCode's success banner cannot degrade the list.
  It reads `opencode debug config` for the resolved global/project/JSONC configuration, including
  root, agent, and command model overrides. Model references accept bounded non-control
  `provider/model`, an optional `#variant`, or the expanded selector object; current OpenRouter
  `~publisher/model` values are valid ids, not parser errors.
- Models.dev publishes provider-independent human names, labs, serving providers, limits,
  capabilities, pricing, release dates, and explicit weight links through JSON endpoints
  ([Models.dev](https://models.dev/)). Catalogue presence proves discovery, not account access.
- Ollama refresh prefers the loopback [list models](https://docs.ollama.com/api/tags),
  [show model details](https://docs.ollama.com/api-reference/show-model-details), and
  [list running models](https://docs.ollama.com/api/ps) APIs. It retains bounded installed-model
  metadata and loaded memory/context/expiry facts, never raw templates, model files, or full license
  bodies. `ollama ls` is a partial compatibility fallback when the local API is unavailable.
  Installed or loaded remains distinct from successful observed inference.
- User-facing GPT-5.6 examples use current official ids and reasoning levels
  ([OpenAI model catalogue](https://developers.openai.com/api/docs/models)). Codex's local cache is
  still treated as a guarded native schema, not as a public API contract.

Host, provider, concrete model id, a non-identifying scope id, and an evidenced mutable local digest
form model identity. Reasoning effort, context, service tier, and similar execution settings remain
variants rather than unrelated base identities. Account, profile, and project scope values are
HMAC-fingerprinted with a private per-install key; raw scope values do not enter the snapshot. The
private cache and key live under the Agentic Kit configuration directory with owner-only
permissions.

A host-owned first-party catalogue can omit provider identity even when usage evidence names it.
For the same host, model id, scope, and digest, Agentic Kit joins provider-neutral Claude/Codex
catalogue facts only when an independent record establishes the expected `anthropic`/`openai`
provider path. This prevents duplicate title-case and lowercase rows without inferring that a
custom gateway or other provider is the same deployment; those paths remain separate records.

Known fields have field-specific evidence references. A configured route can prove `configured`, a
structured successful invocation can prove the exact observed path's `observed`, `entitled`,
`policyAllowed`, and `routable` facts at capture time, and a catalogue can prove `discoverable`.
None of those facts silently strengthens another path or establishes catalogue completeness.

For a current public Claude model, the bundled first-party record can therefore make publication,
lifecycle, recommended status, context/output limits, supported modalities/tools/thinking, and a
dated API list price known. `configured`, `entitled`, `policyAllowed`, and `routable` remain unknown
until local evidence establishes each one. To establish the path in Agentic Kit, configure the exact
model and serving provider on an intended route, authenticate that provider, complete one successful
invocation, and run `ak models refresh` again. A Claude model published by Anthropic is not thereby
proved routable through OpenRouter, Bedrock, Vertex, or a particular Claude subscription.

## Snapshots and diffs

Snapshots retain at most 32 captures per scope and expire after 90 days. A complete same-scope
snapshot may advance the comparison baseline. Partial, stale, unavailable, or unsupported-schema
sources remain visible but cannot displace that baseline.

Without an authoritative first-party removal signal, a missing model must be absent from two
consecutive complete same-scope snapshots before it becomes a removal. Partial evidence never
creates removals. Cross-scope comparison is refused instead of appearing as mass churn.

Diffs report model additions/removals, alias-target continuity and changes, lifecycle transitions,
visibility, capabilities, local digest, reasoning, context, other variants, optional pricing, and
typed-edge changes. Every normalized field carries evidence source, class, capture time, freshness,
completeness, and scope. A digest change stays one comparable local model lineage rather than
appearing as an unrelated add/remove pair. Lifecycle, pricing, and edge comparisons ignore changing
evidence-reference ids and capture timestamps, so an identical semantic fact does not churn.

## Read-only swap plans

`ak models plan` checks mechanical compatibility only. `false` discovery is a blocker. Unknown
discovery is also a blocker unless structured evidence proves that exact model path was observed
successfully; in that case the plan keeps an explicit catalogue-unknown warning. Entitlement,
policy, routability, and required capability facts must still be established. The plan does not
claim quality equivalence, lower cost, or equal performance unless a separate evidence source
establishes that.

Selectors use `HOST:MODEL`; OpenCode's provider-qualified form is
`opencode:PROVIDER/MODEL`, for example `opencode:openrouter/anthropic/claude-sonnet-4.5`.

A successful plan lists affected canonical routes, escalation rungs, integration bindings, and
independently sourced Agentic QE/Ruflo consumers. It prints a copyable `ak host pick --route ...`
command but does not execute it. There is no `ak models apply`.

The same snapshot can produce a pure Route Intelligence feed: mechanically eligible candidates,
current optional pricing metadata, and lifecycle/alias/capability/variant invalidations whose audit
history must be retained. The feed explicitly sets quality and economics claims to false;
[Issue #109](https://github.com/pacphi/agentic-kit/issues/109) must establish any evidence-backed
equivalence or cost recommendation.

The `ak status` row may point to `ak models refresh` or `ak models diff`, but `ak sync` excludes
model actions from its executable convergence plan. Catalogue refresh and route mutation remain
explicit operator boundaries.

## Dashboard

Open `ak dashboard`, then choose **Usage → Models**. The view includes:

- attention items for degraded sources, cited lifecycle migrations, alias changes, and drift;
- a semantic host/model table with every independent state;
- bounded, scrollable same-scope change history with the exact model, provider, host, plain-language
  change, evidence status, and detection time;
- configured and reported consumers;
- read-only swap-impact guidance; and
- evidence source status and capture time.

The Models view loads only when it opens. It leads with **Your routes** — the configured primary and
fallback paths — and keeps the catalogue explorer collapsed until requested. The explorer first
fetches the small summary and then the first 50 relevant rows; catalogue-only rows load in explicit
pages. Search, access host, model provider, view, lifecycle, and evidence filters reset
pagination. Every sortable catalogue column keeps unknown values last, and its bounded table
scrolls internally with a sticky header and an explicit **Load 50 more** control.

A lifecycle migration becomes an alert only when the model is configured/effective or observed
locally and the snapshot includes a direct first-party withdrawal-notice URL with matching
first-party lifecycle evidence. Provider history remains available in the full catalogue but does
not flood the in-use view or create local migration warnings. A local host cache's `upgrade` hint or
a preferred successor remains a discovery detail, never a retirement claim or route rewrite.

Source-proven public catalogue records show a human name, host, publisher when proven, serving
provider when known, exact public selector, and trusted documentation/catalogue links. The bundled
Anthropic record supplies first-party public identity, specifications, lifecycle scope, and
publication status for its exact documented Claude ids and aliases. Codex cache identity can
qualify locally. OpenCode identity qualifies
only after `refresh --online` exact-joins the selector to the independently fetched, size-bounded
Models.dev catalogue; provider syntax or verbose metadata alone is not proof. The Models.dev source
link remains generic unless that source supplies an exact canonical page. Hugging Face and Ollama
links appear only when source metadata verifies the exact repository/library identity. Custom
providers, private deployments, local tags, and observed-only ids appear with their exact bounded
model selector, display name, and independently recorded provider in the owner-only Dashboard.
Configured variants, digests, aliases, binding ids, scopes, snapshot ids, evidence ids, credentials,
and endpoints remain hidden transport joins only. Change history uses the same owner-visible exact
model identity as the route and catalogue views, but never exposes the underlying identity join. The
browser never derives a provider or publisher from a name and never invents an external link.

An `unknown` cell explains which evidence is absent. Model details separately name published or
discovered status, account access, local routability, and the operator's next evidence step. The
table labels the discovery dimension **Catalogued**, not **Available**, so provider publication or
local discovery cannot be mistaken for account entitlement. A local refresh now resolves OpenCode's
effective configuration, removing unknowns caused only by ignored global, JSONC, agent, or command
layers. Discovery still does not establish entitlement; configuration does not establish successful
use; and a model id never establishes the serving provider. Catalog Explorer model details show an
identical source, class, capture time, freshness, and completeness summary once even when that source
establishes several fields. The independent field evidence references remain intact and each state
cell still discloses its own evidence. A missing or invalid key fails the API
closed, an ordinary Dashboard read never creates one, and all reads retain loopback, session-token,
CSP/origin, `no-store`, and no-egress protections.

## Privacy and recovery

Snapshots contain no credentials, prompts, reasoning traces, transcript text, private endpoints,
or raw account/profile/project identifiers. Because the owner-only cache supports explicit local
CLI evidence, it can retain bounded exact configured model or deployment identifiers. The
Dashboard receives bounded exact model identity for its token-gated loopback owner view; credentials,
endpoints, scope, digests, aliases, and evidence identifiers never cross that boundary. A corrupt
cache degrades to an empty readable store;
run `ak models refresh` to rebuild it. A source schema failure is isolated to that source and shown
as `unsupported-schema` rather than converted to an empty catalogue.

This enrichment never rewrites Historical Usage sessions, prices, transcript model attribution, or
Observability live/history records. Those contexts remain source owners; Model lifecycle consumes
only their bounded aggregate host/provider/model facts and publishes a separate cache/read model.

For common failures, see [Troubleshooting](TROUBLESHOOTING.md). The domain and decision records are
[Model lifecycle intelligence](ddd/model-lifecycle-intelligence.md) and
[ADR-0032](adr/0032-model-lifecycle-intelligence.md).
