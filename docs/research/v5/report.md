# Agentic Kit v5

## A workbench for running your agent stack

**Latest revision:** stable navigation, shared panels, role-weighted attention, a detect-first onboarding wizard, and settings grouped by user intent. Eight purpose categories, component filters and shared record editors retain all 330 source entries while distinguishing configuration from run options and observed state. See the [settings organization rationale](settings-organization.md), [shared management design](shared-management-design.md), [101-panel migration map](panel-map.md), and [settings/lifecycle audit](settings-audit.md).

Product research, implementation comparison, and experience proposal · September 25, 2026

**Recommendation:** make v5 a local-first workbench in which people can understand, configure, maintain, and account for their agent work from either the UI or CLI. Add an optional team service for shared visibility and governed fleet operations. The defining experience is a continuous path from **a question → its evidence → a scoped action → a verified result**.

The visual experience can change completely. The valuable implementation foundations—capability adapters, ownership tracking, guarded operations, cost provenance, and snapshot deduplication—should carry forward. The new product should feel calm and capable: useful defaults, a clear next action, fast drilldowns, and consequences visible before a change.

This is an analysis and design proposal, not an implementation or accepted architecture decision. The interactive concept contains synthetic data and simulated actions. Proposed commands in this report are interface sketches, not commands available in the inspected release.

## 1. Evidence and confidence

I retrieved both full Granola transcripts and inspected their relevant discussions, with a second independent transcript pass. The meetings are **“Stuart and Chris - Jam session Zoom Meeting,” September 24 at 5:00 p.m. PDT**, and **“Agentic Kit demo and RooVector TypeSafe benchmarking with community,” September 25 at 9:02 a.m. PDT**. The latter matches the Hackerspace/Agentics Foundation meeting described in the request. Citations lead to the original meeting notes; transcript exports did not supply reliable utterance timestamps. Unrelated audio after the community meeting was excluded. [Stuart meeting][M1] · [Community meeting][M2]

The repository baseline is **4.0.0-alpha.55**, commit **847486c61689f8499ada08f5b5684ecf26b22db8**. The requested taxonomy branch resolves to **7b9093ef3e6d4c0efb9453ee5e48532a2064e612**. Repository links below pin those revisions. Current vendor documentation was checked on September 25, 2026. Published capabilities are not equivalent to a passing local adapter test. [Package baseline][R0] · [Taxonomy proposal][T57]

Evidence labels used here are deliberate: **confirmed** means inspected source or a bounded reproduction supports the claim; **reported** means a meeting or issue describes it; **documented upstream** means a vendor describes a capability; **proposed** means a product or engineering recommendation. The three research lanes covered implementation, host interoperability, and taxonomy/economics. No installed tools were updated, no application implementation was changed, and no release was produced.

## 2. What the meetings actually ask for

Stuart’s strongest request is immediate utility: **“I really want a one-click fix.”** He also proposes distinct defaults for people who welcome managed updates and people who want explicit control. The community discussion adds a structural requirement: projects may appear in multiple workspaces, sessions need labels, and costs need a client/project interpretation. These are complementary requests for control, organization, and evidence. [M1] [M2]

| ID | Meeting signal | Interpretation for v5 | Evidence status |
|---|---|---|---|
| M-01 | Individual warnings should be fixable in place | Put an eligible action beside a finding; disclose scope, impact, and result | Explicit request, Stuart [M1] |
| M-02 | Repeated sync does not clear the displayed problems | Status, diagnosis, plan, and verification must agree; distinguish preserved exceptions | Reported pain; several source defects confirmed below [M1] |
| M-03 | Extra dashboard flags are hard to remember; the terminal is occupied | Persist source setup, discover configured producers, reopen a running dashboard, return the terminal | Explicit usability request [M1] [M2] |
| M-04 | Optional automatic updates would help less technical users | Offer an understandable update policy, with per-component exceptions and a visible schedule | Explicit request, with disagreement about default risk [M1] |
| M-05 | Installed Codex/OpenCode can look unknown or disabled; routing information disappears | Separate installation, enablement, configuration, connection, and observation coverage | Reported; “unknown” is not itself proof of a defect [M1] |
| M-06 | AgentDB installation collides; Brain refresh refuses a private overlay | Detect installation ownership and use version-correct update operations; preserve user data | Reported failures; code supports integration gaps [M1] |
| M-07 | Several environments coexist on one machine | Introduce explicit installations/profiles with separate roots and an environment selector | Explicit community request [M2] |
| M-08 | Projects may belong to multiple workspaces; sessions may be labeled or inferred | Many-to-many labels, saved collections, visible inheritance, and reviewable suggestions | Explicit community request [M2] |
| M-09 | Client work needs token and cost attribution | Separate analytical grouping from financial allocation; preserve the cost basis | Explicit community request [M2] |
| M-10 | Team/machine aggregation and federation would be valuable | Enroll devices, show expected reporting coverage, then add separately authorized operations | Explicit discussion; federation offered as an exploration [M1] [M2] |
| M-11 | Session logs may omit subcalls; richer API-level observations were discussed | Show collection coverage, correlation, and retention; add supported native instrumentation | Participant experience, not a universal logging guarantee [M2] |
| M-12 | Switching Claude/Codex loses useful context unless manually checkpointed | Make handoff and shared-memory verification visible and testable | Reported workflow failure; no proof shared memory is impossible [M1] |
| M-13 | Grok usage is absent | Add Grok Build as a host and Grok as a provider/model relationship | Explicit request [M1] |
| M-14 | An opt-in problem report and product usage signals could improve support | Local diagnostic bundle, preview/redaction, explicit send; separate optional product analytics | Explicit proposals [M1] |
| M-15 | Too much unclassified work and too many possibly decorative metrics | Explain unknowns; improve classification; prioritize decisions by reader | Explicit discussion [M1] [M2] |

Hermes, Gemini CLI, comprehensive UI/CLI configuration parity, and a completely new visual design are requirements from this conversation. They should not be retroactively attributed to the meetings. Reported benchmark multipliers, model-quality opinions, and large cost anecdotes from the community call are not used as product facts or expected savings. [M2]

## 3. Current implementation: a stronger starting point than “read-only”

| Area | Verified current state | v5 gap / opportunity |
|---|---|---|
| Dashboard | Zero-flag launch already exists; defaults to port 7431, opens a browser, remains foreground; Ruflo/AQE stream registration is explicit | A complete routine experience without flags: source onboarding, instance reuse, lifecycle management [R1] |
| UI writes | Maintenance has allowlisted preview/apply/undo, discovery, receipts, recipes, preferences, and reconciliation; host-health checks also use explicit POST routes | General configuration and update workflows across all declared managed resources [R2] [R3] |
| Update lifecycle | `ak sync` orders whole-stack upgrade/heal/verify; fine-grained hooks and some maintenance providers already exist | Unified target selectors, dependency plans, scheduler, rollout policy, batch results [R4] [R5] |
| Configuration | `kit.json` holds routing, provider bindings, component intent and other settings; CLI per-activity routing already exists | Shared schema/form/command catalogue, explainable effective settings, all supported native scopes [R6] [R7] |
| Hosts | Built-in host/execution registries cover Claude, Codex, OpenCode; an experimental adapter admission mechanism exists | Hermes, Gemini CLI, Grok Build; parity certification and broader maintenance/observation coverage [R8] |
| Environments | Some roots honor environment variables; central Codex root is fixed while newer paths honor `CODEX_HOME` | One installation/profile identity and path resolver across every collector and writer [R9] |
| Session observation | Native Claude/Codex live sources, process evidence, and optional Ruflo/AQE streams; bounded replay | Broader collectors, durable optional retention, trace correlation, visible gaps [R10] |
| Grouping | Evidence-based repository/worktree grouping and source display labels | User-authored labels, saved collections, inheritance and assignment history [R11] |
| Fleet | Versioned local export, validation, aggregation and metric contracts | Enrollment, roster, authenticated delivery, team identity, durable receiver and remote authority [R12] |
| Economics | Source-reported and API-equivalent dollars are distinguished; coverage and missing data are retained | Clear UI bases, allocation rules, billing imports, period closing and reconciliation [R13] |
| Taxonomy/delivery | ADR-0056/0057 are branch proposals, with documentation/explainer changes | Implement canonical semantics and a new product experience; refine delivery evidence first [T56] [T57] |

**Correct the telemetry terminology:** the community presentation called the export “OpenTelemetry format.” The inspected fleet contract is a custom versioned JSON snapshot with a metric catalogue. This report does not claim it is already an OTLP exporter. Native OpenTelemetry ingestion/export is a separate integration opportunity. [M2] [R12]

### Defects and trust issues to address before the redesign

| Priority | Finding | Evidence and recommended response |
|---|---|---|
| P1 | A generated recommendation calls nonexistent `ak x blocks audit` | Confirmed at this checkout: command exits 2. Generate recommendations from the registered action catalogue; choose context audit or reference diff according to intent. [D1] |
| P1 | Status/nudge and sync disagree about enabled guidance blocks | A read-only synthetic-config reproduction returns different detector results with Codex installed but disabled. Use one desired-state selector for all surfaces. [D2] [D10] [D11] |
| P1 | Legacy MCP migration can be advertised although its writer rejects an absolute executable path | Pure-function checks show bare and absolute paths treated differently. Share eligibility results; distinguish transport identity from ownership before changing anything. [D3] [D12] [D13] |
| P1 | “Nothing actionable” can be rendered as “all healthy” | The no-plan sync branch makes that claim; final convergence also permits ordinary warnings. Report applied, held, unmanaged, failed, and unverified separately. [D4] |
| P1 | AgentDB install lacks executable-owner preflight | Source supports the gap; the particular proxy collision comes from [issue #237][I237]. Show who owns the binary and whether its version/schema is compatible. Preserve the collision guard. [D5] |
| P1 | Brain invocation omits `--update`; the overlay failure needs version-specific upstream confirmation | Source confirms current arguments; [Issue #237][I237] reports the private-overlay failure. Validate the exact upstream version’s install/update contract and active-update state. [D6] |
| P2 | Installed/unknown/preserved/unreviewed states are difficult to interpret | Separate the facts and explain the missing check; expose the last verified result with age. Installed does not prove configured or connected. [D7] |
| P2 | System collection is delivered as a whole payload | Code supports the pagination concern; the 22.9 MB figure is [issue #237’s][I237] measurement, not ours. Split summary and detail queries, then measure. [D8] |

The same-browser token observation is **not a confirmed security vulnerability**. Current help explicitly describes a reusable per-server token; the browser stores it locally. Safari rejecting access is compatible with lacking that token. If v5 adopts a one-time launch link, that is a new bootstrap/session contract, with fresh-browser tests. [M1] [R1] [D9]

### ADR standing matters

| ADR | Recorded status/date | Consequence |
|---|---|---|
| 0014, dashboard authentication | Implemented; updated September 9 | Its “Maintenance-only” write exception is stale: host-health writes now exist. Reconcile the text during the next operations change. [A14] [R3] |
| 0016 / 0018 / 0029 | Accepted capability adapters; implemented worker execution; accepted experimental external adapters | Extend these contracts and conformance boundaries. [A16] [A18] [A29] |
| 0044, maintenance control plane | Implemented; updated September 9 | Preserve preflight, exact scope, verification, ownership and receipts. [A44] |
| 0048, inventory-led management | Accepted; updated September 20; implementation delivered, human/cross-platform gates open | Reuse its machinery without declaring its remaining validation complete. [A48] |
| 0054, fleet evidence | Implemented; September 20 | Export is a foundation; enrollment, scheduling and remote control are explicit exclusions. [R12] |
| 0056 / 0057, delivery/taxonomy | Proposed; September 21; explicitly unimplemented | Rework navigation freely while retaining semantic discipline. [T56] [T57] |
| 0058, Ruflo components | Accepted, implementation in progress; latest recorded update September 24 | It records governance configured but not enforced through tested Ruflo 3.44.0 stdio paths. The UI must preserve that distinction. [A58] |

The concrete documentation drift is ADR-0014’s Maintenance-only claim versus the runtime host-health allowlist. Reconciling it is recommended; this research leaves architecture records unchanged. ADR-0058’s enforcement limitation is recorded integration-test evidence about upstream behavior, not something a prettier green badge can repair. [A14] [R3] [A58]

## 4. Three approaches worth exploring

| Approach | Experience and architecture | Benefit | Cost / constraint |
|---|---|---|---|
| **A. Local workbench + optional team service — recommended** | Local collection and execution; one operation/query core; browser workbench; optional enrolled receiver | Useful immediately for an individual; extends existing ownership and privacy model; grows to teams | Must design identity and schema evolution early; team operations add a real service boundary |
| **B. Fleet service first** | Always-connected central console with device agents and organization policy | Strong shared operations, enrollment and reporting from day one | Larger authentication, hosting, tenancy and operations commitment; weaker offline simplicity |
| **C. Insight companion** | Focus on sessions, labels, economics and links into native tools | Smaller intervention surface; fast path to better analytical value | Does not fulfill the requested UI/CLI configuration and scheduled-maintenance promise |

These are proposed product choices. Approach A best fits the existing local control plane and the meetings’ mixed individual/team needs. It also leaves open a self-hosted team service or an eventual hosted offering. Choose a deployment model after validating actual team demand; no cloud service is required to make local v5 valuable. [M1] [M2] [A44] [R12]

For visual exploration, test three presentations over that same core: **workbench** (calm attention queue and contextual detail), **command canvas** (search/actions and user-pinned workspaces), and **fleet cockpit** (cohorts, changes and incident timelines). The included concept develops the workbench, with alternate role starts and density/accent choices. The command canvas should complement ordinary discoverable controls; critical functions should not depend on knowing a command name.

## 5. The experience: useful surprise, earned trust

The signature journey should be: open `ak dashboard`; see why a client project needs attention; inspect the affected session; understand the cost basis and missing evidence; preview one settings or update change; apply it; see verification; save a policy for next time. Every transition preserves project, environment, time window, labels, and the user’s place.

| Reader | First question | First useful action |
|---|---|---|
| Builder | What needs me, and can I continue safely? | Resume work, inspect a blocker, repair a local setup issue, hand off a checkpoint |
| Operator | What is drifting, failing, stale, or awaiting a change window? | Plan one repair or a bounded cohort update |
| Team lead | Where is work waiting, and what evidence links effort to outcomes? | Investigate review/CI friction, assign ownership, follow project progress |
| Finance / client owner | What was used, what was charged, and what can be attributed? | Choose a cost basis, inspect unallocated amounts, close a period |
| Assurance | What happened, who authorized it, and what leaves the machine? | Inspect changes, policy exceptions, receipts and export scope |
| Architect / maintainer | Which combinations work, and what capability is missing? | Compare certified adapters, settings, dependencies and reusable profiles |

Use **scope**, **view**, and **permission** as separate concepts. “Finance view” is a presentation choice. It neither grants access to teammates’ data nor grants write permission. Guided/Advanced is a disclosure preference, while Manual/Notify/Managed care is an update policy. Combining them into one easy/expert toggle would conceal important choices. This adapts Stuart’s request for different defaults and the branch’s role-lens model. [M1] [T57]

Keep one semantic home for Consumption, Spend, Capacity, Practice, Delivery, Economics, Assurance and Estate; Operations provides shared actions across these domains. The revised navigation uses **Overview, Work, Insights, Manage, History**; saved views can cross those domains. A canonical metric catalogue defines units, evidence, scope, selection window, formula, aggregation and limitations. UI, CLI and exports consume that catalogue. [T57]

Proposed interaction details: a contextual inspector instead of repeated full-page navigation; reversible label edits with undo; searchable settings with their source and effect; an action history that survives refresh; explicit stale/offline/held states; keyboard paths, readable focus, and announced completion messages. Progressive disclosure supports approachable defaults while retaining expert controls; it still needs task-based usability testing. [Progressive disclosure][E1] [Accessible status messages][E2]

The sense of quality should come from precise transitions and useful explanations. Avoid decorative activity that implies a live signal when the source is historical, invented “AI productivity” grades, or a wall of metrics without a decision attached. Motion should respect reduced-motion preferences; touch controls need accessible target sizes. [E3]

### Shared panels and relevant attention

The earlier artifacts contribute evidence-aware states, synchronized comparisons, repository/module drilldowns and analytical depth. [Delivery Scorecard][UX1] · [Scorecard Additions][UX2] · [Dashboard Lenses][UX3]

The latest concept keeps a single canonical instance of each panel and stable navigation. Attention focus changes which findings appear first, why they matter and the suggested next action. It does not create another navigation tree, change severity, duplicate metrics or hide configuration. Multiple personae share cost coverage, runtime health, session evidence and other panels. Detailed migration and ownership decisions are in the [shared management design](shared-management-design.md).

The first role-focused revision explored 42 compositions; it is retained as an earlier experiment. The current proposal reduces that redundancy. ADR-0057 remains Proposed, and adoption should extend its metric catalogue with canonical shared panel identities and explicit relevance rules. [T57]

## 6. Configuration parity: one contract, every surface

**Release promise:** every setting that v5 declares managed has equivalent inspect, explain, validate, preview, apply, verify and recovery behavior in the UI and CLI. Coverage must be published by component version. Native settings outside that contract remain visible as unmanaged/unsupported, with their location and reason. The goal is comprehensive supported coverage, never silently hidden configuration.

Use three complementary editing layers: opinionated presets for common jobs; a full schema-driven form for supported settings; and a native, namespaced advanced view for additional versioned settings. A preset expands into explicit fields and a diff. A raw editor must not bypass validation, ownership, scope restrictions, policy locks, or secret handling.

| Configuration family | What the UI should expose | Shared behavior |
|---|---|---|
| Hosts and profiles | Installations, roots, enablement, defaults, execution limits, native extensions | Version/scope validation; explain effective value; native login handoff |
| Providers and models | Provider/model bindings, local endpoints, budgets, fallbacks | Preserve payer/auth mode; show unavailable model or unsupported option |
| Routing | Activity → host/model; explicit escalation; per-project overrides | Reuse existing routing intent and projection [R7] |
| Ruflo and components | Pickers, learning profile, governance intent, funnel, evidence | Separate configured, projected, observed, and enforced states [A58] |
| Agentic QE | Provider/embedding choices, corpus readiness, gates, concurrency | Explain prerequisite and last verification; preserve memory |
| AgentDB / RuVector / Brain | Store and namespace references, supported backend knobs, refresh/retention | Respect package/schema compatibility, native capabilities, and private overlays |
| MCP, hooks, plugins, skills | Source, owner, target hosts/projects, version, permissions, enablement | Avoid duplicate projection and external-resource takeover |
| Observation and sharing | Sources, content capture, retention, export scopes, sampling | Local operation and external sharing have separate controls |
| Updates and schedules | Targets, channel/pin, timing, permitted changes, exceptions | Same planner and receipts as manual execution |

A setting descriptor needs type/range, default, supported versions, allowed scopes, native read/write mapping, ownership, secret/reference rules, effective precedence, restart impact, verification and recovery capability. Do not impose a fictitious universal precedence order on native hosts. Show the adapter’s resolution and any organization constraint.

**Current boundary:** Maintenance permits exactly one exact write action per executable plan. A batch coordinator should sequence those independent plans and receipts initially; a true multi-action plan requires a new versioned contract covering ordering, partial failure, cancellation and recovery. [R16]

Both surfaces submit the same typed request. A proposed flow is `ak config explain …`, then `ak config plan … --set key=value`, then `ak operations apply <plan-id>`. The plan binds exact target identities, expected revisions, the diff, native actions, authority and checks. Before applying, re-read the affected state. If it changed, return a conflict with a refreshed preview. Store only the values owned by the operation in its recovery receipt. Existing maintenance provides the base pattern. [A44] [R2]

Model **host type → installation → profile/environment → project/session context**. Record binary origin, config/state/transcript roots and management owner explicitly. Multiple profiles may share a binary; an update of that binary can affect all of them. Changing settings for one profile must not be presented as an isolated binary update. The currently inconsistent root handling makes this foundational work, not just a new dropdown. [R9] [Hermes profiles][H8]

## 7. On-demand and scheduled updates at every scale

The selection model is **targets × resources × version policy × timing × rollout policy**. Target one component, one host installation, one environment, a project collection, a machine cohort, or all managed resources. Expand dependencies before approval: “update AgentDB” may be constrained by Ruflo’s bundled schema; “update Hermes” may affect several profiles. Display every affected resource and its management owner. [D5] [H9]

| Policy | User promise | Execution behavior |
|---|---|---|
| Manual | Nothing changes until I apply a plan | Checks may run on demand; explicit preview/apply |
| Notify | Keep me informed | Scheduled checks; notify on meaningful change or required action |
| Stage | Prepare a reviewed change | Resolve and download where supported; no activation |
| Managed care | Keep this declared set current within my boundaries | Fresh plan inside a maintenance window; only preauthorized compatible changes |
| Team rollout | Prove a cohort before broadening | Canary → verification/soak → next cohort; automatic halt on failure |

These are proposed policies. A saved schedule stores **intent and authority**, not yesterday’s executable plan. At run time, resolve current versions and target membership, check policy, materialize an exact plan, acquire resource locks, and execute. A newly matched label must not silently expand an already approved one-time batch. Scheduled selectors need an explicit rule for whether new members are eligible.

Design the uncomfortable cases now: timezone and daylight-saving transitions; sleeping/offline devices; one bounded catch-up; duplicate triggers; overlapping schedules; active sessions; partial dependency failure; interrupted downloads; permission/auth renewal; maximum duration; retry limits; cancellation; and restart required. There should be one visible owner of updates for each installation. If its native auto-updater remains in charge, ak reports and coordinates with that owner.

Prefer a small durable job runner invoked by platform scheduling adapters—launchd, systemd user timers, Windows Task Scheduler—while the local product stays lightweight. An always-running daemon is an alternative when queueing and fleet work justify its operational cost. Both must call the same operation service. The updater must survive the process it updates; Hermes’ documented update handoff and receipt behavior illustrates why supervision and installation identity matter. [H9]

Make batch results truthful: **“3 applied; 1 restart pending; 1 held; 1 failed.”** Rollback is per capability. Restoring owned settings, reinstalling a prior binary, and reversing a storage migration are different promises. Never offer an unconditional “undo update” where the upstream state format cannot be reversed. Current `ak sync` remains a compatibility facade while the new planner grows. [R4] [A44]

## 8. Equal support for six hosts

Equal support should mean equal quality of discovery, configuration, execution supervision, observation, maintenance, and explanations. It cannot mean identical native features. Certify each axis independently against an exact host version, adapter version, platform, and installation method. Reuse the existing host/provider/projection/observability separation. [R8] [A16] [A29]

| Host | Documented integration surfaces | v5-specific design issue |
|---|---|---|
| **Claude Code** | Layered settings; `-p` and stream JSON; MCP/hooks; native usage monitoring; multiple installation/update methods | Honor native policy and update owner; approximate usage cost is not an invoice. [H1] [H2] [H3] [H20] [H21] |
| **Codex** | TOML configuration and profiles; `exec --json`; MCP/hooks; optional OTel; app-server interface | Probe the installed schema and profile form; preserve sandbox policy and billing mode. [H4] [H5] [H6] [H22] [H23] [H24] |
| **Hermes Agent** | YAML/profile homes; noninteractive structured events; MCP/hooks; native updater | Separate installation, profile, gateway and session; preserve profile data and use the installation’s supported updater. [H7] [H8] [H9] [H25] [H26] |
| **OpenCode** | JSON/JSONC configuration; run JSON or supervised server/SSE; MCP/plugins | Retain the existing authenticated loopback integration; separate server auth from provider credentials. [H10] [H11] [H12] [H27] [H28] [H29] |
| **Gemini CLI** | Layered settings; headless stream JSON; MCP/hooks; OTel | Explicitly choose content-logging policy; support its home/root semantics and release channels. [H13] [H14] [H15] [H30] [H31] [H32] |
| **Grok Build** | Official `grok` CLI; TOML; `streaming-json`; ACP; MCP/hooks; native update controls | Project settings support a narrower subset; audit Claude/Cursor compatibility discovery for duplicate logical hook registrations. [H16] [H17] [H18] [H33] [H34] |

Grok Build is a host; xAI/Grok is also a provider/model choice in other hosts. Gemini CLI and the Gemini provider are similarly distinct. Record host, serving provider, requested/resolved model, credential mode, and payer separately. A six-logo grid alone would hide the distinctions that matter for costs and policy. [Grok through OpenCode][H19]

The parity suite should verify discovery, effective configuration, locked scope, preserved unknown keys, stale-plan conflict, auth/permission/quota failures, malformed/truncated events, cancellation and descendants, duplicate events, absent usage, install-owner mismatch, interrupted update and post-restart health. A capability can be **supported**, **partially observed**, **unavailable**, or **not yet certified**. A failed probe does not silently choose another provider or spend path.

Target common management coverage for all six in v5 GA; list optional native integrations separately. Maintain a public capability matrix and fixtures. Browser cards should show **Manage / Run / Observe / Update** independently, with “why” and evidence age. The host appendix research supports feasibility; it does not certify these adapters as implemented.

## 9. Labels, collections, and trustworthy economics

Treat labels as a separate user-owned organization layer. A project and a session may each have multiple labels. A session can inherit project labels and add explicit ones; provenance must be visible. Saved collections are named queries, such as `client:acme AND initiative:checkout`, rather than another physical directory structure. This directly answers the community workspace discussion. [M2] [R11]

Give labels stable IDs, namespaces, visibility and assignment history. Rename labels without breaking membership. Support bulk edit/undo, explicit exclusions, and archive rather than silently deleting historical meaning. Automatic assignment begins with deterministic project/path rules. Model suggestions should show evidence and allow abstention; applying a suggestion should never silently change financial allocation.

**The arithmetic rule:** select distinct sessions/events first, then calculate all metrics from that population. Any = union; All = intersection; Exclude = difference. A session carrying Acme and Platform counts once in their combined view. Overlapping breakdowns are marked non-additive. For additive chargeback, use a different allocation rule with explicit weights and an Unallocated bucket. FinOps guidance distinguishes allocation metadata from shared-cost strategies. [E4]

Example: one $10 session belongs to Platform and v5; a second $20 session belongs to Platform. Platform totals $30; v5 totals $10; Any(Platform,v5) totals **$30**, and All(Platform,v5) totals **$10**. A separate 50/50 allocation of the first session yields $25 to Platform and $5 to v5. The grouping never changes the original cost facts. This is a synthetic example, not measured usage.

| Cost basis | What it answers | Required disclosure |
|---|---|---|
| API-equivalent estimate | What would observed usage cost at this stated rate card? | Provider/model, input/cache/output semantics, rate date, unpriced coverage |
| Source-reported cost | What cost did the host/provider report for observed activity? | Source, currency, correlated scope, unknown portion; may still differ from invoice |
| Invoice spend | What was charged in the billing period? | Billing account, credits/fees/taxes, reconciliation and unmatched spend |
| Allocated plan cost | What part of a subscription/prepaid charge do we assign here? | Explicit allocation basis, weights, period and policy version |

Do not add these four bases together. FOCUS distinguishes billed, effective, and list costs; those definitions are useful reference points, but transcript-derived API equivalence does not automatically become a conformant billing record. Claude also explicitly describes its native cost metric as approximate. [E5] [E6] [E7] [H3]

Show **current labels** versus **labels as of the reporting period**. Interactive reorganization can recalculate history; a closed billing report should preserve membership and allocation versions. Account-wide provider data that has no session correlation belongs in an unmatched/account view, not silently apportioned to visible projects. Today’s OpenRouter reader already documents this boundary. [R14]

Retain zero-versus-unknown, source coverage and currency. Reconcile provider imports with host observations using lineage/request identity before merging. Preserve existing treatment of cumulative Codex subagent usage so parent/child replay cannot inflate totals. Compute ratios from summed numerators/denominators and percentiles from compatible histogram populations. [R13] [R15] [R12]

## 10. Observation, fleet, and team visibility

Build an evidence pipeline with native transcript/event adapters, optional native OTel, and source provenance. Normalize installation/profile/project/session/request identity, timestamp, provider/model, token semantics, failure state, and parent/child relationships. Maintain source-specific payloads behind the normalized view. “Not observed” is a first-class answer.

Current OpenTelemetry GenAI conventions have moved repositories and the client-span definition is marked Development. Pin a supported schema version. Its input/output token totals include particular cache/reasoning subsets; mapping them onto existing fresh-input/cache fields requires care to avoid double counting. Content capture should be an explicit policy. [E8] [E9]

The community’s proxy discussion is useful evidence of a visibility need, not a requirement to intercept every host’s credentials or traffic. Prefer supported native observation first. An optional user-controlled API gateway can be explored for API-key workflows where supported, with separately stated coverage. Do not promise universal full-session capture or assume subscription authentication can be repurposed. [M2]

A session inspector should connect goal, timeline, tools, delegations, retries, compaction, policy decisions, artifacts, changes and results. Every event shows source and observation time. Optional local retention should be explicit and bounded; today’s replay buffer is not a durable transcript archive. The presenter’s retention anecdote should not become a hard-coded cross-host retention assumption. [R10]

For fleet, add an **expected roster** and enroll installations. Associate people only through explicit membership, not hostname/profile guesses. Show machine, installation, environment and host instance separately. Include last seen, reporting completeness, desired/observed configuration, pending restart, ownership, and update eligibility. A device that stopped reporting is stale/offline, never healthy based on yesterday’s green result. Existing fleet export supplies deduplication and provenance foundations. [R12]

Keep telemetry and remote control as separate planes. First ship authenticated aggregate ingestion and local execution of approved plans. Later add signed, scoped remote requests with local policy enforcement, revocation, expiration, idempotency, and durable receipts. A team view does not automatically grant command execution. Raw transcript access is separately governed from aggregate operational data.

Evaluate Ruflo federation with a focused prototype, as offered in the meeting. Ruflo ADR-104 describes an implemented plugin-owned WebSocket fallback and pending native QUIC work; it is evidence of a transport option, not a turnkey agentic-kit fleet service. Validate identity, authorization, delivery/replay, offline behavior and isolation before choosing it. A receiver for existing snapshots may be a smaller first milestone. [M2] [E10]

Delivery metrics need stronger evidence than activity counts. Start with linked work items, reviewed PRs, CI results and actual deployment/recovery events. DORA’s current guide uses five delivery metrics and emphasizes application/service context; SPACE warns against reducing productivity to one activity measure. Commits, lines, tokens and hours are context, not causal proof of AI value. [E11] [E12]

Revise ADR-0056 accordingly: a `fix:` commit within 48 hours is a heuristic, not a defect rate; time overlap is association, not AI attribution; max counters across clones are a lower bound, not a distinct union. Exact cross-clone counts need explicit project mapping and suitably protected event identities. [T56]

### Other implementation ideas to retain

| Idea | Proposed product treatment | Basis |
|---|---|---|
| Support without screenshots | `ak problem-report` creates a local bundle of versions, roots, selected diagnostics and operation receipts. Preview/redact before an explicit send. Keep support consent separate from product analytics and fleet sharing. | Stuart [M1] |
| Evidence that integrations actually ran | Show the last memory write/read, routing decision, hook invocation and receiving-host checkpoint result. Configuration alone should not imply successful use. | Stuart [M1] |
| Account and fallback clarity | Show which account/profile supplied a quota observation and whether a fallback could introduce metered spend. Multiple subscriptions are distinct sources. | Stuart [M1] |
| Reliable first load | Explain collection progress, partial results and retry states; investigate demo reports that Usage/History/Models appeared only after refresh. | Reported, not reproduced [M1] |
| Reusable care recipes | Named, inspectable sequences for setup, repair and release preparation, executed through the shared operation service. Preserve hook ownership and avoid competing executors. | Stuart [M1] |
| Meet users in their host | Deep links, a host-native launcher, and eventually narrow MCP read/action surfaces backed by the same authorization and plans. | Community exploration [M2] |
| Learn from corrections | Evaluate classification on consented examples; retain confidence, abstention, user corrections and measured failure cost. | Community exploration [M2] |
| Measure adoption honestly | Optional minimal product events can help prioritize views. Downloads, stars, machines and people remain different quantities. | Stuart [M1] |

## 11. Product architecture and migration

The proposed bounded contexts are **Identity & Scope**, **Configuration**, **Operations**, **Scheduling**, **Observation**, **Organization**, **Economics**, and **Delivery Evidence**. Their contracts meet in a small application layer consumed by CLI, local UI and optional team receiver. Keep host adapters responsible for native semantics; keep inference routing in its existing integration; keep project memory in AgentDB rather than inventing a second conversational memory store.

| Contract | Minimum fields / responsibility |
|---|---|
| Resource identity | Stable ID, installation/profile, native owner, version, location, capability evidence |
| Setting descriptor | Type, scope, default, effective source, native mapping, policy, verification and recovery |
| Operation request/plan | Intent, actor, targets, expected source state, action/dependency graph, impact, permission receipt |
| Operation result | Per-action status, postcondition evidence, restart/held state, recovery availability |
| Schedule policy | Target rule, allowed changes, window/timezone, idle policy, missed-run semantics, expiry |
| Observation fact | Source ID/version, event identity, observation time, normalized value, missingness/provenance |
| Metric/query | Canonical definition, unique population, period, cost basis, coverage, formula version |
| Organization mapping | Labels, saved collections, person/team/project references, sharing and assignment history |

These are design proposals. Preserve the zero-runtime-dependency local CLI unless a measured requirement justifies a change. The optional team receiver can be separately packaged. For durable state, evaluate versioned JSON/event logs against a supported embedded database with benchmarks and migrations; do not choose a storage engine just because another ecosystem component uses it. Keep transactional product metadata separate from semantic project memory.

Migrate additively: read current `kit.json` and ownership receipts; assign identities to existing installations without moving their roots; import existing discovery sources; retain legacy command aliases and deep links; version the telemetry schema; provide dry-run migration and a recovery path. The new configuration engine should adopt existing owned values while preserving unowned and unknown fields. Schedule installation is opt-in. Existing native updaters must be reconciled before any shared policy becomes active.

Use vertical slices to replace UI areas while comparing the old and new query outputs against the same fixtures. Avoid a prolonged dual-definition period: calculations live in shared services, not independently in old and new pages. Changes to accepted ADRs travel with implementation and evidence, including ADR-0014 reconciliation, ADR-0054’s new fleet boundary, and versioned settings/operations contracts.

## 12. What makes this a v5 release

| Slice | Deliverable | Exit evidence |
|---|---|---|
| **0 · Repair trust** | Valid actions, consistent status/sync, ownership-aware diagnostics, truthful partial results | Reproduced defects fixed with regression evidence; reported cases separately closed |
| **1 · Shared foundations** | Installation/profile identity, schema/action catalogue, query semantics, operation plans | Same request yields same plan and result through UI and CLI; migration preserves user-owned data |
| **2 · First complete experience** | Role starts, full supported settings, labels, economics, support bundles, flag-free complete launch | A user completes setup → diagnosis → scoped change → verification without leaving the UI |
| **3 · Managed care** | Coarse/fine update selection, schedules, compatibility policy, interrupted-run recovery | Sleeping/offline/busy/partial-failure scenarios produce correct bounded outcomes |
| **4 · Six-host support** | Claude, Codex, Hermes, OpenCode, Gemini CLI, Grok Build adapters | Version/platform/installation-specific capability matrix and passing common contracts |
| **5 · Team visibility** | Enrollment, roster, authenticated aggregate receiver, freshness, sharing controls | Replayed snapshots do not inflate metrics; stale devices and access boundaries are correct |
| **6 · Outcomes and financial evidence** | Delivery joins, billing imports, allocation, period reports | Every amount/outcome is traceable; unknowns and unmatched data remain visible |

My proposed **v5.0 commitment** includes slices 0–5, plus a modest initial delivery view and explicit manual plan-cost allocation. Provider invoice reconciliation, broad remote write orchestration and causal ROI analysis can follow in v5.x. If capacity requires a smaller launch, reduce the marketed scope explicitly; do not claim six-host parity or team management from logos and file export alone.

The strongest first demonstration is one vertical slice: discover two profiles on a machine; open the dashboard without flags; label a client’s work; inspect distinct-session totals; edit a routing/component setting; preview its native effect and CLI equivalent; apply and verify; then schedule the same class of maintenance. It proves the product thesis before broadening every adapter.

Proposed acceptance targets should be calibrated on a recorded reference workload: first useful view within 2 seconds on a warm local index; no required whole-inventory payload for that view; interactive filters within 200 ms on 10,000 normalized sessions; bounded initial transfer; no duplicate scheduled operation; no silent widening of targets; and explicit source coverage. These are targets, not measured results. Benchmark 1, 25 and 100 projects, warm/cold indices and slow disks before adopting budgets.

Recruit a small mix of the actual readers: a solo builder, a consultant billing clients, an operator managing several environments, a team lead, and an assurance reviewer. Give them concrete tasks: fix one warning, find why a host is unknown, set a one-component update policy, calculate an overlapping-label total, and explain a dollar figure. Observe completion and misunderstanding, alongside optional aggregate product analytics. Ask for diagnostic uploads separately from product analytics. [M1] [E1]

## 13. Interactive mockups and review guide

The current concept explores five stable areas: **Overview, Work, Insights, Manage, and History**, plus an interactive migration map. It includes a six-step onboarding/adoption wizard, a complete source-backed settings catalogue, installation/lifecycle inspectors, drift remedies, upgrade eligibility, live operation progress and optional schedules. All machine observations, candidates and operation results are illustrative.

Try these paths: switch Attention for on Overview or Drift and observe the same findings ranked differently; open the existing-panel map; inspect all settings with advanced CLI inputs optionally visible; change a Ruflo setting and review its per-machine diff; apply a remedy and navigate while it runs; preview a fleet repair with busy/offline/unaffected targets; enable a schedule draft and review it before saving; rerun assessment and choose what to adopt. New setup defaults selected resources to managed, preserves external package owners and leaves scheduling off.

The concept previews selected shared panels and management flows. The 101-row mapping is a preservation contract, not a claim that every native interaction has been recreated. Fields distinguish existing managed intent, invocation-only options, read-only evidence, unsupported features and proposals. Production still requires the shared operation service, full native validation, durable state, authenticated fleet delivery and runtime verification. [Panel mapping](panel-map.md) · [Management rationale](shared-management-design.md)

### Verification of this deliverable

Research includes full-transcript retrieval, revision-bound source inspection, the taxonomy-branch comparison, current primary documentation, and bounded read-only defect reproductions. Prototype verification and remaining limitations are recorded in the [verification note](verification.md). The [meeting traceability appendix](meeting-evidence.md) records 53 candidates, and the [implementation evidence appendix](implementation-audit.md) supplies deeper source and reproduction detail. No comprehensive application regression run, six-host runtime certification, real update execution, fleet deployment, financial reconciliation, or WCAG certification is claimed.

## Sources

Meeting citations are private Granola links accessible to authorized readers. Repository references are immutable commit links. Upstream documentation links were accessed September 25, 2026 and can subsequently change. Recommendations without a factual attribution are explicitly proposed design judgments.

[M1]: https://notes.granola.ai/d/d513ea2e-3b15-48a9-b08e-42c78e627532
[M2]: https://notes.granola.ai/d/6416b991-34b4-428c-85bb-951c5e0442d4
[R0]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/package.json
[R1]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/x/dashboard.mjs#L30
[R2]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard/maintenance-security.mjs#L24
[R3]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard-server.mjs#L1357
[R4]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/sync.mjs#L91
[R5]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/maintenance/provider-registry.mjs#L51
[R6]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/config.mjs#L24
[R7]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/x/host.mjs#L129
[R8]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/adapters/registries.mjs#L194
[R9]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/paths.mjs#L48
[R10]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0012-observability.md#L87
[R11]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/usage-project-groups.mjs#L22
[R12]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0054-fleet-evidence-export.md
[R13]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/usage-cost.mjs#L3
[R14]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/usage-openrouter.mjs#L1
[R15]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/usage-aggregate.mjs#L1285
[D1]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/usage-insights.mjs#L301
[D2]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/blocks.mjs#L539
[D3]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/mcp.mjs#L121
[D4]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/sync.mjs#L557
[D5]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/heal.mjs#L266
[D6]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/ruvnet-brain.mjs#L23
[D7]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0053-host-setup-evidence-and-usage-diagnostics.md#L20
[D8]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard-server.mjs#L1930
[D9]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard/client/bootstrap.mjs#L16
[A14]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0014-dashboard-auth-and-remediation.md#L3
[A16]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0016-capability-driven-integration-adapters.md
[A18]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0018-generalized-host-worker-execution.md
[A29]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0029-host-adapter-extension-point.md
[A44]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0044-receipt-aware-maintenance-control-plane.md
[A48]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0048-inventory-led-maintenance-resource-management.md
[A58]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0058-managed-ruflo-components.md
[T56]: https://github.com/pacphi/agentic-kit/blob/7b9093ef3e6d4c0efb9453ee5e48532a2064e612/docs/adr/0056-delivery-outcome-metrics.md
[T57]: https://github.com/pacphi/agentic-kit/blob/7b9093ef3e6d4c0efb9453ee5e48532a2064e612/docs/adr/0057-dashboard-taxonomy-role-lenses-and-metric-catalogue.md
[H1]: https://code.claude.com/docs/en/settings
[H2]: https://code.claude.com/docs/en/cli-reference
[H3]: https://code.claude.com/docs/en/monitoring-usage#cost-monitoring
[H4]: https://learn.chatgpt.com/docs/config-file/config-basic
[H5]: https://learn.chatgpt.com/docs/non-interactive-mode
[H6]: https://learn.chatgpt.com/docs/app-server
[H7]: https://hermes-agent.nousresearch.com/docs/reference/cli-commands
[H8]: https://hermes-agent.nousresearch.com/docs/user-guide/profiles
[H9]: https://hermes-agent.nousresearch.com/docs/getting-started/updating
[H10]: https://opencode.ai/docs/config
[H11]: https://opencode.ai/docs/server
[H12]: https://opencode.ai/docs/plugins
[H13]: https://geminicli.com/docs/reference/configuration/
[H14]: https://geminicli.com/docs/cli/headless/
[H15]: https://geminicli.com/docs/cli/telemetry/
[H16]: https://docs.x.ai/build/cli/reference
[H17]: https://docs.x.ai/build/settings
[H18]: https://docs.x.ai/build/features/hooks
[H19]: https://x.ai/news/grok-opencode
[E1]: https://www.nngroup.com/articles/progressive-disclosure/
[E2]: https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
[E3]: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
[E4]: https://framework.finops.org/framework/capabilities/allocation/
[E5]: https://focus.finops.org/docs/specification/v1-3/columns/billed-cost/
[E6]: https://focus.finops.org/docs/specification/v1-3/columns/effective-cost/
[E7]: https://focus.finops.org/docs/specification/v1-3/columns/list-cost/
[E8]: https://opentelemetry.io/docs/specs/semconv/gen-ai/
[E9]: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
[E10]: https://github.com/ruvnet/ruflo/blob/main/v3/docs/adr/ADR-104-federation-wire-transport.md
[E11]: https://dora.dev/guides/dora-metrics/
[E12]: https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/

[I237]: https://github.com/pacphi/agentic-kit/issues/237
[R16]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/maintain.mjs#L155
[D10]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/status/sections/blocks.mjs#L23
[D11]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/nudge.mjs#L43
[D12]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/mcp.mjs#L95
[D13]: https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/ruflo-mcp-transport.mjs#L3
[H20]: https://code.claude.com/docs/en/setup
[H21]: https://code.claude.com/docs/en/hooks
[H22]: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
[H23]: https://learn.chatgpt.com/docs/hooks
[H24]: https://learn.chatgpt.com/docs/config-file/config-advanced
[H25]: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
[H26]: https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks
[H27]: https://opencode.ai/docs/cli
[H28]: https://opencode.ai/docs/mcp-servers/
[H29]: https://opencode.ai/docs/providers
[H30]: https://geminicli.com/docs/tools/mcp-server/
[H31]: https://geminicli.com/docs/hooks/
[H32]: https://geminicli.com/docs/get-started/installation/
[H33]: https://docs.x.ai/build/cli/headless-scripting
[H34]: https://docs.x.ai/build/features/mcp-servers

[UX1]: https://claude.ai/artifact/V9Pk6Mj7VEe5SELXCUoLat
[UX2]: https://claude.ai/artifact/7kcwvZZmuzuNfwxNfQM8FT
[UX3]: https://claude.ai/artifact/M4UFzPKoTo9NdbR3MQou5g
