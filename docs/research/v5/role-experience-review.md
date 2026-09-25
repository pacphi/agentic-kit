# Role-specific experiences: reference review and v5 revision

**Historical concept:** the later [shared management design](shared-management-design.md) supersedes the role-specific navigation and separate 42-view composition approach. The reference observations and persona decisions remain useful inputs.

September 25, 2026. This addendum responds to the gap in the first v5 concept: its role selector changed Today’s wording and suggested action, while the other six views remained the same. The revision develops role-specific content throughout the workbench. It is a proposed experience using synthetic data, not an implementation or certification.

## What each earlier artifact contributes

| Reference | Observed design contribution | How it should inform v5 |
|---|---|---|
| [Delivery Scorecard](https://claude.ai/artifact/V9Pk6Mj7VEe5SELXCUoLat) | Delivery measures share a time window and prior-window comparison. Local-only mode labels approximate PR counts and withholds GitHub-only evidence. A repository expands into module-level line composition, while the UI explains which measures remain repository-level. | Make temporal comparison, source coverage, unavailable states and drilldown grain part of every analytical view. Carry evidence qualifications into derived unit costs. |
| [Scorecard Additions](https://claude.ai/artifact/7kcwvZZmuzuNfwxNfQM8FT) | A detailed metric vocabulary: value/delta/sparkline tiles; cadence and unit costs; session-length and latency distributions; execution mode; delegation; observed provider; tool/model mix; reliability; session chips; quota pacing; evidence-based findings. It is a design supplement with illustrative figures and evidence annotations. | Build a reusable panel library, with canonical definitions, provenance and role relevance. Different roles compose different panels and prioritize different follow-up actions. Recheck historical parser-coverage claims against the certified adapter version. |
| [Dashboard Lenses](https://claude.ai/artifact/M4UFzPKoTo9NdbR3MQou5g) | A role selector over stable domains, with role briefs and report presets. Manager lands on Delivery, Developer on Practice, Finance on Spend, Security on Hooks, Operator on Overview, and Architect on System Projects. The first three have substantive analytical content; several other pages remain explicit placeholders. | Turn the role into a persistent view-composition preference: questions, metrics, visualization, grain, columns, ordering, actions and export preset. Keep all domains reachable. |

The earlier artifacts provide useful semantic depth. Their constraints about adding no navigation items or fitting content into existing tabs were incremental-design choices; the current request authorizes a broader redesign. Reuse the metric definitions and evidence behaviors while rebuilding the presentation.

The branch’s [ADR-0057](https://github.com/pacphi/agentic-kit/blob/7b9093ef3e6d4c0efb9453ee5e48532a2064e612/docs/adr/0057-dashboard-taxonomy-role-lenses-and-metric-catalogue.md#L137) is **Proposed, dated September 21**, and limits a lens to a landing view, brief and report preset. The v5 proposal extends that to the content within each view. Its canonical metrics and separation of role from authorization remain essential. If adopted, revise the proposed lens-switch navigation behavior: a role change should preserve the current view and selected object, with a role landing page used only on initial entry.

### What I clicked

In Delivery Scorecard I inspected Connected, switched to Local only, changed the window from 14 to 7 days, and expanded ledger-core into its module composition. In Dashboard Lenses I selected Manager, Developer, Finance, Security & compliance, Platform operator and System architect; navigated from Developer into Sessions; and opened Map. Scorecard Additions is an annotated design supplement rather than a role-switching product simulation; I read its panels and evidence annotations.

The Dashboard Lenses clickthrough exposes a precise boundary: Manager’s Delivery, Developer’s Practice, and Finance’s Spend contain substantial distinct content. Developer → Sessions explicitly says “Unchanged by this proposal”; Hooks, Overview and System also contain placeholder summaries under their role briefs. The proposed v5 revision completes those role-specific working views instead of treating their placeholders as a finished interaction model. [Dashboard Lenses](https://claude.ai/artifact/M4UFzPKoTo9NdbR3MQou5g)

## What must visibly change when the role changes

The user should see a different answer to a different question, using the same authorized evidence. Seven aspects change: **primary question, row grain, primary metrics, dominant visual, table columns/default order, relevant actions, and export shape**. The selected workspace, period, labels and inspected project/session remain stable. Any additional focus subset is named explicitly.

| Role | Primary concerns | Distinctive visual language |
|---|---|---|
| Builder | What needs me? What slowed this session? Can I continue? | Work queue, event timeline, context/limit headroom, checks and checkpoint detail |
| Team lead | Where is work waiting? What completed? What evidence links cost to outcomes? | Flow board, wait-age distribution, project trends, review/CI friction |
| Finance | What is known, estimated, billed, allocated or unmatched? | Cost ledger, contribution bars, coverage, reconciliation and allocation views |
| Operator | Which installations are stale, drifting, busy, held or failing? | Readiness matrix, incident timeline, rollout stages, per-resource receipts |
| Assurance | What ran under which policy? Which claims are unverified? What leaves the machine? | Decision/evidence timeline, control matrix, scope diff, grant and export boundaries |
| Architect | Which host/provider/component combinations fit this workload? | Capability/dependency matrix, route comparison, workload tradeoff views |

These are presentation preferences. A role does not grant permission, identify the user’s job title, silently select another team, or authorize a paid operation. Actions require the same authority regardless of how the reader arrived at them.

## Content selection starts with a decision

The earlier mocks are partial evidence of intent. Their existing metric choices are not a final editorial plan. Each persona needs a deliberate default experience, including what to omit. The following is the proposed product direction, grounded in current capabilities and the meetings; items requiring new sources remain explicit future integration work.

| Persona | Decision the first screen should help make | Primary content and action | Content to de-emphasize |
|---|---|---|---|
| Builder | What should I do next to move my work forward? | Current work and review needs; actual failure/limit/context evidence; last usable checkpoint; relevant setup issue. Resume, inspect, hand off, or preview a narrow repair. | Fleet totals, speculative ROI, organization-wide cost rankings, decorative activity |
| Team lead | What is blocked, waiting for review, or becoming less reliable? | Work-item/PR/check evidence, waiting age, ownership and accepted outcomes with coverage. Open the blocked work, coordinate a review, or investigate a project trend. | Individual productivity scores; token volume as success; assisted-share correlation as causal value |
| Finance / client owner | Which amount can I trust and attribute, and what remains unresolved? | Chosen cost basis, period/currency, coverage, unallocated or unmatched amounts, client allocation and budget assumptions. Inspect source, resolve attribution, export or close an evidenced period. | A mixed “spend” number; raw tool-call traces as the default; API-equivalent minus plan fee presented as savings |
| Operator | Which environment needs intervention, and what can I change safely? | Expected versus observed reporting, exact drift, installation owner, busy/held/restart states and per-action receipts. Plan one repair, schedule a bounded set, or recover an interrupted operation. | Global “all healthy” badges without coverage; warning counts that cannot be acted upon |
| Assurance | Which action or control lacks trustworthy evidence? | Configured versus enforced controls, policy decisions, actor/target/receipt lineage, export scope and exception age. Inspect the exact evidence or review a scoped exception. | Compliance grades inferred from configuration; unknown mapped to failure or success; transcript access granted by choosing this view |
| Architect | Which combination of hosts, models and components fits this workload and its constraints? | Capability/version matrix, requested versus executed route, dependencies, native scope differences and comparable workload results. Inspect compatibility, propose a profile, or define a comparison experiment. | Uncontrolled speed/cost comparisons across unrelated tasks; language pie charts as the central decision |

For a consultant, a **Client delivery** saved preset can combine the Lead and Finance compositions around the same client label. It needs delivery evidence and allocation, with no separate arithmetic or special interpretation of cost. This addresses the meeting’s billing use case without pretending that all managers are finance users. [Community meeting](https://notes.granola.ai/d/6416b991-34b4-428c-85bb-951c5e0442d4)

### Navigation should express the job

Proposed role-facing starting points are Builder: **My work / Sessions / Setup / Insights**; Lead: **Projects / Delivery / Blockers / Costs**; Finance: **Spend / Allocation / Budgets / Reports**; Operator: **Fleet / Changes / Schedules / Diagnostics**; Assurance: **Policies / Activity / Evidence / Sharing**; Architect: **Stack / Routes / Capabilities / Experiments**. These are task-oriented entry points into canonical views and saved filters. They need not all become new top-level pages.

Keep an **All areas** route and stable breadcrumbs. When a role changes, preserve the current inspected item and explain the new perspective; do not teleport to a default dashboard or silently widen scope. A compact global search can find a project, session, setting or permitted action. Every screen should make the current scope and best next action apparent. Users can pin useful panels and save their own view; a preset is a starting point rather than a permanent identity.

### Match ambition to available evidence

Current local usage, project grouping, configuration, host readiness, maintenance receipts and selected observation sources can support meaningful Builder, Operator, and parts of Finance/Assurance/Architect experiences. Enrolled-fleet completeness, work-item waiting time, accepted outcomes, invoice reconciliation and organization authorization need additional services or data. [Implementation audit](implementation-audit.md)

Show the useful local evidence immediately, then an appropriately scoped setup invitation where a decision needs more data. A Lead page with no delivery integration should offer project activity and an explicit “Connect delivery evidence” path; it should not invent a review queue. A Finance page with estimates only should say so and retain usable estimates. An Assurance page must preserve ADR-0058’s distinction between a written governance setting and demonstrated runtime enforcement. [ADR-0058](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0058-managed-ruflo-components.md)

The prototype demonstrates possible future compositions with clearly synthetic records. It is a design instrument for choosing the best content, not proof that all proposed sources are integrated today.

## View-by-view composition

| View | Builder | Team lead | Finance |
|---|---|---|---|
| Today | Active work, blockers, headroom and next checkpoint | Work awaiting review, oldest waits, accepted outcomes and gaps | Cost exceptions, coverage, unallocated amounts and budget pace |
| Work | Project/task queue with branch, checks and next action | Stage board with owner, age, blockers and outcome evidence | Project/client contribution, cost basis, allocation and budget variance |
| Sessions | Ordered tool/model/checkpoint timeline with context and failure evidence | Sessions linked to work items, interventions and waiting | Session cost ledger with provider/account, basis, allocation and evidence |
| Stack | Effective settings and relevant limits; preview a scoped change | Team profile adoption, project exceptions and impact | Billing bindings, metered fallback exposure, rate and account evidence |
| Updates | Relevant changes, idle state, interruption/restart impact | Cohorts, affected projects, owner readiness and change windows | Billing/license implications and explicitly unknown financial effects |
| Fleet | Available working environments and relevant local/shared issues | Team/project reporting coverage and blocked work | Environment-to-cost-center mapping, ownership and source completeness |
| Value | Cost/latency/cache alongside the selected work and its result | Cost per evidenced outcome, flow/quality context and join coverage | Distinct cost bases, reconciliation, allocation and period reporting |

| View | Operator | Assurance | Architect |
|---|---|---|---|
| Today | Failed/held operations, stale devices and drift | Open exceptions, unverified actions and export changes | Capability gaps, incompatible combinations and lifecycle notices |
| Work | Project/environment readiness and resource pressure | Project control boundaries, owners and sharing/exception evidence | Project/module stack and dependency relationships |
| Sessions | Operational timeline of failures, restarts and missing observations | Action, policy decision, target and receipt lineage | Requested/executed route, model/provider, escalation and result evidence |
| Stack | Desired versus observed versions/config, owner and reload needs | Setting provenance, locks, permissions, secrets references and egress | Versioned adapter capabilities, supported scopes and dependencies |
| Updates | Dependency-aware plan, canary stages, held reasons and recovery | Approval/scope/migration changes and available verification | Compatibility-set diff and required adapter verification |
| Fleet | Expected roster, freshness, version spread and next operation | Enrollment, identity, grants, revocation and export boundaries | Topology, architecture and capability distribution |
| Value | Resource/operation economics where correlations exist | Attribution, payer, source and policy evidence gaps | Matched-workload cost, quality, latency and capability comparison |

Each cell is a proposed composition, not a promise that its data already exists. Missing evidence yields an actionable empty state, rather than a fabricated metric. Examples: Finance sees “No source-reported cost for these sessions”; a lead sees “No outcomes linked yet”; an operator sees “Never reported”; an architect sees “No comparable workload baseline.”

## A concrete comparison: the same session

Select one checkout-repair session and switch roles without changing that selection:

1. **Builder:** tool sequence, failure/retry, context pressure, tests, checkpoint and resume/handoff.
2. **Finance:** token categories, source-reported cost versus estimate, account/model/rate evidence, inherited client labels and allocation.
3. **Team lead:** work-item stage, review delay, owner, linked PR/checks and whether an outcome is accepted.
4. **Operator:** installation/profile/version, last event, collector freshness, failures and a scoped diagnostic action.
5. **Assurance:** native permission posture, observed actions, target scope, policy/receipt evidence and export boundary.
6. **Architect:** requested versus executed route, host/provider/model, delegation structure, compatibility and comparable-workload evidence.

The underlying facts do not change. Nor should selecting Finance suddenly relabel an estimate as billed spend, or selecting Lead turn an activity count into productivity.

## Corrections to carry forward from the references

- **Keep the evidence contract.** Exact, derived, approximate, unrecorded, stale and not connected have different meanings. Preserve them through every chart and derived metric.
- **Make deltas contextual.** A token increase is not automatically bad; a cache-rate increase can be useful; a latency decrease matters only for a comparable population. State the comparison window and denominator.
- **Qualify cost per PR.** Align cost and outcome populations; display unlinked cost, estimated PR counts and zero/missing denominators. A simple quotient does not prove ROI.
- **Avoid false outcome labels.** An ADR becoming Accepted or an issue closing is a workflow transition. Call it shipped only when linked implementation/release evidence supports that claim.
- **Keep source grain visible.** Module-level line composition cannot manufacture module-level CI/release/PR measures from repository totals.
- **Treat parser coverage as versioned evidence.** The August supplement’s “parsed” or “derivable” labels are historical design inputs, not a present-day six-host certification.
- **Preserve unknown cost.** No known source values means unavailable, not zero. Missing cost does not establish a subscription billing mode.
- **Keep derived savings separate.** Cached-versus-uncached cost comparisons are counterfactual estimates under a rate card, not guaranteed invoice savings.

These recommendations follow from the displayed qualifications and metric definitions in [Delivery Scorecard](https://claude.ai/artifact/V9Pk6Mj7VEe5SELXCUoLat), [Scorecard Additions](https://claude.ai/artifact/7kcwvZZmuzuNfwxNfQM8FT), the role views and taxonomy map in [Dashboard Lenses](https://claude.ai/artifact/M4UFzPKoTo9NdbR3MQou5g), and the earlier report’s source-verified boundaries.

## Implementation contract for later product work

A role/view descriptor selects `question`, `grain`, `metricIds`, `visualization`, `columns`, `sort`, `focusPredicate`, `actionIds`, `emptyState` and `exportPreset` from shared data services. This is presentation composition, not six forks of the calculations. A separate permission layer filters data and authorizes actions.

Every metric opens the same evidence inspector: definition, formula, selected population, exclusions/unknowns, source and version, observation time, freshness, units and window semantics. The initial evidence tab may vary by role, but the underlying explanation remains available.

Persist role defaults and user customizations separately. A user can pin a latency panel in a finance-oriented workspace without becoming a different person or changing the meaning of costs. Keep “reset this view” local to the customized view. A copied deep link includes scope/view/object and optional presentation preference, never bearer credentials.

Acceptance should cover all 42 role/view combinations: meaningful composition differences; unchanged scope/object on role switch; equal shared metrics for equal populations; correct unknowns; accessible navigation; useful missing-data states; and consistent authorized action plans from UI and CLI. The revised concept demonstrates the presentation direction; production schemas, permissions, persistence and native integrations remain future work.
