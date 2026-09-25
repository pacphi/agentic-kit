# Settings organization for v5

## Recommendation

Use **eight categories organized around user intent**, with **component** as a secondary filter. Give every configuration concept one canonical editor. Open that editor from a component, an attention finding, setup, search or an operation; those are entry points, not separate copies of the setting.

Keep the global navigation stable. Persona changes what needs attention and why, plus useful shortcuts. It does not rename settings, hide administrator controls, change metric definitions or grant access. A Builder might arrive at a Review route from a blocked session; an Operator might arrive from inconsistent host configuration; an Architect might arrive from a routing comparison. All three edit the same record.

This is a product proposal. The inventory and current capability statements below are grounded in agentic-kit commit `847486c61689f8499ada08f5b5684ecf26b22db8`; the proposed organization is our recommendation, not an upstream standard.

## The eight categories

| Category | Decisions it supports | Key distinctions |
|---|---|---|
| **Hosts & installations** | Select coding hosts and tools; adopt existing installs; choose configuration/lifecycle ownership; register adapters; inspect host launch roots | Detection, installation, adoption and authorization are separate. Preserve the native package manager and authentication. |
| **Models, routing & budgets** | Choose the routing lead; route each activity; order escalation; connect providers; tune context and AQE budgets | Agent selection differs from model selection. AQE budget intent is not a proven fleet-wide cost cap. |
| **Memory & learning** | Choose embedding runtime; tune learning; control harvest; configure session recall and knowledge location | A configuration, a healthy runtime and evidence of learning are different states. |
| **Guidance, hooks & permissions** | Tune guidance; configure MCP registration/exclusions and governance; inspect hook repair | A configured governance limit is not proof of transport enforcement. |
| **Projects & discovery** | Select automatic sources, exact project folders, collection roots and exclusions | Saving discovery intent does not authorize an unbounded scan. Host configuration roots remain with host installation context. |
| **Updates & schedules** | Control release-metadata freshness; check, plan and schedule maintenance | Check caching is not update cadence. A repair's “no upgrade” input is not a permanent update policy. Schedules begin off. |
| **Fleet & sharing** | Manage enrollment, remote authority, source participation and exports | Enrollment and remote control are proposed v5 capabilities; existing fleet support exports and aggregates evidence. |
| **Data & dashboard** | Set retained scan summaries/evidence, preferred shells, display and statusline preferences, dashboard launch behavior | Retention, cleanup and source-history deletion have different owners and recovery rules. Launch flags are operation inputs. |

The existing schema spans these concerns in one configuration model; the presentation can group them by intent while preserving the original write contracts. [Kit defaults](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/config.mjs#L25), [Ruflo component contracts](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/ruflo-components/config.mjs#L3), [fleet boundary](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0054-fleet-evidence-export.md).

## The important reduction: entries are not preferences

The source catalogue contains **330 entries**: 115 current managed entries, 180 CLI entries, 17 observations, 17 proposals and one unsupported item. Twenty entries describe fields inside repeated records. Several command options expose a configuration concept already present elsewhere. The category map retains every source ID without presenting all of them as independently writable preferences. [Source inventory](settings.json), [one-to-one taxonomy map](settings-taxonomy.json).

The ordinary view is **Configuration**. Each category also offers **Run options**, **Observed state**, **Setup choices**, **Unavailable**, and **All kinds**. Search spans all kinds and displays the distinction on each result. Searching an unavailable capability explains the limitation rather than showing a disabled-looking toggle with a misleading promise.

“Advanced” should describe how much detail is disclosed within a task, not become a miscellaneous destination. An expert still benefits from finding a provider endpoint with its provider binding. A new user still needs to see the consequence of releasing ownership.

### Replace fields with meaningful records

- **Activity routes:** 36 host/model/escalation fields become 12 named activity rows. Each expands into one route editor with optional escalation details. The routing lead remains a separate setting. Native defaults, explicit pins and run-local overrides stay distinguishable.
- **Provider bindings:** ID, host, provider, model, transport, endpoint and projection form one repeatable record. Add, edit and remove records as a collection. The source inventory has member entries but no parent; the mockup supplies a composite editor without adding another source entry to the count.
- **Guidance blocks:** template, identity and detector belong together.
- **Discovery:** a folder, depth and network choice belong together. Exact projects and exclusions are their own collections.
- **External adapters:** name, source and contract version belong together. Trust and capability grants require separate decisions.
- **Dependent objects:** embedding mode, endpoint and provisioning require joint validation. A governance release invalidates an outstanding child-limit edit. Collection replacement requires a target-by-target diff when selected machines differ.

These record shapes come from the inspected schemas. The mockup demonstrates six collection editors; it does not implement every native validator. [Binding validation](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/adapters/bindings.mjs#L15), [guidance and adapter defaults](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/config.mjs#L61), [discovery defaults](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/config.mjs#L74).

## One setting, several ways to reach it

The navigation model is **purpose → small subsection → control or record**. A component filter narrows that view to its related controls. Search accepts user language, configuration keys and command vocabulary, and returns the canonical breadcrumb. The Components view uses those same controls beside ownership and lifecycle evidence.

Examples:

1. **“Change who reviews code.”** Models, routing & budgets → Activity routing → Review. Compare current and desired route; review affected machines; apply and verify.
2. **“Why is AQE memory unavailable?”** Attention finding → embedding runtime in Memory & learning. Show endpoint intent beside the failed probe; configuration and health remain distinct.
3. **“Add our repositories.”** Projects & discovery → Discovery locations. Add a record, preview scope and save intent. A scan is a separate bounded operation.
4. **“Use two workers this time.”** Search `max-concurrent` → operation input. The production UI should open the run composer with that input; this mockup opens its source contract. No permanent default is invented. [Run options](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/run.mjs#L7).
5. **“Update Sunday at 2 a.m.”** Updates & schedules → shared schedule editor. Show timezone, targets, components, allowed action and saved off state. Enabling a draft does not enable the schedule.

## Scope and ownership must remain visible

Category, component, persona and target scope are independent axes. A fleet is a set of targets; it is not automatically a new layer in every tool's native configuration precedence.

For each editable control, the production contract should expose effective value, stored override, schema/default meaning, native scope, owner, supported write path, activation effect and evidence age. “Inherited,” “unmanaged,” `null`, `false`, an empty array and zero must retain their different meanings. Mixed values must not silently become the first machine's value.

The mockup binds staged configuration to the selected machines and prevents changing that scope until the draft is reviewed or discarded. A production version should additionally bind the exact assessment revision and object identities, detect concurrent edits, and support an explicit rebase with a fresh diff. Neither a role selection nor a management checkbox expands remote authority.

Ownership examples matter more than generic enable/disable labels:

- Ruflo's promotion flag `false` actively suppresses promotions. Its memory-durability and turn-credit options are reporting/check choices. [Component configuration](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/ruflo-components/config.mjs#L3).
- Codex context and statusline `off` are restore/release operations. The revised controls expose a separate action; they no longer offer `off` as a persisted enum. The prototype explains that operation without executing a native restore. [Context contract](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/config.mjs#L25), [statusline contract](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/config.mjs#L60).
- Preferred shell is a map keyed by environment, not one global shell. Its current structured editor preserves those keys; a production editor should provide named environment rows. [Preference schema](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/maintenance/management/preferences.mjs#L15).

## How the wizard uses this organization

The wizard is a guided route through the same model: **Assess → Choose hosts → Choose tools → Management policy → Review → Apply & verify**. It should ask only decisions needed to reach a usable setup. Category links let the user tune details without losing the assessment or selected resources.

Recommend management for the chosen setup, preserve existing package ownership and private data, and show precise consequences for exclusions. Do not interpret that recommendation as consent to install all supported hosts. Returning users can open Settings directly; a changed assessment can offer a resumable review of newly found resources.

## Implementation implications and remaining design work

A versioned settings registry should define canonical ID, category/subsection, related components, native kind/scope, record schema, defaults, ownership, validators, activation, evidence requirements and UI/CLI projections. Both interfaces must invoke the same plan/apply service. Discoverability aliases should point to canonical records while retaining operation-local semantics.

The prototype is a design exploration with synthetic values. It demonstrates grouping, source lookup, shared record editors, scoped drafts and simulated receipts. Full native schema validation, dependency previews, true per-user/per-project precedence, redacted diffs, multi-user authority and restart-safe operations remain implementation work. Human tree-testing with Builder, Operator, Architect and Finance participants should test the five tasks above before freezing category labels.
