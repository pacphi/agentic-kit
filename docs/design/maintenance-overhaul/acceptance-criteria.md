# Maintenance overhaul acceptance criteria

- **Specification status:** Proposed
- **Governing decision:** [ADR-0048](../../adr/0048-inventory-led-maintenance-resource-management.md)

These criteria convert the approved product decisions into release gates. IDs are stable and must
appear in tests, prototype studies, and implementation receipts. Passing current Maintenance tests
does not satisfy this specification; they prove only the safety baseline that the overhaul must
preserve.

## Inventory and identity

- **MNT-INV-001:** Inventory includes every verified healthy and non-healthy resource placement in
  the selected source coverage.
- **MNT-INV-002:** One logical resource groups several placements without collapsing their scope,
  carrier, provenance, version, consumers, or actions.
- **MNT-INV-003:** The selectable/actionable row always represents one exact placement.
- **MNT-INV-004:** One physical artifact consumed by several hosts appears once with several
  bindings and is not counted as a duplicate.
- **MNT-INV-005:** System, Machine, User, Project, and Across scopes have the ADR-0048 meanings;
  Across scopes is never stored as a placement.
- **MNT-INV-006:** Skills, MCP registrations, plugins, hooks, instruction/context files, agents,
  commands/prompts, host adapters, executables, runtimes, models, provider configuration,
  credential readiness, related caches, and related storage can appear as first-class resources.
- **MNT-INV-007:** Provider configuration placements group beneath one logical provider.
- **MNT-INV-008:** Model rows include provider, version/revision, storage, consumers, and lifecycle
  guidance when those fields are verified.
- **MNT-INV-009:** Cache views show a root summary and verified child placements; aggregate action
  exists only for a verified owner-defined lifecycle object.
- **MNT-INV-010:** Equal project basenames render the shortest distinguishing breadcrumb.
- **MNT-INV-011:** Linked worktrees are separate placements grouped under one repository; nested
  repositories are separate; initialized submodules are explicit dependency edges.
- **MNT-INV-012:** WSL distributions are separate Linux environments with explicit Windows host
  relationships.

## Evidence and language

- **MNT-EVD-001:** Identity, placement, provenance, version, dependency, compatibility,
  recommendation, impact, and remedy have independent evidence assertions.
- **MNT-EVD-002:** Only verified evidence supplies primary labels or action premises.
- **MNT-EVD-003:** Provider-declared evidence names its authority; inferred evidence appears only
  in technical details.
- **MNT-EVD-004:** A verified resource without verified provenance remains visible and omits the
  provenance field.
- **MNT-EVD-005:** Inconclusive discoveries are absent from Inventory and appear only in Discovery's
  factual exclusions/coverage summary.
- **MNT-EVD-006:** User-facing resources, filters, groups, and buttons contain no `Unknown`,
  `Unsupported`, `Needs attention`, generic `Review`, or generic `Fix` label.
- **MNT-EVD-007:** A verified condition without grounded remedy or bounded decision remains neutral
  Inventory evidence and says **No action is requested** in detail.
- **MNT-EVD-008:** Internal refusal codes cannot cross the dashboard, CLI human-output, export, or
  accessibility-name boundary as disposition labels.
- **MNT-EVD-009:** Warning styling requires verified consequential impact and a bounded containment
  choice.
- **MNT-EVD-010:** Every displayed conflict classification includes what the evidence proves and
  what it does not prove.

## Guidance, versions, and dispositions

- **MNT-GUD-001:** Guidance has exactly the visible lanes Can apply here, Steps available,
  Decisions to make, Updates available, and Recovery to finish.
- **MNT-GUD-002:** A Guidance entry identifies one exact placement, verified condition, bounded
  outcome, and grounded action/procedure/decision/candidate/audit.
- **MNT-GUD-003:** Remedy-free observations never enter Guidance or navigation counts.
- **MNT-GUD-004:** Candidate source, compatibility, pin, channel, and recommendation authority are
  rendered independently.
- **MNT-GUD-005:** `Recommended` appears only with a named authority for the exact candidate.
- **MNT-GUD-006:** A candidate without verified compatibility appears only in technical evidence
  and has no update action or Updates available label.
- **MNT-GUD-007:** Stable candidates are default; prerelease/nightly candidates require existing
  exact-placement enrollment or explicit user enablement.
- **MNT-GUD-008:** Downgrade and channel change are distinct from update and have no Managed v1
  action.
- **MNT-GUD-009:** Acknowledge preserves the resource; Snooze expires; Ignore exact candidate binds
  only the same candidate identity.
- **MNT-GUD-010:** Expiry, candidate change, installed-version change, dependency change,
  source-fingerprint drift, or security-severity increase resurfaces matching Guidance.
- **MNT-GUD-011:** Every disposition is explained before confirmation and remains auditable in
  Activity.

## Discovery and scans

- **MNT-DSC-001:** Curated automatic discovery works without initial user configuration.
- **MNT-DSC-002:** Users can add an exact project or bounded collection root as distinct source
  types.
- **MNT-DSC-003:** Collection preview shows projects found, exclusions, depth, symlinks, filesystem
  boundaries, estimated work when measurable, permissions, and safety ceilings before Save.
- **MNT-DSC-004:** Users can toggle automatic sources and add exact or recursive exclusions.
- **MNT-DSC-005:** Recursive exclusions cover newly found children and preview affected projects.
- **MNT-DSC-006:** Discovery source intent is user `kit.json` state; import/export and project
  configuration are absent in v1.
- **MNT-DSC-007:** Symlinks are never traversed; a resolved target requires its own exact source.
- **MNT-DSC-008:** Network, removable, cloud-placeholder, and cross-Windows/WSL roots are excluded
  by default and require exact opt-in.
- **MNT-DSC-009:** Passive scan runs no recursive deep traversal, executable, credential validity,
  or network probe.
- **MNT-DSC-010:** Deep, executable, credential validity, and network operations each require an
  explicit appropriately labeled control.
- **MNT-DSC-011:** Reaching a work-slice budget checkpoints and resumes; it never terminates a valid
  scan.
- **MNT-DSC-012:** A stable, finite, readable source completes across work slices and application
  restarts.
- **MNT-DSC-013:** The last complete snapshot remains authoritative while a new run is scanning,
  paused, stopped, failed, or partial.
- **MNT-DSC-014:** Partial sources cannot support absence, complete totals, uniqueness, complete
  conflicts, complete reverse dependencies, reclaimable totals, or completeness-dependent actions.
- **MNT-DSC-015:** Individually verified current-run resources may render only with **Source scan
  incomplete** technical disclosure.
- **MNT-DSC-016:** Progress names entries visited, source completion, pause/resume state, and exact
  limiting reason without presenting a lower bound as a total.
- **MNT-DSC-017:** Source drift invalidates the smallest proven partition; repeated change stops
  after a bounded retry policy with a factual explanation rather than infinite restart.
- **MNT-DSC-018:** Stop scanning previews affected active resources, removes them from the active
  catalog, and preserves bounded receipts and scan history.
- **MNT-DSC-019:** No filesystem watcher or always-running scan daemon ships in v1.
- **MNT-DSC-020:** User-configurable limits cannot weaken path, symlink, special-node, permission,
  privacy, or output safety constraints.

## Actions and procedures

- **MNT-ACT-001:** Every write plan contains exactly one action and one exact placement in UI, API,
  and CLI.
- **MNT-ACT-002:** Read-only scans, queries, previews, and audits may batch but keep independent
  evidence and conclusions.
- **MNT-ACT-003:** Browser requests contain opaque IDs and confirmation only; paths, commands,
  executables, provider implementations, and policy are server-derived.
- **MNT-ACT-004:** Source drift after preview refuses before effect.
- **MNT-ACT-005:** Existing Managed providers retain their exact current kinds, scopes, verbs,
  targets, rollback, restart, and verification claims.
- **MNT-ACT-006:** No general package install or upgrade executor exists in v1.
- **MNT-ACT-007:** Guided commands are rendered from typed trusted fields and show source, OS,
  manager, shell, effect, preserved resources, verification, network, and privilege.
- **MNT-ACT-008:** Guided commands are copyable but cannot be executed by the procedure panel.
- **MNT-ACT-009:** Elevated procedures explain external steps and never solicit a password or run
  under elevation.
- **MNT-ACT-010:** Missing dependency Guidance separates repair path, relink, reinstall, and remove
  exact registration choices.
- **MNT-ACT-011:** Shared dependency mutation is Managed only with complete verified consumer
  enumeration and preview.
- **MNT-ACT-012:** Dependency traversal is cycle-safe and never recursively executes follow-on
  writes.
- **MNT-ACT-013:** Cache Apply requires exact owner lifecycle, containment, ownership, no symlink,
  complete impact, current fingerprint, no elevation, reproducibility disclosure, and verification.
- **MNT-ACT-014:** Whole-cache Apply exists only when the manager defines one lifecycle object and
  complete impact is proven; otherwise actions target children.
- **MNT-ACT-015:** Project patch preview is bounded and copyable; Apply allows unrelated dirty files
  but refuses affected-path/index/worktree/submodule/symlink drift.
- **MNT-ACT-016:** Project Apply never stashes, commits, branches, pushes, or merges.
- **MNT-ACT-017:** Procedures support bash, zsh, PowerShell, cmd.exe, and selected WSL shell with a
  per-environment remembered default.
- **MNT-ACT-018:** All named package managers meet the capability matrix and release-model-specific
  N-3 policy before their procedures appear.
- **MNT-ACT-019:** Recipe refresh verifies allowlist, publisher, signature, digest, schema, response,
  and redirects; activation of new operations or privilege requires acceptance.
- **MNT-ACT-020:** Withdrawn recipes stay in history but create no new Guidance.

## Models

- **MNT-MDL-001:** Exact Managed removal targets one provider-owned local model identity and
  digest/revision in one environment.
- **MNT-MDL-002:** Active download, generation, or provider-reported unsafe loaded use refuses
  removal.
- **MNT-MDL-003:** Every verified route/runtime/consumer is shown before removal.
- **MNT-MDL-004:** Logical size and physically reclaimable bytes are distinct; shared blobs are not
  double-counted.
- **MNT-MDL-005:** Removal uses a tested provider-native verb, requires no elevation or implicit
  environment crossing, and verifies absence.
- **MNT-MDL-006:** Irreversibility, later redownload, bandwidth, and offline consequences appear
  before confirmation.
- **MNT-MDL-007:** Model download, pull, update, migration, and channel change remain Guided in v1.

## Interruption audit and receipts

- **MNT-RCV-001:** An interrupted receipt offers **Audit interruption**, not generic Verify again.
- **MNT-RCV-002:** Audit discloses receipt, last durable phase, exact provider/version, checks,
  executable probe, and network policy before running.
- **MNT-RCV-003:** Audit verifies receipt integrity and compares current evidence only with the
  recorded preimage or verified postimage.
- **MNT-RCV-004:** Audit never retries, replays, applies, undoes, rolls back, compensates, or
  completes the resource action.
- **MNT-RCV-005:** Read-only audits may batch and stay ephemeral until each outcome is separately
  recorded.
- **MNT-RCV-006:** Conclusive outcomes enable exactly one of Record no change, Record completed, or
  Record restored for one receipt.
- **MNT-RCV-007:** Non-conclusive audit identifies completed checks and failed comparisons and
  offers only source-bound provider steps.
- **MNT-RCV-008:** When no grounded correction exists, the UI says **No corrective action is
  offered** and provides export without inventing a remedy.
- **MNT-RCV-009:** Unresolved receipts block their placement, environment, and verified dependents;
  unrelated environments remain writable.
- **MNT-RCV-010:** Receipt-integrity failure preserves a broader fail-closed write block.
- **MNT-RCV-011:** Sanitized export omits secrets, private registry URLs, raw configuration,
  rollback material, and absolute paths by default.
- **MNT-RCV-012:** Including local paths requires a fresh warned selection and never changes the
  default export policy.

## Credentials, privacy, and retention

- **MNT-PRV-001:** Credential readiness uses Not configured, Configured but not checked, Ready,
  Check failed, or Expired or renewal needed.
- **MNT-PRV-002:** Passive checks inspect mechanism presence and safe permissions only;
  authentication validity is explicit.
- **MNT-PRV-003:** The mechanism name may render; values, token metadata, account email, private
  registry URL, and raw configuration never render or export.
- **MNT-PRV-004:** Human-readable paths never enter filter URLs, global notifications, telemetry,
  or default exports.
- **MNT-PRV-005:** Exact paths are revealable and copyable only in the owner-protected inspector.
- **MNT-PRV-006:** URL state overrides owner-private remembered view state; neither is project
  configuration.
- **MNT-PRV-007:** Scan retention defaults to at most 32 summaries and 90 days per environment and
  is user-overridable within safety floors.
- **MNT-PRV-008:** Clearing scan history cannot delete unresolved, verification-required,
  undo-eligible, active-disposition, or recipe-acceptance evidence.

## UX and accessibility

- **MNT-UX-001:** Inventory opens across all resources with Guidance-admitted rows sorted first and
  restores the last valid view.
- **MNT-UX-002:** Multiselect facets show counts, removable chips, unavailable-value removal, and
  one Clear all action.
- **MNT-UX-003:** Desktop selection opens a side inspector; narrow screens open a full-screen detail
  route with **Back to N results**.
- **MNT-UX-004:** Back returns focus to the originating result where it still exists.
- **MNT-UX-005:** Search/facet announcements are debounced and announce one settled result count.
- **MNT-UX-006:** Icon meaning is duplicated by visible text and accessible name; color never acts
  alone.
- **MNT-UX-007:** Inventory and Activity use native list/table/disclosure semantics compatible with
  paging or virtualization.
- **MNT-UX-008:** At 320 CSS pixels, every essential control remains visible without horizontal
  page scrolling.
- **MNT-UX-009:** Both themes and forced-colors retain focus, selection, boundaries, conditions, and
  action distinctions.
- **MNT-UX-010:** VoiceOver/Safari and NVDA/Chrome-or-Edge complete every critical journey.
- **MNT-UX-011:** Dependency/conflict graphs have an equivalent structured list or table.
- **MNT-UX-012:** Progress, copy, apply, verification, receipt, and partial-result feedback is
  available at every stage and does not depend on transient toasts alone.

## Performance and reliability

- **MNT-PERF-001:** Saved Inventory paints without waiting for deep scan, provider command, network,
  or credential validation.
- **MNT-PERF-002:** Settled local filter response targets p95 at or below 100 ms for 5,000 placements
  and 250 ms for 50,000 placements on the agreed reference machines.
- **MNT-PERF-003:** Paging never mixes inventory generations and has deterministic stable ordering.
- **MNT-PERF-004:** Starting, pausing, resuming, and cancelling a scan leaves authenticated cheap
  endpoints responsive.
- **MNT-PERF-005:** Work-slice checkpoints are bounded and cannot grow as a retained per-file index.
- **MNT-PERF-006:** Scan benchmarks report median, range, p95, CPU, peak RSS, physical/virtual work,
  checkpoint size, and concurrency against exact source-bound baselines.
- **MNT-PERF-007:** A failed/partial new scan or provider refresh preserves the last complete
  inventory and loses all stale executable capabilities.
- **MNT-PERF-008:** Concurrent equivalent read refreshes share work; write actions remain serialized
  and individual.

## Sentinel journeys

### J1 — Missing Lightpanda dependency

Given a user-scoped Claude MCP registration whose configured `lightpanda` executable is not found,
when the user searches Inventory, then one exact registration placement appears with a verified
missing executable edge. Provenance is omitted unless independently verified. Guidance presents
repair path, relink, source-bound reinstall procedure, and remove exact registration only where
each choice is grounded. Environment values and credentials never render.

### J2 — Shared skill, not duplicate

Given one physical skill tree consumed by Claude and Codex, when Inventory groups the logical
skill, then one artifact and one placement render with two consumer bindings. The conflict view
classifies it as shared and offers no duplicate-removal action.

### J3 — Exact project patch in a dirty worktree

Given unrelated dirty files and an unchanged target configuration, when a user previews and applies
one approved project patch, then only the target changes, validation runs, no commit/stash occurs,
and a receipt is retained. If the target changes after preview, Apply refuses before effect.

### J4 — Large resumable collection scan

Given a stable collection root larger than one work slice, when scanning reaches a slice boundary,
then it checkpoints, yields responsive progress, and resumes rather than terminating. The previous
complete inventory remains authoritative until every partition and final validation complete.

### J5 — Interrupted cache cleanup

Given an integrity-valid receipt interrupted after provider dispatch, when the user runs Audit
interruption, then the exact provider inspector compares current state with recorded images without
replaying cleanup. The user records a conclusive outcome separately or receives only grounded next
steps and export.

### J6 — Provider-owned model removal

Given an exact inactive local model with complete consumers and storage evidence, when removal is
previewed and confirmed, then the provider removes only that model, verifies absence, reports
physical bytes accurately, and records an irreversible receipt. Active use or incomplete consumers
refuses Managed removal.

### J7 — WSL separation

Given a Windows host and two WSL distributions, when the same tool name appears in all three, then
Inventory shows three environment-qualified placements and explicit relationships. No procedure or
action crosses environments implicitly.

### J8 — Recipe trust change

Given an explicit registry refresh whose verified recipe adds elevation, when the diff is shown,
then the previous recipe remains active until the user accepts the new privilege requirement.
Withdrawal removes new Guidance but preserves history.

### J9 — Remedy-free verified condition

Given a verified condition with no operation, trusted procedure, bounded decision, or containment,
when Inventory renders it, then the resource remains visible, Guidance and navigation counts omit
it, warning styling is absent, and detail says No action is requested.

### J10 — Incomplete source truth

Given a scan that stops at a hard entry ceiling after finding verified resources, when results are
shown, then the exact visited work and ceiling render, found resources carry Source scan incomplete,
and no absence, global total, complete conflict, or Managed action is claimed.

## Task-based success metrics

On realistic fixtures and representative target users:

- at least 90% locate the dangling Lightpanda registration;
- median time to identify its missing dependency and exact scope is at most 90 seconds;
- at least 85% correctly distinguish shared artifacts from duplicated placements;
- at least 90% correctly distinguish a candidate from a named recommendation;
- 100% identify the exact placement targeted before confirming a write;
- zero incorrect destructive confirmations occur in the study;
- median reported confidence is at least 4 of 5; and
- at least 90% can return from detail to the same filtered result context.

Failure of a destructive-confirmation, secret-disclosure, path-targeting, receipt-replay, or
incomplete-as-complete scenario is a release blocker regardless of aggregate study score.

## Verification matrix

The release suite includes:

- domain/property tests for identity, evidence, dependency cycles, dispositions, and admission;
- schema/golden tests for privacy-projected Inventory, Guidance, Discovery, Activity, URLs, and
  exports;
- provider conformance tests per exact capability tuple;
- failure injection at every transaction and scan checkpoint;
- clean-machine and migration tests for current snapshots, receipts, and routes;
- package-manager fixtures across the release-model-specific N-3 ranges;
- macOS, Linux, Windows, and WSL integration coverage;
- 5,000- and 50,000-placement load tests;
- browser tests for desktop and 320-pixel layouts, keyboard, focus restoration, both themes, and
  forced colors;
- automated accessibility scanning plus VoiceOver/Safari and NVDA/Chrome-or-Edge task signoff;
- security tests for origin/session controls, schema bounds, traversal, symlinks, executable
  identity, environment minimization, redaction, signatures, redirects, replay, and capabilities;
- source-bound scan and filter benchmarks; and
- ADR claim-to-source verification before status promotion.

## Definition of done

ADR-0048 can become Implemented only when:

1. all requirements applicable to the released slices pass;
2. all sentinel journeys pass without waived destructive, privacy, or evidence failures;
3. current provider safety and regression suites remain green;
4. cross-platform capability gaps omit claims and actions rather than fabricating parity;
5. Catalog routes are retired or explicitly documented as compatibility routes;
6. ADR-0044 and every amended ADR accurately describe its remaining authority;
7. current DDD, CLI/API schemas, and help match the code; and
8. exact source-state test, benchmark, security, accessibility, and decision receipts are retained.
