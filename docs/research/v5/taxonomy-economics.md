# v5 research memo — taxonomy, labels, economics and team/fleet visibility

**Earlier design input:** the latest [shared management design](shared-management-design.md) and [settings organization](settings-organization.md) supersede navigation suggestions in this memo. Source findings remain part of the research record.

Research date: 2026-09-25. Read-only comparison of current HEAD `847486c61689f8499ada08f5b5684ecf26b22db8` with branch `docs/dashboard-taxonomy-delivery-metrics`, resolved to `7b9093ef3e6d4c0efb9453ee5e48532a2064e612`. No repository files were edited. Recommendations below are design proposals, not implemented behavior or meeting evidence.

## Most consequential findings

1. **The taxonomy branch is useful design input, not current implementation.** ADR-0056 and ADR-0057 both say **Proposed — nothing here is implemented**, dated 2026-09-21; ADR-0056 was also updated that day. The branch changes docs and `explainer.html`, with no production source changes. Current dashboard source still contains the five primary areas About, Overview, Usage, Observability and System, and the eight Usage views beginning with Score. [ADR-0056 status][B56-status] [ADR-0057 status][B57-status] [Current navigation][R-nav]
2. **Keep the branch's semantic discipline while freely redesigning the experience.** Its strongest proposals are one metric catalogue, one canonical definition per metric, an evidence grade, a scope, and role lenses over common data. Its preservation of ten Usage tabs and keeping Assurance/Models under Usage are staging choices rather than constraints for v5. [Taxonomy decision][B57-taxonomy] [Role lenses/catalogue][B57-lenses]
3. **Labeling is a new bounded context.** Current project grouping uses repository evidence and accumulates each session into one group/member. `reportedLabels` retain source names; they are not editable user labels. Stable label identity, assignment history, multi-label set filtering and accounting allocation are additional capabilities. [Current usage groups][R-groups] [Current project identity][R-identity]
4. **The existing financial foundation is more careful than a generic “spend” dashboard.** It separates source-reported and estimated dollars, preserves coverage, avoids fabricated local-model costs, and states that neither transcript estimates nor OpenCode reported costs are reconciled invoices. v5 should expose those distinctions prominently rather than lose them in one big dollar tile. [Cost implementation][R-cost] [Current estimator boundary][R-cost-doc]
5. **Fleet export is implemented; a managed fleet/team service is not.** ADR-0054 is Implemented (2026-09-20). Current export/aggregation has installation identity, whole-snapshot replacement and deterministic aggregation. Enrollment, expected-machine roster, network delivery, scheduling, remote control, person identity and billing reconciliation are explicitly outside its scope. [ADR-0054][R54] [Current reducer][R-reducer]

## What exists, what the branch proposes, and what v5 should add

| Facet | Evidence at current HEAD | Taxonomy branch | Recommended v5 direction |
| --- | --- | --- | --- |
| Navigation | Five primary areas; eight Usage views. [R-nav] | Six areas with Delivery; split Score into Summary, Spend, Practice. [B57-taxonomy] | A configurable workbench with role landing pages, persistent scope/filter context, search and action launcher; stable domains underneath. |
| Readers | No role lens in the inspected navigation. [R-nav] | Manager, Developer, Finance, Security/compliance, Platform operator, System architect; choice is a browser preference, not authorization. [B57-lenses] | Persona-driven starts with customizable saved views, separately enforced permissions for writes/team data. |
| Metrics | Local usage aggregation and a separate telemetry metric catalogue already exist. [R-aggregate] [R-schema] | A dashboard catalogue describing units, evidence, window semantics and aggregation rules; no arithmetic moved. [B57-lenses] | One shared semantic catalogue consumed by CLI, UI, exports and query API, with versioned calculations and coverage. |
| Projects | Git common-directory identity; linked worktrees share a repository, independent clones do not. [R50] [R-identity] | Reuse that identity for Delivery. [B56-scope] | Preserve installation/project/worktree identities; add optional organization project mapping rather than merging on names/remotes. |
| Labels | Single evidence-based groups and source display labels. [R-groups] | Not a many-to-many label implementation. | Labels on projects and sessions; explicit inheritance, intersection/union filters, saved collections and versioned assignments. |
| Money | Source-reported vs API-equivalent estimates, message-level coverage, account analytics separate. [R-cost] [R-openrouter] | Cost per merged PR and observational effort/output comparisons. [B56-economics] | Separate API-equivalent, reported usage charge, invoice spend and allocated subscription cost; choose a basis before comparisons. |
| Delivery | No Delivery navigation; branch itself marks all proposals unimplemented. [R-nav] [B56-status] | Local git plus opt-in GitHub reads; counts, PR/CI statistics, approximate attribution. [B56-scope] [B56-github] | Ship a small credible set first; instrument task/result evidence before claiming productivity or AI lift. |
| Fleet | Offline installation snapshots; no roster or transport. [R54] | Proposed v2 adds daily Delivery counters and optional shared-key matching. [B56-fleet] | Enrollment/roster, freshness, organization project mapping, authenticated ingestion, permission checks and desired/observed state. |

## A persona-driven experience without duplicate truths

The branch identifies six roles and their questions; it deliberately gives metrics one home while lenses link into it. A role lens has a landing view, brief, and report preset and does not grant permission. [B57-lenses] That is a sound data architecture even if v5 abandons every current tab and visual treatment.

**Proposal:** separate three independent controls in the product: **workspace scope** (personal/team/fleet/project), **view** (what this reader cares about), and **permission** (what this identity may inspect or change). Do not call all three “role.” A person can be a developer and operator; a finance view can be available to someone without write authority; a manager's view must not silently make private transcript text visible.

| Persona / job | Recommended first screen | Decisions and actions | Useful detail |
| --- | --- | --- | --- |
| Individual builder | “My work today”: active sessions, blockers, budget headroom, recent projects | Continue work, tune a host, resolve setup issue, label sessions, choose update window | Session timeline, context evidence, tool failures, source freshness |
| Team lead | “Delivery and friction”: project trends, blocked work, review/CI delays, coverage | Investigate bottleneck, compare the same project over time, allocate ownership, curate team view | Output + quality + usage on synchronized charts; no individual ranking |
| Platform operator | “Fleet readiness”: reporting vs expected machines, drift, compatibility, pending operations | Preview update plan, schedule cohort, inspect failure, retry or roll back supported change | Host/component versions, scope, ownership, audit receipts, last observed state |
| Finance / budget owner | “Costs and coverage”: chosen cost basis, plan charges, allocation, unassigned cost | Set budget, change allocation rule, inspect rate/evidence, export report | Currency, billing period, rate version, priced/observed/invoice coverage |
| Security / assurance | “Control and evidence”: policy posture, writes, egress, exceptions | Review operations, tune allowed actions, inspect provenance/export boundary | Identity, scope, native control semantics, receipt and result evidence |
| Architect / maintainer | “Compatibility and outcomes”: hosts, providers, models, tools, capability gaps | Compare adapters, tune reusable profiles, select canary scope | Versioned capability matrix, known incompatibilities, dependency links |

**Proposed information architecture:** Home; Work (projects, sessions, saved collections); Operations (fleet, updates, schedules, actions); Economics (usage, charges, allocation, budgets); Delivery (outcomes and friction); Assurance (policy, evidence, egress); Settings (components, hosts, profiles, preferences). These are optional visible destinations from one semantic system. The workbench can pin a few panels and hide irrelevant destinations while search and deep links remain stable. One page should always show the scope, selected labels, time interval, cost basis and freshness.

**Prototype moments worth showing:** switch from Builder to Operator and preserve the project/time context; click a cost tile to reveal its equation and included sessions; select overlapping labels and show the overlap explanation; open a session drawer and edit labels without losing the table; preview a setting change and see both the readable diff and CLI equivalent; open fleet topology as a navigable table-first view rather than a decorative graph.

**Branch reconciliation:** adopting broader v5 navigation means revising ADR-0057's proposed placement and staging, not claiming its exact ten-tab design is binding. ADR-0056 still has a stale “Scorecard gains outcome measures” consequence at lines 279–280 despite its updated decision moving Delivery to its own area. That is internal wording drift within a proposal; current code does not contradict an Implemented claim. [B56-tail]

## Labels and collections: the arithmetic must be designed with the UX

**Proposed entities:** `Label(id, namespace, name, color, visibility)`; `Project(id, installationId, nativeIdentity, orgProjectId?)`; `Session(id, installationId, hostId, nativeSessionId)`; `LabelAssignment(subjectType, subjectId, labelId, source, validFrom, validTo)`; `SavedCollection(filter, owner, visibility)`; and a separate `AllocationRule(costPool, dimension, weights, validPeriod, version)`.

Use `team:platform`, `client:acme`, `initiative:v5`, `stage:research` as friendly namespaced labels. Labels can attach to either subject; inherited project labels appear with a visible inherited badge in the session drawer. Explicit session exclusions or overrides should be an understandable policy, not an invisible precedence rule. Label names can change without changing identity. Deleting a label should archive its definition so saved reports stay reproducible.

Current project identity derives a local repository ID from the canonical Git common-directory path, with verified worktree backlinks; it is intentionally not a globally portable project identity. [R-identity] **Proposal:** organization project mapping is explicit and revocable. Keep native evidence IDs and organization IDs in separate fields. Two repositories with the same name or remote do not automatically become one; two installations can intentionally map to one organization project.

**Proposed query semantics:** resolve the population of distinct sessions first, then compute every tile and chart from that same population. `Any label` is union, `All labels` is intersection, `Exclude` is set difference. A session that has both selected labels is included once in the total. A multi-label breakdown can show full attribution under each label, but must display “overlapping groups” and a distinct-union total. A finance allocation view instead uses weights that sum to 1 within the selected allocation dimension, with an Unallocated bucket for missing assignment. Never sum a many-to-many join directly.

**Synthetic example for the mockup:** session A costs $10 and is labeled Platform + v5; session B costs $20 and is labeled Platform. Platform shows $30; v5 shows $10; Any(Platform,v5) shows $30, not $40; All(Platform,v5) shows $10. In a separately selected 50/50 allocation rule for A, Platform receives $5 and v5 receives $5; B contributes $20 to Platform, so allocated totals reconcile to $30. The labels do not change the recorded cost.

**Two time modes:** “Using current labels” lets an interactive reorganization update historical views. “As labeled at the time” preserves period reporting. The UI should name which mode is active. Source facts, label state and allocation policy version should be included in a report's provenance.

The FinOps Foundation describes allocation using accounts, tags, labels and derived metadata; it distinguishes allocation, tagging and shared-cost strategies, and permits fixed, proportional or proxy-based shared allocation. This supports separating discovery labels from financial allocation policy. [FinOps allocation][E-allocation]

**Acceptance invariants for implementation:** duplicate assignments do not inflate totals; label rename does not orphan assignments; project inheritance plus explicit session labels deduplicates; union/intersection math holds; adding labels changes membership but not source token/cost facts; allocated cost plus unallocated cost equals its pool; switching UI/CLI produces the same selected IDs and metrics; reported zero stays distinct from absent cost; labels cannot expand data access.

## Cost bases: four parallel questions

Current `rowCostEvidence()` prices only missing-cost portions of rows, retains source-reported zero, and records local-provider missing-cost portions as unpriced. [R-cost] OpenRouter account analytics explicitly cannot be joined to local sessions because its source has no session, host, project or task correlation. [R-openrouter] Subscription charges and invoices remain outside today's estimator. [R-cost-doc]

| Proposed UI name | Question answered | Required evidence | Rollup treatment |
| --- | --- | --- | --- |
| **API-equivalent estimate** | What would recorded model usage cost at these stated rates? | Token type, model/provider evidence, dated rate, pricing rules, coverage | Estimate only; never additive with actual cost for the same activity |
| **Reported API charges** | What usage charge did a host/provider report? | Source usage-cost record, source identity, currency, covered request/period | Can still differ from invoice; distinguish correlated vs account-only totals |
| **Invoice spend** | What was actually charged for this billing period? | Invoice/billing export with billing account and currency | Reconcile credits, fees, taxes and overlap; no session attribution without evidence |
| **Allocated plan cost** | What share of prepaid/subscription expense do we assign to this team/project? | Plan charge + allocation method/version/period | Explicit managerial allocation; not marginal per-token billing |

FOCUS 1.3 separately defines billed cost as an invoice-basis charge, effective cost as amortized cost with applicable prepaid portions, and list cost as list price times pricing quantity. It cautions against counting both covering purchases and covered usage when aggregating. These are useful distinctions for a future financial export, but a transcript API-equivalent estimate is not automatically a conformant FOCUS billing record. [Billed cost][E-billed] [Effective cost][E-effective] [List cost][E-list]

**Recommendation:** display the selected basis directly in every headline. Pair amount with coverage and evidence, e.g. “$84.20 reported API charges · 71% of selected requests have reported cost.” Show subscription allocations in their own series. Never calculate a “saved $X” badge by subtracting plan price from API-equivalent usage without a carefully defined counterfactual. Keep raw currency amounts; explicit exchange-rate/date provenance is required before a cross-currency sum. Use decimal/minor-unit arithmetic internally for invoices; rounding is a display decision.

**No false precision:** parent/subagent replays, retries and duplicate provider imports need lineage-aware identities before blending sources. Today's Codex ledger overlay deliberately strips cumulative usage from ledger-only identified subagents to avoid replaying parent cost; v5 must retain that treatment during any new data model. [R-replay] If an invoice covers traffic outside the locally observed sessions, display unmatched account spend rather than spreading it invisibly across projects.

## Fleet and team visibility

Today a random UUID identifies an installation, not a person or physical machine; HMAC references are pseudonymous, not anonymous. Export omits project names and model/provider free text. Newest whole snapshot replaces the prior snapshot, repeated windows are not additive, and an absent machine cannot be called healthy without a roster. [R54] [R-telemetry] The reducer implements replacement, future-time rejection, conflict detection, ratio-of-sums and histogram bucket addition. [R-reducer]

**Proposed minimum coherent fleet product:** an explicit organization/workspace; roster of enrolled installations; owner/person mapping governed by membership; per-installation credential rotation and revocation; expected reporting interval; current desired configuration and last observed configuration; compatibility health; offline/stale/retired states; target selectors for platform/team/host/component/version/labels; authenticated ingestion with deduplication; per-action receipts and results. “Unknown” must be visible when a device is offline, rather than replaced by success based on an old snapshot.

Start with **visibility and local execution**: a fleet view can explain drift and generate a signed/approved plan for an installation to apply. Remote execution is a distinct capability that needs its own authority and delivery protocol. A dashboard role preference cannot authorize remote writes. Existing ADR-0054 explicitly assigns sender authentication and organization access control to the receiver, so a managed receiver must implement those requirements. [R54]

**Aggregation rules to keep:** latest-per-installation snapshots for as-of views; an event ledger for longitudinal increments; ratio of total numerator to total denominator; merge histograms before percentiles; no sum of per-person/per-installation unioned engaged hours; separate observed/estimated dollars and unknowns; explicit clock/window/freshness context. Current usage windows admit whole retained sessions by end time and may include tokens before the cutoff; label filters should not imply otherwise. [R-aggregate] [R-telemetry]

ADR-0056 proposes fleet matching by keyed repo/author/day and taking the maximum counter across clones; it calls this a lower bound. [B56-fleet] **Recommendation:** keep that limitation visible, or replace it for exact metrics with consented bounded event references (keyed commit/PR/run identity and source authority) plus set union. A maximum is not a distinct-union count when different clones each contain different subsets. Root-commit repository identity is also listed as an open question in the proposal; prefer explicit organization project mapping for durable identity rather than promoting that heuristic to certainty. [B56-tail]

**Team privacy proposal:** aggregate view by default; project names and labels shared only by declared visibility policy; transcript text remains separate from operational metrics; require explicit per-project export scopes; show exactly what leaves a machine; keep identity mappings out of broad telemetry exports. Do not add individual “AI productivity scores” to the team table.

## Observability and delivery: evidence should lead to action

OpenTelemetry GenAI conventions have moved into `open-telemetry/semantic-conventions-genai`; the current client-span document is marked Development. It distinguishes operation/provider/request-model/response-model and optional conversation identity. Input tokens include cache subsets, output tokens include reasoning subsets, and instructions/messages/outputs should not be captured by default. Pin a supported schema version and map its semantics explicitly. [OTel move][E-otel-move] [OTel client spans][E-otel-spans]

**Adapter implication:** kit's current normalized fresh-input/cache component model must map to OTel total-input semantics intentionally. Adding already-total OTel input to cache tokens would inflate usage. Include source adapter, schema/version, provenance, missingness and observation time in normalized facts; attach trace/span/request identity where the native source provides it. Keep high-cardinality session/project IDs in trace/event correlation rather than unbounded metric labels. This is a proposed implementation strategy, not a claim that every requested host already emits those fields.

**Proposed session investigation flow:** concern tile → project/session → ordered timeline of host start, model calls, tool operations, retries, compaction/limit observations, policy decisions, file/config operations and outcome receipts → native/source evidence and remediation. Distinguish observed failure, missing observation and interrupted work. A live-looking animation must not imply live evidence when the adapter supplies only history.

DORA's current guide names five software delivery metrics: change lead time, deployment frequency, failed deployment recovery time, change fail rate and deployment rework rate. It recommends application/service context, cautions against blended comparisons across disparate teams and against turning metrics into targets. [DORA metrics][E-dora] SPACE says developer productivity cannot be represented by one activity measure or one dimension. [SPACE paper][E-space]

**Recommendation for ADR-0056 refinement:** present commits, lines and PR counts as output/activity context; pair delivery speed with operational quality and user/developer feedback. Treat the proposed `fix:`-within-48-hours metric as a heuristic signal, not a defect rate. Treat session/commit overlap as association, not causal AI contribution. Treat Accepted ADRs and closed issues as workflow transitions, not automatically shipped implementation. Reserve DORA naming for actual deployment and incident evidence. Do not promise “AI ROI” from token/commit joins alone. [Branch metric definitions][B56-scope]

## Suggested release slices for this part of v5

1. **Semantic foundation + workbench:** canonical metric descriptors, query/filter context, evidence drawer, role starts and aliases for old links. Reuse current arithmetic and compare fixture outputs before/after.
2. **Labels + local economics:** stable entities/assignments, bulk edit/undo, UI/CLI parity, distinct-set queries, current/as-of labels, separated cost bases and transparent unassigned/unknown values.
3. **Team/fleet visibility:** enrollment, authenticated receiver, expected roster, freshness, explicit organization project mapping, import/export version negotiation. Keep initial operations local or pull-based with bounded authority.
4. **Delivery joins + financial integration:** opt-in git/GitHub collection with source coverage; real billing import/reconciliation; explicit subscription allocation; proof-linked unit economics.
5. **Advanced automation:** fleet cohorts, budgets/alerts, scheduled reports and approved operation workflows. These consume the earlier identities, selectors and receipts rather than inventing parallel logic.

All five are proposals. A v5 acceptance gate should prove that the same scope, labels, period and cost basis produce the same results in UI, CLI and exported report; replays and overlapping labels do not inflate any total; and a reader can trace a number or action to its exact source and formula.

## Source register

Repository permalinks below bind evidence to the inspected revisions. Web sources were read 2026-09-25; upstream main-branch documentation can subsequently change. The RuvNet source search returned thin, largely unrelated AgentDB token/auth and operational-doc results, so no ecosystem implementation claim is based on those hits. Project memory returned no directly matching taxonomy/delivery decision in its top four results; the branch ADRs are the decision evidence.

[R-nav]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard/page.mjs#L137-L193
[R-groups]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/usage-project-groups.mjs#L22-L51
[R-identity]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/footprint/project-identity.mjs#L22-L68
[R50]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0050-dashboard-project-identity-and-context-reporting.md#L3-L50
[R-cost]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/usage-cost.mjs#L3-L37
[R-cost-doc]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/USAGE-SCORECARD-METRICS.md#L501-L552
[R-openrouter]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/usage-openrouter.mjs#L1-L23
[R-aggregate]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/usage-aggregate.mjs#L1207-L1278
[R-replay]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/usage-aggregate.mjs#L1285-L1316
[R54]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0054-fleet-evidence-export.md#L3-L85
[R-reducer]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/telemetry/aggregate.mjs#L16-L87
[R-schema]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/telemetry/schema.mjs#L5-L72
[R-telemetry]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/TELEMETRY.md#L75-L169
[B56-status]: https://github.com/pacphi/agentic-kit/blob/7b9093ef3e6d4c0efb9453ee5e48532a2064e612/docs/adr/0056-delivery-outcome-metrics.md#L1-L17
[B56-scope]: https://github.com/pacphi/agentic-kit/blob/7b9093ef3e6d4c0efb9453ee5e48532a2064e612/docs/adr/0056-delivery-outcome-metrics.md#L53-L101
[B56-github]: https://github.com/pacphi/agentic-kit/blob/7b9093ef3e6d4c0efb9453ee5e48532a2064e612/docs/adr/0056-delivery-outcome-metrics.md#L133-L162
[B56-economics]: https://github.com/pacphi/agentic-kit/blob/7b9093ef3e6d4c0efb9453ee5e48532a2064e612/docs/adr/0056-delivery-outcome-metrics.md#L164-L198
[B56-fleet]: https://github.com/pacphi/agentic-kit/blob/7b9093ef3e6d4c0efb9453ee5e48532a2064e612/docs/adr/0056-delivery-outcome-metrics.md#L200-L255
[B56-tail]: https://github.com/pacphi/agentic-kit/blob/7b9093ef3e6d4c0efb9453ee5e48532a2064e612/docs/adr/0056-delivery-outcome-metrics.md#L277-L328
[B57-status]: https://github.com/pacphi/agentic-kit/blob/7b9093ef3e6d4c0efb9453ee5e48532a2064e612/docs/adr/0057-dashboard-taxonomy-role-lenses-and-metric-catalogue.md#L1-L15
[B57-taxonomy]: https://github.com/pacphi/agentic-kit/blob/7b9093ef3e6d4c0efb9453ee5e48532a2064e612/docs/adr/0057-dashboard-taxonomy-role-lenses-and-metric-catalogue.md#L72-L135
[B57-lenses]: https://github.com/pacphi/agentic-kit/blob/7b9093ef3e6d4c0efb9453ee5e48532a2064e612/docs/adr/0057-dashboard-taxonomy-role-lenses-and-metric-catalogue.md#L137-L186
[E-allocation]: https://framework.finops.org/framework/capabilities/allocation/
[E-billed]: https://focus.finops.org/docs/specification/v1-3/columns/billed-cost/
[E-effective]: https://focus.finops.org/docs/specification/v1-3/columns/effective-cost/
[E-list]: https://focus.finops.org/docs/specification/v1-3/columns/list-cost/
[E-otel-move]: https://opentelemetry.io/docs/specs/semconv/gen-ai/
[E-otel-spans]: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
[E-dora]: https://dora.dev/guides/dora-metrics/
[E-space]: https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/
