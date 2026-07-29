# Routing and Orchestration Domain

This document consolidates the routing model established by ADRs
[0001](../adr/0001-one-routing-policy-many-projections.md) through
[0006](../adr/0006-primary-host-and-ambidextrous-mirroring.md).

## Purpose

Routing assigns development activities to capable execution hosts and models. Orchestration
materializes those assignments into worker configurations and runs collaboration pipelines.
Inference-provider resolution remains a separate integration-binding concern.

## Model

```text
RoutingPolicy
  activity -> Route
                host
                model
                provenance
                escalation rungs[]

RoutingPolicy -> eligible configuration projections -> AQE / legacy dual-run / MCP surfaces
RoutingPolicy + template + task -> materialized workers -> ak run
```

### Activity

The canonical activity vocabulary is specification, architecture, design, implementation, testing,
review, security scan, security analysis, documentation, debugging, packaging, and release.
Activities describe work, not agent implementation names.

### Route

A route selects a routable host and a model for one activity. It may include ordered escalation
rungs. The host must declare `canRouteActivities`; a provider ID cannot satisfy a host reference.

Route provenance is:

- `default`: effective built-in behavior with no persisted entry;
- `seeded`: persisted by `ak` from current defaults; or
- `user`: deliberately pinned or hand-authored intent.

Refresh may update diverged seeded routes. It does not overwrite user routes.

### Primary host

The primary host determines which peer leads the default table and how missing-host status is
classified. It is separate from enablement and from the host driving the current interactive
session.

Selecting Codex as primary mirrors the default host/model assignments and escalation ladder so
Codex leads and Claude becomes the alternate. It does not disable Claude or introduce a separate
orchestrator.

### Escalation

An escalation rung is an alternate host and model attempted after failure only when escalation is
requested. The ladder is per route and may cross vendors. It is not a retry budget and does not
change the persisted base route.

## One policy, several configuration projections

`kit.json.providers.dualRouting` is the current persisted compatibility path for routing intent.
Pure projectors materialize that policy into:

- AQE `agentOverrides` for AQE-eligible Claude/Codex routes;
- `ak run`'s host-neutral worker plan;
- deprecated dual-run worker configuration for Claude/Codex-only compatibility; and
- Codex MCP availability/configuration.

These are configuration projections, not independent routing policies. Native surfaces must not
be edited back into domain truth without an explicit import or reconciliation design.

## Canonical execution and deprecated dual compatibility

`ak run` is the canonical executor for materialized activity plans. It can select every host whose
adapter declares `canRouteActivities`, including an explicit OpenCode route. It does not infer a
provider from a host/model selector, make OpenCode primary, or project OpenCode into AQE.

`ak dual run` is deprecated. It remains a Claude-and-Codex compatibility wrapper for existing
`claude-flow-codex` workflows, including its legacy escalation semantics. Workers in that adapter
may reach different inference providers through their bindings, but provider cardinality does not
change the number of execution hosts.

Therefore:

- two hosts with three or more providers remain a dual run;
- OpenRouter does not create a third orchestration host;
- two Ollama bindings do not create two Ollama providers; and
- OpenCode runs through `ak run` once its host adapter explicitly gains the required capability;
  the deprecated `ak dual` rejects it rather than changing its compatibility contract.

Generalized multi-host execution does not redefine the legacy word `dual`: only `ak run` owns that
surface. `ak dual` remains a removable compatibility path rather than a second orchestration model.

## Cost safety

Automatic seeding targets only known subscription-backed or local execution paths. Metered
providers may be selected deliberately through provider/fallback configuration, but are not
silently introduced into default activity routes.

Model catalogs are curated recommendations, not hard allowlists. Pricing and performance notes
must distinguish per-token price from measured or expected per-task cost.

## Invariants

1. Only capability-qualified hosts receive activity routes.
2. Routing host and inference provider are separate axes.
3. One canonical policy feeds all eligible downstream projections; ineligible OpenCode routes are
   never fabricated into AQE or the deprecated dual adapter.
4. User-pinned routes are not overwritten by default refresh.
5. Primary-host selection changes leadership defaults, not host enablement symmetry.
6. Escalation is explicit, ordered, and per route.
7. Automatic seeding cannot introduce a metered provider path.
8. `ak run` is the canonical executor; `dual` remains a deprecated two-host compatibility wrapper.
