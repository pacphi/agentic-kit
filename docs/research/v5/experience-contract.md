# v5 shared workbench experience contract

**Earlier design input:** the latest [shared management design](shared-management-design.md) and [settings organization](settings-organization.md) supersede navigation suggestions in this memo. Source findings remain part of the research record.

Design proposal, 2026-09-25. This replaces the previous 42-composition approach with a shared panel catalogue, stable navigation and a role-sensitive attention queue. The separate `attention.json` contains twelve **synthetic** findings. Sources justify their scenario classes; no sample condition is asserted to exist on the user's devices.

## One place for each question

**Keep navigation stable.** Recommended destinations: **Home, Work, Usage, Observe, Manage, Fleet, Activity**, with About/help available from the application menu. A role preference should not rename, reorder or remove these destinations. Do not combine a role selector with a second role-shaped sidebar. Set interests once in Preferences or during onboarding; permit several interests and personal panel pins. A compact “For you” switch on Home/Attention can show the saved preference without turning every page into a different application.

**One canonical panel identity.** A panel descriptor owns its question, data contract, canonical metric IDs, population/grain, evidence fields, supported filters, visual, drilldowns and actions. A role profile only references panels and ranks their relevance. The Cost coverage panel used by Finance, Lead and Assurance is the **same panel** with the same values, URL, formula, selected population and evidence drawer. It can be pinned in several places or linked from a brief without creating three computations.

**Adapt the decision, not the truth.** Attention order, a short “why this matters to you,” and the suggested next action may differ by interest. The finding title, condition, severity, measurement, freshness, target and remediation eligibility remain invariant. The full canonical panel does not change its name when roles change. Optional reader presets may emphasize existing columns; the preset is explicit, reversible and does not silently filter the population.

**Scope is independent.** The persistent target control reads `This machine / Selected machines / Whole fleet`; the project selector, activity window, label expression and cost basis remain visible where applicable. Inventory/configuration/update snapshots use the target scope and observation time. Historical session filters do not silently shrink machine inventory. A role preference preserves every selected scope, object, tab and time range.

**Authority is independent.** Finding relevance never grants rights. A button may be `Inspect`, `Preview`, `Request change`, or unavailable with a concrete reason according to the actual action capability. Reader preference is not RBAC. Existing offline exports do not establish authenticated enrollment, a person identity or remote-control permission. [Fleet contract, lines 146–169](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/TELEMETRY.md#L146-L169)

## Shared panels and who repeatedly needs them

| Canonical panel | Question / content | Primary readers | Next action |
| --- | --- | --- | --- |
| `attention` | Which evidenced conditions need a decision? One deduplicated queue | All | Inspect the finding |
| `hosts.health` | Installed/configured/authenticated/reachable/verified states and age | Builder, Operator, Lead | Diagnose one host |
| `hosts.routing` | Desired/effective/executed route, provider/account/model and fallbacks | Builder, Architect, Finance, Assurance | Preview a route change |
| `models.capabilities` | Host/model/version capability matrix, unknowns and lifecycle notices | Architect, Operator, Builder | Compare or verify a capability |
| `providers.accounts` | Native account references, source coverage, billing mode and quota bindings | Finance, Operator, Builder | Recheck with native authentication |
| `configuration.settings` | Searchable settings catalogue, effective values, inheritance, owner and write support | Builder, Operator, Architect, Assurance | Review one or several child diffs |
| `memory.intelligence` | Store/namespace bindings; configured, written, retrieved and acknowledged states | Builder, Architect, Operator | Verify a checkpoint/handoff |
| `work.projects` | Project/repository/worktree identity, modules, labels and linked activity | Builder, Lead, Architect, Finance | Open project inspector |
| `work.labels` | Curated labels/collections, suggested membership, overlap and assignment history | Builder, Lead, Finance | Review label changes |
| `usage.summary` | Sessions, token composition, rhythm and normalized source coverage | Builder, Lead, Finance | Inspect contribution records |
| `usage.limits` / `usage.context` | Account headroom and paired context-pressure evidence | Builder, Operator, Architect | Review work/route with cost consequences |
| `cost.coverage` / `cost.trends` | Reported cost, API-equivalent estimates, pricing basis and unknowns | Finance, Lead, Assurance, Builder | Investigate coverage or rates |
| `usage.classification` / `usage.prompts` | Work-purpose classification, confidence, provenance and prompt patterns | Builder, Lead, Architect | Correct labels or inspect patterns |
| `assurance.hooks` | Hook configuration, invocation evidence, ownership and conflicts | Assurance, Operator, Builder | Inspect/preview a scoped change |
| `sessions.live` / `sessions.history` | Sessions, events, source gaps, replay and checkpoints | Builder, Operator, Architect, Assurance | Diagnose or hand off |
| `system.footprint` / `system.storage` / `runtime.processes` | Resource impact, retained data, active processes and reclaimability | Operator, Builder, Architect | Inspect exact resource/action |
| `maintenance.inventory` / `.guidance` / `.discovery` / `.activity` | Existing inventory, procedures, scans and receipts | Operator, Assurance, Builder | Existing exact-provider workflow |
| `updates.candidates` / `.schedules` / `.history` | Compatibility set, plans, windows, canary and per-target results | Operator, Lead, Architect, Assurance | Preview a campaign or individual operation |
| `fleet.environments` | Expected/reporting installations, people mappings, grants and freshness | Operator, Lead, Assurance, Finance, Architect | Inspect environment/enrollment |
| `delivery.outcomes` / `cost.allocation` | Linked outcome evidence and explicit financial allocation | Lead, Finance | Inspect linkage or draft allocation |

The last two rows and scheduler/campaign management require proposed v5 sources. Do not populate them with “available now” badges merely because a mockup has numbers. Every synthetic panel should show **Sample data** and, separately, **Existing evidence family** or **Proposed source**.

## Current dashboard → shared panel mapping

Preserve each existing destination and its useful content; each gets one canonical mapping and legacy redirect. This is a coverage checklist, not a mandate to preserve the old chrome. Existing navigation is verified in [page.mjs, lines 137–228](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard/page.mjs#L137-L228).

| Current destination | Canonical destination / panels |
| --- | --- |
| About | Help → `about.stack-directory`, setup ownership and component explanations |
| Overview / Summary | Home → `attention`, `hosts.health`; metric references link to their canonical panels |
| Overview / Hosts & Routing | Manage → `hosts.health`, `hosts.routing` |
| Overview / Providers | Manage → `providers.accounts` |
| Overview / Runtime | Manage → `runtime.configuration` (configuration/capacity; distinct from processes) |
| Overview / Intelligence | Work or Manage → `memory.intelligence`, preserving project/user scope |
| Usage / Score | Usage → `usage.summary`, `cost.trends`, `usage.practice`; preserve token, rhythm, model/tool, project and reliability panels |
| Usage / Limits | Usage → `usage.limits` |
| Usage / Findings | Home → `attention`, with a saved Usage filter; no duplicate findings store |
| Usage / Prompts | Usage → `usage.prompts`, including provenance/privacy controls |
| Usage / Context | Usage → `usage.context`; never confuse it with configured capacity |
| Usage / Hooks | Manage → `assurance.hooks` |
| Usage / Models | Manage → `models.capabilities`, routes and lifecycle |
| Usage / Sessions | Observe → `sessions.history`, financial/activity columns and transcript drilldown |
| Observability / Live | Observe → `sessions.live` |
| Observability / History | Observe → `sessions.history` replay mode; keep the same session identity as Usage Sessions |
| System / Summary | Manage → `system.footprint`, with links to all measured populations |
| System / Advisory | Home → `attention`, with a saved Resource filter |
| System / Sessions | Manage → `system.session-footprint`; storage-size population remains distinct from usage-session counts |
| System / Storage | Manage → `system.storage` |
| System / Runtime | Manage → `runtime.processes` |
| System / Projects | Work → `work.projects`, with footprint/module/source views |
| System / Maintenance / Inventory | Manage → `maintenance.inventory` |
| System / Maintenance / Guidance | Manage → `maintenance.guidance` |
| System / Maintenance / Discovery | Manage → `maintenance.discovery` |
| System / Maintenance / Activity | Activity → `maintenance.activity` |
| Retired System / Catalog link | Redirect to `maintenance.inventory`, retaining existing compatibility behavior |

Do not collapse populations simply because their labels match. A usage session, live process, storage object, discovered folder, verified repository and enrolled environment are distinct entities. Shared context should relate them without summing incompatible quantities.

## Attention contract

`Finding = id + conditionFingerprint + exactTargets + severity + state + urgency + observedAt + evidence + relevantPanels + roleReasons + admittedActions`.

The identifier/fingerprint includes the exact affected resource set and source evidence revision. A fleet rollup groups child findings while preserving each child target and state. Opening the rollup never turns five installations into one write target.

Suggested ordering: conditions with immediate operational deadlines or blocked recovery first; then role relevance; then affected scope and age. A role can move a cost-coverage gap above a benign update reminder for Finance without recoloring the gap as an error. An operationally critical condition remains visible to all relevant affected users regardless of interests. Avoid an invented numeric “risk score.” Explain the order in ordinary words: **Before next run**, **Before next write**, **Useful for your report**, **At the next maintenance window**.

The default card contains title, invariant state/severity, exact scope, observation age, a one-line role reason and one primary action. “Why here?” reveals relevance and evidence. Other available actions remain in the same inspector. The entire card is not a disguised Apply button.

Dismiss/snooze acknowledges a reader disposition; it does not mark a condition resolved. A condition closes only after its verification postcondition or a supported explicit no-longer-applicable decision. No evidence → “Not checked/Unknown,” not “All clear.” Recovery, permission and source-integrity findings cannot be silently dismissed into green status.

`attention.json` supplies examples shared across roles: metered fallback, interrupted operation, stale environment, unacknowledged memory handoff, protected overlay, pending host restart, cost gaps, unclassified work, owned cleanup candidate, partial adapter coverage, profile override and low quota. Their severity never changes by role; their priority/reason/action does.

## Complete issue-to-outcome workflow

| State | Visible content | Allowed next step |
| --- | --- | --- |
| Inspect | Exact issue, machine/environment/project, source/age, what is known/unknown, related activity | Diagnose, acknowledge/snooze where permitted, inspect source |
| Diagnose | Named checks, read/network effects, per-check progress, findings and captured source revision | Stop, retry read checks, prepare remedy if supported |
| Remedy preview | Before→after diff; exact targets/dependencies; settings/version ownership; privilege/restart/recovery class; affected sessions; UI/CLI equivalent | Apply only the admitted plan, adjust scope, defer |
| Apply | Durable operation ID, completed/current/queued phases, output/progress, target-level failures | Cancel queued work; allow in-flight operation to reach its safe boundary |
| Verify | Actual postcondition checks with values and source timestamps; installed state separate from runtime activation | Finish, request host restart, inspect failure or recovery |
| History | Before/after evidence, policy decision, target IDs, checks, result, attempted/held counts, recovery eligibility | Export, inspect, guarded undo/compensation where supported, create a fresh follow-up plan |

The same operation model drives UI and CLI. A UI continues to update the relevant settings/inventory/panel after verification without reloading the whole dashboard. Real progress comes from operation phases and events; a timer reaching 100% never establishes success. In a demo, use an explicitly simulated phase stream and a recorded synthetic postcondition.

**Current boundary:** ADR-0048 is **Accepted**, updated September 20; implementation is delivered, while human-evaluation and cross-platform gates remain outstanding. It explicitly preserves one write action per placement/plan, exact provider authority and receipts. A general v5 fleet campaign is a new capability. Model it as a parent coordinating independently planned child actions; do not imply today's implementation supports a batch transaction. [ADR-0048 status](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0048-inventory-led-maintenance-resource-management.md#L1-L39) [Write contract](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0048-inventory-led-maintenance-resource-management.md#L294-L335)

## Single machine and fleet are explicit scopes of one operation model

For **one machine**, retain environment and resource selection: Studio / Work / Ruflo is not Studio / all profiles. For **whole fleet**, materialize a reviewed target manifest before apply: expected devices, environments, exact components, dependency closure, eligible/held/unknown/unsupported states and permissions. “All” must not silently adopt newly discovered devices after approval.

A canary stage applies only to its eligible child targets. Verify the canary before releasing dependent cohorts. A failed canary stops queued/dependent work; completed changes remain recorded, not erased. Offline, busy, private-overlay, unsupported and recovery-required targets stay visible in Held with a reason. They rejoin only after fresh diagnosis and a new valid child plan. Never display “Fleet updated” when three devices were skipped; say “2 verified, 3 held” and expose the denominator.

**Restart taxonomy:** (1) refresh a panel's evidence, (2) reload an adapter/configuration if natively supported, (3) restart a named MCP/service process, (4) restart a named host application, (5) restart the dashboard service, (6) restart the machine. These are separate operations. A plugin update can verify on disk yet remain activation-pending while two host sessions are running. Offer finish/checkpoint → native restart request/instructions → verify loaded version. Dashboard restart must never substitute for host restart. Unknown native restart capability means instructions/request, not simulated force-kill. Existing owner-specific restart and undo limits are documented. [Managed capabilities](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/MAINTENANCE.md#L420-L479)

**Schedules start OFF.** A draft cadence is not an enabled job. The final review shows Enabled: Off/On, exact target selector or frozen target set, allowed action, compatibility channel/pins, timezone/window, idle rules, canary policy, permission ceilings, missed-run handling and notification conditions. Check-only and notify are valid choices. Default missed-run behavior: one catch-up inside the next allowed window. New permissions, migrations, target expansion or expired evidence require a new decision; the scheduler cannot grant itself authority. Pausing a schedule stops future starts, not an already-running child action without reaching its safe boundary.

## Onboarding and adoption wizard

Use the wizard for **first setup, importing an existing installation, adding a machine, or a deliberate Re-assess**. Routine repairs and setting edits open their direct inspectors. Do not make a user complete six setup screens whenever a plugin update is available.

1. **Assess.** Bounded read-only inventory of native executables/package owners, host profiles, tools, relevant settings and existing kit ownership. Display found/missing/ambiguous/unsupported and proposed source roots; explain what was not inspected. Existing user data and private overlays remain visible.
2. **Choose hosts.** Select desired hosts and environments; clearly distinguish existing, installable, detected-only and candidate adapters. One machine can have Work and Lab with different roots/channels. A chosen host is not proof its authentication or runtime works.
3. **Choose tools.** Select the curated components and dependency closure. Defaults are managed for the chosen setup **where a supported native ownership contract exists**. Required, optional and unsupported are distinct; show the practical cost of opting out once.
4. **Set management policy.** Management through the native installer remains native: Homebrew stays Homebrew, npm stays npm, a native app stays native. Preserve who installed an item separately from whether kit is allowed to manage it. Unknown installer identity cannot be “adopted” by silently reinstalling with another manager. Schedule defaults OFF. Choose channel, scope, checks, canary, idle/restart rules and local/team sharing explicitly.
5. **Review changes.** One concrete manifest: exact installs/adoptions/config edits; retained data; target versions; ownership/permissions; connection requirements; restart/recovery behavior; opted-out consequences; held targets. No blanket success promise. A supported adoption binding does not falsely create a kit-installed receipt for external software.
6. **Apply and verify.** Run admitted child operations with progress; verify package/configuration/runtime separately; show partial completion, held items and useful next work. Leave a durable onboarding receipt and a visible route to Manage.

The decision to use a wizard follows meeting evidence that setup scope, what to do next and unexplained warnings were confusing; guided/expert defaults were explicitly proposed. [Stuart, turns 0275–0301, 0335–0397, 1452–1486](https://notes.granola.ai/d/d513ea2e-3b15-48a9-b08e-42c78e627532) The full six-step sequence is this design recommendation, not a meeting quotation or implemented workflow.

## Four demonstration flows to build and verify

1. **First setup with existing tools:** Assess finds one natively managed host, one missing selected tool and one private overlay. Preserve the native owner; default supported selected items to Managed; show schedule OFF. Review 2 ready / 1 held, apply eligible children, verify and land on shared health/settings panels.
2. **One-machine repair:** Open concurrency finding → inspect source/override → diagnose effective value → choose inherit 4 instead of override 8 → readable owned-key diff → simulated apply phases → verify 4 → panel updates in place → inspect receipt. Another machine's value never changes.
3. **Fleet update:** Whole fleet reveals five environments: 2 ready, 3 held. Canary one ready environment; on success unlock the other ready target. On failure stop that target before it starts. Show every held reason and package/runtime activation independently. Finish with exact counts and history, not global green.
4. **Recovery instead of retry:** Open interrupted receipt → read-only audit → synthetic postimage match → explicitly record completed for that receipt → unblock only its placement/dependents. Demonstrate an inconclusive audit branch where only inspect/support guidance is offered; no generic retry button.

## Acceptance checks for the prototype

- Same panel ID, query and source revision produce identical values across all six interests; role changes only relevance/reasons/presets.
- Sidebar labels/order remain stable; selecting another interest preserves panel, machine/fleet, project, window and selected object.
- Any finding can be traced through inspect → diagnosis → exact diff → apply → verification → history without a full dashboard reload.
- UI and proposed CLI preview describe the same target and change. No operation is implied to work where the native adapter is unverified.
- Fleet roster, target manifest and eligible/held denominators remain visible. Canary failure cancels only pending/dependent operations.
- Host restart does not restart the dashboard or lose its operation history; unsupported restart paths offer instructions.
- Schedule remains disabled after editing a draft unless the user explicitly enables it in final review.
- Current-page coverage matrix has an entry for every existing dashboard destination; source populations retain their original meanings.
- Empty, stale, missing, partial, disabled and measured zero each have distinct wording and next actions.

No production, repository, UI artifact or external-system changes are part of this research deliverable.
