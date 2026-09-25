# ADR-0057 — Dashboard taxonomy: question-based domains, role lenses, and one metric catalogue

- **Status:** Proposed — nothing here is implemented
- **Date:** 2026-09-21
- **Related:** [ADR-0056](0056-delivery-outcome-metrics.md),
  [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0014](0014-dashboard-auth-and-remediation.md),
  [ADR-0032](0032-model-lifecycle-intelligence.md),
  [ADR-0036](0036-dashboard-client-modularization-and-shared-loopback-server.md),
  [ADR-0038](0038-consistent-cross-host-session-metrics.md),
  [ADR-0039](0039-prompts-intelligence.md),
  [ADR-0041](0041-host-neutral-hook-configuration-assurance.md),
  [ADR-0042](0042-capability-aware-context-budget-intelligence.md),
  [ADR-0048](0048-inventory-led-maintenance-resource-management.md),
  [ADR-0054](0054-fleet-evidence-export.md)

## Context

The dashboard has five primary areas: About, Overview, Usage, Observability and System. Usage has
eight secondary views: Score, Limits, Findings, Prompts, Context, Hooks, Models and Sessions. They
answer different questions for different readers, but they share one name and one row:

- **Spend** questions: the API-equivalent cost of a window, by host and model, and how much of it
  is priced.
- **Practice** questions: rhythm, autonomy, delegation, prompts and findings.
- **Capacity** questions: provider limits and context windows.
- **Assurance** questions: hook configuration and permission posture.
- **Estate** questions: which models exist and which projects the work lands in.

The Scorecard alone carries five hero KPIs, a unit-economics row, and a dozen panels: cost per day,
by host, token composition, rhythm, how you run, when you work, models in play, tool mix, model mix
over time, reliability, projects, and what you worked on
(`docs/USAGE-SCORECARD-METRICS.md`). Its own documentation describes it as one argument read top to
bottom. That suits one reader. A finance reader wants three panels of it, and a manager wants none
of it.

The surface is also inconsistent about its own name. The tab button reads "Score" (`page.mjs`), the
view key and hash are `score` (`#usage/score`), the heading is "Usage scorecard", and the docs say
"Scorecard". The word "persona" is already taken: Prompts uses it for a prompt that opens by
assigning a role (`PERSONA_OPENER_RE`), so it cannot also name the readers.

Two views are filed where they were built rather than where they are used. `page.mjs` places the
Model lifecycle summary link on the Overview summary, pointing into `#usage/models`. Hook assurance
is a configuration and safety question but lives beside spend.

ADR-0056 adds outcome metrics with their own data source, consent lifecycle and readers. Adding a
sixth strip to the Scorecard would make the overload worse, and adding it before the question is
settled would fix the layout in the wrong shape.

Who reads what, in the terms their own questions take:

| Role | Core question |
| --- | --- |
| Manager | Is AI assistance producing output for what it costs? |
| Developer | How am I working, what slows me, how close am I to a limit? |
| Finance | What did it cost, where is it heading, and how sure are we? |
| Security and compliance | What did agents do, under what controls, and what leaves the machine? |
| Platform operator | Are machines healthy, consistent and reporting? |
| System architect | What stack and models is the work on, and does the tooling fit? |

Constraints that shape the answer:

- The dashboard serves one local user behind one token (ADR-0014). Roles here are reading
  preferences. Nothing in this ADR is authorization.
- The repository already keeps pure-data, versioned registries (`stack-registry.mjs`,
  `about-directory.mjs`) so a reviewer can read vocabulary changes as a diff.
- The repository already retires a destination without breaking its link: `#system/catalog`
  redirects to Maintenance › Inventory (ADR-0048).
- Deep links, keyboard behavior and the tab-list structure are documented contracts
  (`docs/DASHBOARD.md`).

## Decision

### 1. Organize by question, not by role

Navigation is grouped by the question a metric answers, so each metric has one home. Roles get
**lenses** over that structure (section 4). They do not get their own copies of the data. A role
navigation would repeat every metric under each role that cares about it, would make the same
figure appear in two places with two headings, would break deep links every time a role's needs
changed, and would suggest access control that does not exist.

### 2. Taxonomy: eight domains and two axes

| Domain | Question | Home |
| --- | --- | --- |
| Consumption | What was used: sessions, tokens, cache, engaged time | Usage › Summary |
| Spend | What it cost: API-equivalent estimate and source-reported cost | Usage › Spend |
| Capacity | How near a ceiling: provider windows and context windows | Usage › Limits, Context |
| Practice | How work is done: autonomy, delegation, prompts, tool use | Usage › Practice, Prompts, Findings |
| Delivery | What shipped: commits, PRs, lines, releases, CI | Delivery |
| Economics | Effort next to output | Delivery › Economics |
| Assurance | What was allowed and evidenced: hooks, permissions, egress | Usage › Hooks (a later decision may give it an area) |
| Estate | What exists: hosts, models, projects, footprint | Usage › Models, System |

Every metric also carries two labels that already exist informally:

- **Evidence grade:** measured, reported, estimated, derived, or unknown (ADR-0009's graded
  evidence, extended to git and GitHub facts).
- **Scope:** session, project, machine, or fleet.

A metric has exactly one home domain. Another view may show it as a reference tile that links to
the home. It may not redefine or recompute it.

### 3. Navigation changes

**Delivery becomes a primary area** with Summary, Projects, Economics and Setup (ADR-0056). The
primary row goes from five areas to six.

**The Scorecard is renamed Summary and decomposed into three views.** The mapping is by the panel
list in the metrics reference. Arithmetic does not change, and a panel moves as a unit.

| Panel today | New home | Reader it serves |
| --- | --- | --- |
| Hero KPIs: Sessions, Tokens, Engaged time, Cache read | Summary | Everyone |
| Hero KPI: API-equivalent | Summary, with detail in Spend | Everyone, Finance |
| Cadence and unit economics row | Summary | Manager, Developer |
| Cost per day | Spend | Finance |
| By host | Spend | Finance, Architect |
| Models in play, model mix over time | Spend | Finance, Architect |
| Token composition | Spend | Finance |
| Projects | Spend (cost by project) | Finance, Manager |
| Your rhythm, When you work, Reliability | Practice | Developer |
| How you run (permission posture, delegation) | Practice | Developer, Security |
| Tool mix | Practice | Developer |
| What you worked on | Practice | Developer, Manager |

**Unchanged in this decision:** Limits, Context, Prompts, Findings, Sessions, Hooks and Models
stay in Usage with their current keys. Hooks and Models are candidates to move (Hooks to an
Assurance area, Models to Estate). Moving them touches ADR-0032, ADR-0041 and their deep links, so
a later decision takes them once the lenses show how often they are opened from the wrong place.

**Grouped secondary row.** With ten Usage views the row needs structure. Visual group labels sit
above each cluster (Use and spend; Practice; Capacity; Assure and estate). The row stays a single
ARIA tab list with one selected tab, and the labels are presentational, so the documented
Left, Right, Home and End behavior is unchanged.

### 4. Role lenses

A **lens** is a reading preference with three parts:

- **A landing view.** Choosing a lens navigates there. Finance lands on Usage › Spend.
- **A brief.** A row of five reference tiles above the view, each linking to its home.
- **A report preset.** The offline command or export that role most often needs (section 7).

Lenses:

| Lens | Lands on | Brief (reference tiles) |
| --- | --- | --- |
| Everyone (default) | Usage › Summary | none |
| Manager | Delivery › Summary | PRs merged, cost per merged PR, assisted share, rework, active days |
| Developer | Usage › Practice | autonomy, cache read, context pressure, limit headroom, findings |
| Finance | Usage › Spend | API-equivalent, priced coverage, cost per day, cost per merged PR, fallback-priced share |
| Security and compliance | Usage › Hooks | hook assurance, bypass posture, aborts, network features on, telemetry export scope |
| Platform operator | Overview › Summary | version drift, host health, hook assurance, export freshness, Delivery setup state |
| System architect | System › Projects | top language, busiest module, models in play, providers, lifecycle notices |

A lens never hides a view, changes a figure, or grants anything. The selector sits in the header as
"View as". Product copy says "role" and never "persona". The choice is a per-viewer preference,
like the theme and poll settings, so it is stored in the browser and never in `kit.json` or a
snapshot.

### 5. One metric catalogue

Add a versioned, pure-data catalogue of metric descriptors (proposed
`src/lib/dashboard/metric-catalogue.mjs`, no I/O, following `stack-registry.mjs`). Each descriptor
records:

- id, label, unit, and the doc section that defines it;
- home domain and view, and the roles for which it is primary or secondary;
- evidence grade, scope, and window semantics (whole sessions by end time for Usage, UTC days for
  Delivery);
- the telemetry field and aggregation rule when it is exported.

The catalogue describes metrics. It does not compute them, and no arithmetic moves. Its consumers,
in order of adoption: navigation placement and lens briefs; the headings of CLI text output;
documentation tables; tests that fail when a rendered tile has no descriptor or a metric has two
homes; and later `ak telemetry metrics`. It is the single place a reviewer sees a new metric's
domain, evidence and readers.

### 6. Vocabulary

- **Summary** replaces "Score" and "Scorecard" in the tab, heading and docs. "Score" stays as a
  historical alias for the view key and command. The three inconsistent names collapse to one.
- **Role** is the word for the reader. "Persona" keeps its Prompts meaning.
- **Estimate** describes API-equivalent cost wherever it appears. It is never billing (ADR-0009).
- Evidence grade and scope use the closed vocabularies in section 2 everywhere they are shown.

### 7. Reports and the security lens (direction)

Role report presets compose commands that already exist or are proposed elsewhere: a spend
export, the recap card (ADR-0056), an assurance summary, and fleet status from
`ak telemetry aggregate`. Each is offline and adds no network flow. Command names are provisional.

The security lens needs one thing that does not exist: a read-only **"what leaves this machine"**
section, initially in the Hooks view, listing each feature that can send data off the machine,
whether it is on, and what would leave. Candidate entries, each to be verified against source when
built: the connected host health check (its disclosure already says it sends a short request), the
OpenRouter analytics refresh (needs a management key), version-drift lookups against npm and
GitHub releases (TTL-cached), the Delivery GitHub tier (ADR-0056), and the maintainer admin page
(ADR-0007). Telemetry export appears as a file-only entry.

### 8. Compatibility and ripple

Measured against the repository on 2026-09-21:

| Area | What it touches | How it is contained |
| --- | --- | --- |
| View key `score` and DOM ids | Six source files (`bootstrap.mjs`, `boot.mjs`, `poll.mjs`, `usage.mjs`, `usage-orchestrators.mjs`, `page.mjs`) and two UI tests | Rename to `summary`, add `spend` and `practice`. `#usage/score` redirects, as `#system/catalog` does |
| CLI | `ak usage score` is mentioned in 15 non-archive files: 4 source, 2 tests, 9 docs | `score` stays as an alias with unchanged output. `summary`, `spend` and `practice` print per-view slices. `--json` field names do not change |
| Documentation | "Scorecard" appears on 170 lines under `docs/`, mostly ADRs and archives. `USAGE-SCORECARD-METRICS.md` has machine-checked citations | Keep the file name and its citation checks. Retitle it and map its sections to views. Docs alignment is a completion gate |
| ADRs | ADR-0009 names the scorecard; many others mention it in passing | A pointer note on ADR-0009. Other ADRs are history and stay as written |
| Derived index | None. No `SCHEMA_VERSION` change | Panels move, data does not |
| Telemetry | None from this ADR. Delivery's schema v2 is ADR-0056 | The catalogue may feed `ak telemetry metrics` later without touching the wire contract |

Bookmarks of `#usage/score` and scripts that call `ak usage score` keep working. That commitment
is the main constraint on how the rename is staged.

### 9. Order of work

1. Catalogue descriptors for the existing Scorecard metrics, plus the rename to Summary with the
   redirect and alias. No panel moves and no behavior changes, so it is safe to ship alone.
2. Move panels into Spend and Practice, with tests that pin the numbers before and after.
3. Delivery area (ADR-0056 phases 1 and 2), landing in the final navigation.
4. Lenses and the group labels on the secondary row.
5. Telemetry schema v2 (ADR-0056 phase 3).
6. Later decisions: Hooks and Models moves, an Assurance area, the egress section, report presets.

The rename and split come before Delivery so that Delivery lands in the shape it keeps. Lenses come
after there are views to land on.

## Alternatives

1. **Role-first navigation** (a tab per role). Rejected in section 1.
2. **Keep the Scorecard and add Delivery as another Usage view.** Rejected: it deepens the
   overload, and Delivery's consent and setup lifecycle does not belong beside transcript spend.
3. **Rename only.** Fixes the inconsistent name and leaves the mixed audience. A finance reader
   still scrolls past practice panels to reach spend.
4. **Give Spend its own primary area.** Would serve finance well, but it separates cost from
   consumption, which are read together far more often than not. Reconsider if Spend grows
   budget or forecast features.
5. **An "Insights" or "Analytics" bucket for the new material.** Names a genre and not a question,
   which is how the current Usage area became a grab bag.
6. **Store the lens in `kit.json`.** Turns a reading preference into machine configuration and
   invites the assumption that it gates something.

## Consequences

- Each reader reaches their questions in one or two clicks, and a metric has one home.
- Documentation churn is the largest cost: a retitled reference, a remapped section list, a
  navigation table, and one pointer note on ADR-0009. It is bounded by keeping file names and
  citation checks.
- Usage has ten secondary views until Hooks and Models move. The group labels make that readable
  and are not a fix. The later moves bring it to eight.
- The metric catalogue is new maintenance surface. It earns its keep only if tests enforce it, so
  the enforcement tests ship with it.
- A lens can be misread as a permission. The brief footer says it is not, and the ADR forbids the
  lens from hiding anything.
- Roles that are not on the list, such as an auditor or an executive sponsor, have no lens.
  Adding one is a catalogue and lens change, not a navigation change.

## Validation intent

Not yet written. The tests this decision commits to:

- **Number pinning:** the same fixture produces identical figures before and after each panel
  moves, in the dashboard and in `ak usage score --json`.
- **Compatibility:** `#usage/score` redirects to Summary; `ak usage score` output is unchanged;
  keyboard navigation across the grouped row still behaves as one tab list.
- **Catalogue:** every rendered tile has a descriptor, every metric has one home, evidence and
  scope use the closed vocabularies, and lens brief tiles resolve to descriptors.
- **Lens:** choosing a lens lands on its view, shows its brief, hides nothing, and writes nothing
  outside the browser.
- **Documentation gate:** `DASHBOARD.md`, `USAGE-SCORECARD-METRICS.md` with its citation test,
  `TELEMETRY.md` where it lists metrics, the ADR index, and the pointer on ADR-0009, in the same
  change as the code.

An interactive mockup accompanied review of this proposal. It uses synthetic data and is not
implementation evidence.

## Open questions

- Should Prompts and Findings fold into Practice, or stay separate because of Prompts' privacy
  handling?
- Whether the lens preference should follow the user across browsers, which would need a
  server-side store and a different privacy story.
- Whether Finance warrants budget or forecast features, which would justify a Spend area.
- When to decide the Hooks and Models moves, and whether Assurance and Estate become areas or
  stay as Usage groups.
- Whether the egress section belongs in the Hooks view or in About.
- CLI names for the per-view slices and for the role report presets.
