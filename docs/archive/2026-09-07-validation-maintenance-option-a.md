> Archived snapshot, 2026-09-08. Original status and evidence below are historical.
> Current guidance: [Maintenance](../MAINTENANCE.md), [acceptance and open gates](../MAINTENANCE-ACCEPTANCE.md),
> and [ADR-0048](../adr/0048-inventory-led-maintenance-resource-management.md).

# Maintenance Option A validation — 2026-09-07

Historical evidence for Option A. **B — Focus browser** was approved on 2026-09-08 and
supersedes the expanded inventory-list and Project type presentation described below. Retained
measurement and exact-action checks remain relevant, but these totals do not verify Focus.
Its integration, browser/API, usability, and cross-platform gates must be recorded separately.
See the [current experience specification](2026-09-04-design-maintenance-overhaul-experience-specification.md) and
[approved prototype reference](2026-09-08-design-maintenance-focus-mockups.md).

The user approved Option A: progressive filters, compact contextual inventory cards,
project/resource hierarchy, a conditional side inspector, and one local measurement toolbar.
The existing preview and confirmation flow still owns placement writes.

## Delivered behavior

- Hosts are Claude, Codex, and OpenCode. External Adapters are separate; Hermes is listed
  with an observed-resource count, which does not imply configuration or runtime health.
- Projects retain Git repositories and non-Git working folders. Measured Git, Folder,
  Worktree, and Not checked designations use icons plus text in facets and project headings.
  The Project type filter uses those same measurements. Old or unreadable evidence stays unknown.
- Implicit catalog candidates exclude managed host directories. Automatic host-source
  discoveries do not promote installed plugin repositories into Projects; explicit project
  discovery retains its authority. Classification enrichment preserves existing placement IDs.
- The skip link is clipped until keyboard focus. Results fill the available width until
  a selection opens the inspector; closing restores the results width.
- Re-measure shows elapsed time and phase through filesystem measurement, provider probes,
  and inventory publication. Coverage gaps remain visible rather than reporting false completion.
- Cache measurements retain their paths in the owner-private locator store. Reveal exact path
  displays the measured root; failed reveals provide feedback and a retry instruction.

## Evidence

- 718 Maintenance regression tests passed, none skipped.
- 14 footprint-projects and 72 footprint-collectors tests passed.
- TypeScript, focused ESLint, and build checks passed; the build verifies syntax, CLI loading,
  and package dry-run contents. Earlier footprint lint reported existing complexity warnings.
- In the existing Brave tab on port 7431, selection reduced results from 832px to 512px with
  a 320px inspector; closing restored 832px. Idle skip-link clipping was verified.
- A live re-measure advanced from 0s to 43s and 1m44s with project/ranking phases, then
  finished and re-enabled the controls. It reported coverage gaps instead of remaining busy.
- After the final restart and Refresh evidence, version-directory/plugin entries disappeared
  from Projects while real repositories and a measured worktree remained.
- Clicking Reveal exact path on the reported superseded-KB cache displayed its measured
  directory and Copy exact path in Brave.
- The standalone browser harness expectations were updated but the full harness was not run.

The AQE repository-wide gate returned score 20 and did not pass: reported coverage 19.41%,
complexity 63.19, maintainability 35.27, security 85, across 363 analyzed files. It returned a
cached repository assessment, not a change-scoped score. No release or ADR status promotion
is claimed; ADR-0048 retains its human and cross-platform evaluation gates.

The user authorized committing and pushing this pass on the current feature branch.

## Procedure follow-up — 2026-09-08

Open procedure from Inventory previously rendered under the hidden Guidance tab. A shared
native dialog now shows loading, the procedure, or a visible failure; closing restores focus,
and delayed responses cannot reopen it. Escape does not close the underlying inspector.

Review also found unbound removal/update templates, including a Claude command offered for
a Codex placement. Admission now withholds targetless or unsplit multiword-verb templates;
the procedure endpoint rechecks current admission even for saved guidance. Complete named
installation recipes and verified native actions remain available.

723 Maintenance tests passed, with TypeScript, focused lint, and build checks passing. In
Brave, the saved invalid recipe displayed a visible failure dialog, and Close procedure
restored the trigger while retaining the inspector. Refresh evidence removes obsolete guidance.
Full browser-harness and cross-platform validation remain outstanding.

## Version, grouping, and location follow-up — 2026-09-08

734 Maintenance tests pass, including 205-placement family pagination, client continuation
merging, release ordering, parent-plugin provenance, host/scope isolation, candidate visibility
without apply authority, catalog-only model exclusion, and private storage locators. TypeScript
and build checks pass; focused lint has no errors and a model-projection complexity warning.

Live authenticated API checks on port 7431 after Refresh evidence returned:

- One agentic-qe MCP family: 21 known installations, Claude/Codex/OpenCode consumers, 7 matching
  the Dependencies view.
- Models/runtimes: 21 relevant entries, replacing the previous 458-entry catalog-heavy view.
- Hugging Face cache: revealAvailable true and successful owner-only reveal of its measured root.
- Plugin releases including autopilot 0.12.0, with explicit unknown update-check states.
- Provider scan complete with partial coverage; the chained inventory refresh succeeded.

Brave disconnected before final visual revalidation. These last checks exercise the real API,
not a claim of final browser validation. MCP package versions, native OpenCode/Hermes candidate
probes, and cross-platform browser verification remain coverage limitations. AQE's repository
assessment remains score 20 (coverage 19.41%, complexity 62.95, maintainability 35.37, security 85);
this pass does not claim that gate passed or promote ADR-0048 to Implemented.
