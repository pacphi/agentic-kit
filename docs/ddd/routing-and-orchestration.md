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

RoutingPolicy -> eligible configuration projections -> AQE / MCP surfaces
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

### Divergence and retirement

Two different things can be wrong with a route's model, and they are separate concepts.

A route is **diverged** when the defaults have moved past its seeded model. Which side is better is
activity-dependent, so divergence is a trade to weigh, never a lag to clear: it is reported with both
models' cost-per-task characteristics and is only ever resolved by an explicit refresh.

A model is **retired** when its host has published a withdrawal notice for it. There is no trade —
the model stops answering — so a retired model is substituted for its replacement at the point every
dispatch path reads the policy, and seeded routes naming one are rewritten on the next sync. A route
that was substituted reports the id it replaced, so a surface never silently disagrees with the file
on disk.

Retirement is the single case in which a `user` route is overridden, and only for the run: honoring
a pin into a withdrawn model fails the work rather than respecting the intent. The persisted value is
left exactly as the user wrote it. A model that is merely superseded is diverged, not retired.

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

`kit.json.routing` is the persisted routing envelope: `version`, `primaryHost`, and per-activity
`routes`. Each route carries host/model intent plus `provenance` and an optional `escalation`
ladder. Pure projectors materialize that policy into:

- AQE `agentOverrides` for AQE-eligible Claude/Codex routes;
- `ak run`'s host-neutral worker plan;
- Codex MCP availability/configuration.

These are configuration projections, not independent routing policies. Native surfaces must not
be edited back into domain truth without an explicit import or reconciliation design.

## Canonical execution

`ak run` is the canonical executor for materialized activity plans. It can select every host whose
adapter declares `canRouteActivities`, including an explicit OpenCode route. It does not infer a
provider from a host/model selector, make OpenCode primary, or project OpenCode into AQE.

Host and provider cardinality remain separate: OpenRouter does not create another execution host,
two Ollama bindings do not create two Ollama providers, and configured host/model routes do not
prove which inference vendor served a session. OpenCode runs only through `ak run` after its host
adapter declares the required capability.

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
   never fabricated into AQE.
4. User-pinned routes are not overwritten by default refresh.
5. Primary-host selection changes leadership defaults, not host enablement symmetry.
6. Escalation is explicit, ordered, and per route.
7. Automatic seeding cannot introduce a metered provider path.
8. `ak run` is the sole executor for materialized activity plans.
