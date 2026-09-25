# Research and concept verification

Date: September 25, 2026. This note concerns the report and demonstration, not a v5 implementation.

## Research

- Retrieved both full Granola transcripts and meeting metadata. A second transcript pass produced 53 requirement/investigation candidates with meeting links and ordinal locators.
- Inspected current repository commit `847486c61689f8499ada08f5b5684ecf26b22db8` and taxonomy branch commit `7b9093ef3e6d4c0efb9453ee5e48532a2064e612` without switching or editing the checkout.
- Independently researched implementation, host interoperability and taxonomy/economics. Implementation and host researchers checked the resulting report for unsupported claims.
- Corrected the report to state the current one-action maintenance-plan limit, distinguish source-reported cost from verified charges, cite issue #237 for its reported incidents, and qualify duplicate-hook risk as an inference.
- The implementation appendix records read-only reproductions of the invalid Blocks command, inconsistent guidance context and absolute-path transport recognition.
- Repository sources use immutable revision links; upstream documentation is date-qualified. Current upstream documentation is not a runtime certification.

## Initial operations concept (v1)

The initial operations concept is a local simulation containing eight synthetic sessions, four projects and six host names. No action runs a CLI command, modifies a host, schedules a real job, sends data or enrolls a machine.

- JavaScript syntax parsed successfully.
- All seven destinations—Today, Work, Sessions, Stack, Updates, Fleet, Value—rendered through the browser.
- At a 1,024-pixel browser viewport, all seven root surfaces measured 990 pixels in both client and scroll width. At a 320-pixel viewport, all seven measured 286 pixels in both; there was no root horizontal overflow. Dense fleet table content uses a local scroll container. The mobile Today screen was visually inspected.
- Acme OR Platform selected six unique sessions: 2.96M tokens, $28.25 API-equivalent estimate, $5.46 source-reported cost. Acme AND Platform selected two: 650K tokens, $6.05 estimate, $2.36 source-reported cost.
- Adding Release to the Agentic Kit project propagated into the selection. Release then selected four unique sessions: 2.31M tokens, $22.20 estimate and $3.10 source-reported cost.
- AgentDB recall limit 12 appeared with the correct component-specific field in the configuration preview and proposed CLI. Applying produced a simulation-only result message.
- A daily 02:00 America/Los_Angeles schedule with “Apply reviewed updates while idle” showed the same intent in its preview and proposed CLI. Saving produced a simulation-only result message.
- The browser preview used an isolated folder containing only synthetic mockup HTML. Private raw transcripts were not served.

## Limits

The AQE accessibility tool returned `passed: false`, score 0, and no violations because its implementation required an unavailable browser audit environment. That output is **not** an accessibility score for the concept. Direct browser behavior/layout checks supplement it; no automated WCAG certification is claimed.

These are focused concept checks, not exhaustive tests. No production application test suite, live six-host conformance suite, real update/scheduler, fleet deployment, bill reconciliation, human usability study or cross-platform release gate was run. The prototype does not implement full native setting schemas, persistent configuration, authorization, a search launcher, all error states, or production recovery. Simulated status badges do not certify a host adapter.

The report recommends future acceptance criteria and performance budgets. They are not measured v5 results. No numerical repository/product quality score is claimed.

## Reference interaction review for the role revision

The three private Claude artifacts were inspected through the signed-in Firefox session. Delivery Scorecard: Connected and Local only states, 14-day to 7-day window change, and ledger-core repository/module drilldown. Scorecard Additions: annotated metric panels and evidence/host-coverage descriptions. Dashboard Lenses: Manager, Developer, Finance, Security & compliance, Platform operator and System architect selections, Developer → Sessions navigation, and the taxonomy Map.

The source review distinguished substantive analytical views from placeholder pages. The role-experience addendum records those observations and labels the expanded v5 behavior as proposed. The original concept is retained for historical comparison. Its no-known-cost and unknown-versus-subscription labeling weaknesses are called out in the role revision; the replacement is required to preserve missingness correctly.

## Revised role workbench (v2)

- The new role-workbench.html fragment provides Builder, Lead, Finance, Operator, Assurance and Architect compositions in Today, Work, Sessions, Stack, Updates, Fleet and Value. Its single fixture contains 56 sessions over 28 days with explicit sample work-item IDs and acceptance receipts.
- Browser inspection rendered all 42 role/view combinations at a 1,024-pixel viewport without root horizontal overflow or console errors. After the focused selected-session/settings refinements, all 42 rendered at a 320-pixel viewport without root horizontal overflow or console errors.
- The Finance session view was visually inspected. Changing Builder → Finance while inspecting s0 preserved Sessions, Checkout, the 14-day window and the selected session. The Finance detail displayed source-reported cost as Unknown and the sample API-equivalent estimate as $0.17; aggregate source cost for that scoped population also remained Unknown, with 0% cost-evidence coverage.
- The metric sparkline showed “No daily evidence” for that all-unknown source-cost population, rather than drawing a measured zero series.
- Switching the settings form to AgentDB changed the control to Recall result limit. Entering 12 produced an AgentDB Project override preview with recallLimit: 5 → 12.
- Role navigation prioritizes four areas with remaining destinations under All areas. Scope notes explicitly distinguish current inventory snapshots from period/label-filtered activity.
- Label chips in this revision filter sample assignments. Simulated reviews are presentation demonstrations; they do not implement production persistence, policy enforcement or real update scheduling. No new accessibility certification is claimed.

## Shared management workbench (latest revision)

The management-workbench.html concept supersedes the role-specific navigation experiment. The preceding v1/v2 verification notes remain historical evidence for those artifacts, not assertions about the current implementation.

Source inventory checks: 101 unique existing panel/capability IDs; 330 unique settings catalogue IDs, with 178 curated entries and 152 advanced CLI inputs. Browser inspection showed all 101 map rows, four matching context panels after filtering, 178 curated catalogue rows, and 330 after enabling advanced input documentation. Source identities and exact canonical locations are available in panels.json/panel-map.md. The prototype exposes documentation for all mapped groups; selected panels have representative sample previews.

Focused browser checks completed:

- All five stable navigation areas, six additional Manage tabs, and the panel map rendered at a 320-pixel viewport with 286-pixel client/scroll width and no root horizontal overflow. The desktop Manage view and mobile wizard were visually inspected. Dense tables retain local horizontal scrolling.
- Operator and Assurance attention reordered the same findings: Assurance brought configured-but-unproven governance first. Navigation stayed fixed.
- A Ruflo learning-profile change was reviewed and applied while navigating elsewhere. The progress/receipt remained visible and affected read models updated without a page reload.
- A Studio change to research left Lab at balanced. Returning to Studio showed research; selecting the fleet showed mixed values across machines.
- A fleet repair preview identified Studio/Lab eligible, Build runner busy, and Travel laptop unaffected. The final result reported 2 verified, 1 deferred and 1 not affected. An unrelated governance evidence gap remained unresolved.
- Onboarding assessed before continuing, let the user deselect OpenCode and AQE, displayed specific consequences in review, preserved package owners, applied eligible owned repairs, and showed the resulting managed/observed inventory. Scheduling stayed off.
- Exiting and resuming the wizard retained the tool-selection step and an unchecked AQE choice in the current simulation session.
- A schedule draft selected Codex only, daily 02:00 UTC, check-and-notify. The review showed those exact values; applying produced a separate simulated schedule receipt. A draft toggle alone does not change the saved scheduling policy.
- JavaScript syntax parsed successfully. The fragment contains no fetch, XMLHttpRequest or WebSocket calls. Browser console inspection showed no application errors during the tested flows.

The source catalogue is real research; machine inventory, update candidates, health observations, plans and results are synthetic. No installation, package update, native setting change, scheduled job, paid probe, enrollment or remote write was performed. Session-only wizard resume and browser navigation continuity are demonstrated; durable restart recovery, real native schema validation and controller self-update/reconnect remain product work. No full native parity, runtime enforcement, cross-platform release, performance SLA or WCAG certification is claimed.

## Settings organization revision · September 25

- Mapped all 330 unique source IDs to exactly one purpose category, with independent entry-kind, record and related-component metadata in settings-taxonomy.json. The 101-panel map is retained.
- Checked eight purpose categories on the landing screen. Grouped 36 routing members into 12 activity rows and 20 repeated-record members into six collection editors. Scheduling exposes one shared policy entry.
- Browser-verified a Review host change: Studio-only draft, attempted scope change rejected with an explanation, exact before/after preview, simulated apply and a one-machine verified receipt.
- Browser-verified adding a provider binding with ID, host, provider and endpoint; staging produced one atomic integrations.bindings collection change and a simulated receipt. No provider was contacted.
- Search for max-concurrent opened a clearly labeled operation-only contract; search for encryption retained an Unavailable result with its canonical category.
- At a 320px viewport, the landing screen and all eight category views had root clientWidth = scrollWidth = 286px. The discovery collection editor also fit that width. Inspected desktop and narrow-screen screenshots.
- A single schedule-policy button was present in the Updates category. Browser console had no captured errors at the end of that inspection.
- JavaScript syntax checked after the final edits. Controls remain synthetic, and native adapter validation, real writes, full accessibility certification and six-host runtime support are not claimed.
- The browser automation occasionally raced iframe layout after navigation; fresh accessibility snapshots and keyboard activation resolved those interactions. Text/model roundtrip was not separately validated; the route roundtrip used the host selector.
- Codex restore/release opens an explanatory lifecycle contract; it does not simulate a native restore. Preferred-shell maps retain structured environment keys. Invocation forms outside existing representative workflows remain design work.
