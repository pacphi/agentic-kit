# Shared panels, guided adoption, and live management

September 25, 2026. This is the latest v5 design revision. It supersedes the earlier concept’s role-specific navigation and 42 separately composed views. Application implementation remains unchanged.

## The product model

Use five stable areas: **Overview, Work, Insights, Manage, and History**. Navigation answers where a capability lives. **Attention for** answers which findings deserve emphasis for the current reader. Each panel has one canonical identity, definition and source contract; several personae can use it. A cost-coverage panel is useful to Finance, Lead and Assurance; runtime health is useful to Operator, Builder and Architect. This avoids duplicating whole dashboards for each role.

Role focus changes ranking, the reason an item matters, the first relevant evidence tab and suggested next action. It never changes severity, cost arithmetic, source scope, permissions or the meaning of a field. A user can combine useful panels into a saved view without adopting a new identity. A shared inspector exposes all relevant evidence, with the appropriate section brought forward.

The new mockup uses the same finding objects for every role. Operator emphasizes owned drift and runtime readiness; Assurance emphasizes configured-versus-enforced governance; Finance emphasizes incomplete cost evidence; Lead emphasizes review waiting. Component configuration remains fully discoverable from every focus. The admin permission context is separate from the attention preference.

## Preserve current value explicitly

The [panel map](panel-map.md) inventories **101 existing functional panels/capability groups** at commit `847486c61689f8499ada08f5b5684ecf26b22db8`, including nested inspectors, runtime-inserted scorecard panels and Maintenance workspaces. Each row has one canonical destination, its existing presentation, capabilities to preserve and an immutable source citation. Individual KPI tiles and repeated subsystem cards are grouped under their functional parent rather than inflated into separate panels.

| Existing capability family | Canonical v5 destination | Value that stays |
|---|---|---|
| About directory and “Configured for you” | Manage → Components | Purpose, relationships, installed versions, ownership, managed state and native commands |
| Overview health/attention/status map | Overview | Whole-stack evidence, actionable findings, unknowns, freshness and next steps |
| Hosts, activity routing and providers | Manage → Routing & providers / Components | Host intent, activity/model routes, escalation, provider/payer distinction, credential readiness |
| Usage scorecard | Insights → Usage & cost / Practice | Cost/time trends, token/cache composition, cadence, autonomy, model/tool mix, rhythm and reliability |
| Limits and context | Insights → Capacity | Vendor quota, pacing, runtime pressure, configured context and evidence qualifications |
| Hooks and model lifecycle | Manage and Insights → Models | Configuration/receipt distinctions, permission posture, assignments versus observations, lifecycle notices |
| Sessions, transcripts, prompts and observations | Work | Project grouping, filters, masking/source reveal, prompt patterns, live/history replay and event relationships |
| Footprint, storage, runtime and project inventory | Manage → Maintenance / Machines | Size, live processes, resource ownership, consumers, project/worktree identity, bounded scans |
| Maintenance actions and receipts | Manage → Maintenance; History | Preview/apply/verify, recovery, undo where supported, exact native guidance and interruption evidence |

The interactive map exposes all 101 entries and their source links. The mockup previews selected shared panels and management flows; it does not reproduce every current chart or native interaction. The full map is the migration acceptance contract: an implementation should not retire a source panel until its capabilities and evidence qualifiers work in its mapped destination. [Current dashboard template](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard/page.mjs)

## A wizard is the right entry into management

Use a resumable wizard for a first installation, adoption of existing tools, adding a machine, or a deliberate reassessment. Routine changes remain directly accessible through inspectors and settings.

| Step | User decision | Required result |
|---|---|---|
| 1. Assess | Which machine/profile/project context are we evaluating? | Read-only inventory of known locations, exact installation identity, version, binary owner, configuration roots, prior receipts, conflicts and evidence gaps |
| 2. Choose hosts | Which detected or additional hosts should be part of this setup? | Detected hosts proposed for adoption; additional hosts installed only when selected; native authentication remains explicit |
| 3. Choose tools | Which core capabilities and optional companions do I want? | Recommended core selected by default; dependencies and concrete opt-out consequences visible |
| 4. Management policy | Who owns configuration and lifecycle for each selected resource? | Configuration management, upgrade management and observation distinguished; existing package owners preserved |
| 5. Review | Are these exact installs, projections, repairs and holds acceptable? | Target list, before/after changes, installer ownership, private-data preservation, expected native restarts, opt-outs and recovery boundaries |
| 6. Apply and verify | Apply the reviewed eligible plan | Per-resource progress, verification, partial outcomes, remaining holds and a managed inventory with receipts |

**Recommended default:** manage the user’s chosen setup. This is not a reason to install all six hosts. Detected resources and a recommended core can be preselected; additional installations remain visible choices. Existing explicit exclusions must survive reassessment. An existing tool is not automatically safe to overwrite merely because it is detected.

The current `ak setup` already distinguishes machine/project setup, exposes component/host opt-ins and opt-outs, and prints a trust manifest. The wizard should make those decisions readable and inspectable while extending them into a consistent management policy. It is proposed UI behavior, not a claim that all these choices currently exist as browser writes. [Setup options and trust flow](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/setup.mjs#L68)

## What “managed” should mean

A single green Managed badge is insufficient. Show the resource’s **installation owner**, **configuration owner**, **upgrade policy**, **observed runtime state**, **last verification**, and **recovery capability**. A native package manager can continue owning the binary while ak owns supported configuration. A resource can also be monitored without a supported write adapter.

| Mode | Contract |
|---|---|
| Configuration + lifecycle managed | ak records and reconciles declared intent and plans supported upgrades through the owning installer |
| Configuration only | ak manages supported settings/projections; the native owner handles software updates |
| Lifecycle only | ak plans supported version changes; user/native configuration is preserved |
| Inventory monitoring only | Presence/version/evidence are visible; no unsupported configuration or install action is implied |
| User-owned / excluded | Intentional ownership choice; observation may remain available if separately allowed |

Management does not grant new credentials, authorize metered inference, upload telemetry, schedule background upgrades or prove a runtime healthy. Each remains a distinct contract. Ruflo’s accepted capability-brain ADR likewise distinguishes registration, configuration, reachability, health and authorization. [Ruflo ADR-329](https://github.com/ruvnet/ruflo/blob/main/v3/docs/adr/ADR-329-ruflo-capability-brain-mcp-guidance.md)

## Opt-out warnings should explain an actual consequence

Warn at the decision and retain a neutral ownership label afterward. Continue warning only when an enabled feature has a concrete unresolved prerequisite, incompatibility or evidence gap. Otherwise the product recreates the original problem: warnings that no amount of sync can clear.

| Choice | Reasoned consequence |
|---|---|
| Omit kit-provided Ruflo integration | Managed orchestration/routing/learning integration needs another owner; native host work can continue. Current kit has no general top-level `ruflo=false` switch, so this is a new contract. |
| Stop managing AQE | Kit stops converging AQE/provider/embedding setup. An independently maintained AQE may still work; preserve its memory. |
| Stop managing Brain | Kit stops provisioning/refreshing its bundle and integrations. Existing independent source lookup may continue. |
| Stop managing standalone AgentDB | CLI ownership/schema coherence and harvest support need manual care. Ruflo’s bundled memory is a separate resource. |
| Keep a host user-owned | Native use continues. Managed hooks, MCP, routing projections and repairs are no longer assured for that host. |
| Omit an optional companion | Name the optional capability lost, such as automatic recall/indexing. Do not imply that all memory or host functionality is broken. |
| Disable scheduling | No ak-scheduled maintenance runs. On-demand checks, plans and repairs remain available. Native host auto-updaters may still have their own policy. |

These distinctions are grounded in the [lifecycle audit](settings-audit.md) and its per-component source citations. They should be dependency-aware: an optional capability can be omitted without creating a permanent failure state for unrelated work.

## Expose the real knobs and their boundaries

The [settings catalogue](settings.json) contains **330 entries: 178 curated controls/evidence/proposals and 152 advanced CLI inputs**, with evidence from all 27 command option blocks. These are catalogue entries, not 330 writable persistent settings. The revised Settings workspace uses eight purpose categories, component filtering, and separate views for configuration, run options, observed state, setup choices and unavailable capabilities. Routes and repeated records share editors. See the [settings organization rationale](settings-organization.md) and [complete taxonomy mapping](settings-taxonomy.json).

The actual source-backed options include host enablement and primary host, activity routes/escalation, provider/model bindings, AQE guidance and embedding intent, MCP registration/exclusions, managed guidance, context/statusline intent, discovery and maintenance preferences, and the Ruflo component catalogue. Fields show scope, default semantics and source. A typed editor should be generated from the same validated contract consumed by CLI operations.

Several semantics must survive UI simplification: `rufloComponents.funnel=false` actively suppresses promotions, while other false values can release management; AQE’s local setup choice is transformed into endpoint/provisioning intent; observed embedding model constants are not generic model pickers; configured MCP governance is not proven enforcement on the tested stdio path. [Ruflo configuration](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/ruflo-components/config.mjs) · [Component catalogue](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/ruflo-components/catalogue.mjs)

“All options” needs a versioned boundary. This audit covers kit-declared controls and invocation options at the inspected commit. Upstream hosts expose additional native settings. Their adapters must discover/declare the supported installed-version schema, preserve unknown fields, and explain unsupported scope rather than claim universal write support. Native authentication and secrets should remain native flows or references.

## Inspect → remedy → apply → verify, with UI continuity

The issue inspector shows observed state, desired intent, exact evidence, affected resources, an eligible remedy, and expected native effects. Review freezes targets and the source state. The operation then progresses independently of the visible page, updates only affected read models, and leaves a receipt. Users can navigate while it runs.

Current Maintenance authorizes one exact action per executable plan. A fleet campaign should coordinate independently planned/verified child actions, not pretend a multi-machine change is one atomic transaction. Show **eligible, busy/deferred, offline, unaffected, held, failed, verified, and restart pending** separately. The operation may succeed for a subset while the fleet still has unresolved work. [ADR-0044](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0044-receipt-aware-maintenance-control-plane.md) · [ADR-0048](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0048-inventory-led-maintenance-resource-management.md)

UI continuity requires a durable operation service and resumable event stream or polling, independent of the selected panel. Updating a tool or restarting an MCP/host process should leave the dashboard available. Updating agentic-kit itself may require a controller restart; a supervisor/reconnect path must preserve the operation and browser context. Do not promise that the current implementation already performs a seamless self-upgrade.

Rollback is capability-specific. Restoring owned settings, reverting a package and undoing a data migration are different operations. A Brain private-overlay hold should remain a hold until a version-supported preserving update is verified. Rewriting a governance file cannot repair an upstream enforcement gap.

## Upgrade availability and optional schedules

The Components view puts current version, candidate evidence, owning installer, compatibility policy, hold reason and upgrade action together. Users can check now, preview one component, or plan the eligible managed set. A curated compatibility policy can deliberately select something other than the newest package.

Scheduled care is **OFF by default** and separate from management. Users choose exact machines/cohort, components, cadence, time zone and check/stage/apply policy. A draft enabled toggle is not a saved schedule. The plan resolves the current target membership, states what happens when busy/offline, and requires another review for expanded authority or material scope changes. Reassessment retains an existing explicit schedule instead of silently resetting it.

Native automatic updaters also need an owner decision during adoption. Turning ak scheduling off does not imply native auto-updates are off. Offer to preserve that policy or review a supported change; never let two uncoordinated updaters claim the same lifecycle.

## Architecture status and verification boundary

ADR-0044 is Implemented. ADR-0048 remains Accepted with stated human/cross-platform gates outstanding. ADR-0054 is Implemented for offline fleet evidence and explicitly excludes enrollment, scheduler and remote control. ADR-0058 is Accepted with implementation/runtime limits recorded. ADR-0057 on the taxonomy branch remains Proposed. The new shared-panel, ownership and scheduling contracts should revise those plans when implementation is authorized; this research does not change their status. [ADR-0054](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0054-fleet-evidence-export.md) · [ADR-0058](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0058-managed-ruflo-components.md)

The concept’s writes, checks, installs, schedules, machines and receipts are simulated. The real configuration names, defaults and source relationships come from the audited revision. Validation of the interactive flows is recorded in [verification.md](verification.md); no installed system is modified or runtime certification claimed.
