# Maintenance experience specification

- **Design status:** Proposed
- **Governing decision:** [ADR-0048](../../adr/0048-inventory-led-maintenance-resource-management.md)

The experience is an administrative workspace, not an alert feed. It leads with outcomes, keeps
the complete verified footprint close at hand, and exposes technical evidence progressively.

## Navigation and URLs

Maintenance replaces the separate Catalog destination and exposes four third-level destinations:

| Destination | User question |
|---|---|
| Inventory | What exists, where is it, where did it come from, and who uses it? |
| Guidance | What can I accomplish here, and what decision is required from me? |
| Discovery | Where does Agentic Kit look, what did it cover, and what was excluded? |
| Activity | What changed, what is still running, and what must be reconciled? |

The URL stores destination, curated view, opaque environment/resource/placement IDs, sort, and
facet values. It never stores a human-readable local path, credential mechanism, account identity,
or private registry. A valid URL state overrides remembered preferences. Otherwise Maintenance
restores the user's last destination, scope, view, sort, and facets from owner-private state.

### Desktop workspace wireframe

```text
┌ Maintenance ─────────────────────────────────────────────────────────────────┐
│ Inventory | Guidance | Discovery | Activity                                  │
│ System | Machine | User | Projects | Across scopes             Search…       │
├───────────────┬──────────────────────────────────┬────────────────────────────┤
│ Curated views │ 128 resources                    │ Resource inspector         │
│ □ Updates     │ ┌ Logical resource ────────────┐ │ What is this?              │
│ □ Conflicts   │ │ Placement · Scope · Location │ │ Where is it/from?          │
│               │ │ Version · Source · Consumers │ │ Version and consumers      │
│ Facets        │ │ Outcome or Open details      │ │ Dependencies/conflicts     │
│ Type (12)     │ └──────────────────────────────┘ │ What can I accomplish?     │
│ Host (4)      │                                  │ Evidence and activity      │
│ Source (8)    │                                  │                            │
│ [Clear all]   │                                  │                            │
└───────────────┴──────────────────────────────────┴────────────────────────────┘
```

### Narrow-screen flow

```text
Maintenance / Inventory
[Search] [Filters (3)]
[Scope: Across scopes]

Logical resource
Placement · Scope · Location
Version · Guidance outcome

        select placement
               ↓
┌ Back to 128 results ──────────┐
│ Resource detail               │
│ identity and location         │
│ provenance and version        │
│ consumers and dependencies    │
│ outcome / procedure / action  │
│ evidence and activity         │
└───────────────────────────────┘
```

## Inventory

Inventory opens with all verified resources across all scopes. Rows associated with Guidance are
sorted first without hiding healthy or inventory-only resources. The initial group order is:

1. Recovery to finish
2. Can apply here
3. Steps available
4. Decisions to make
5. Updates available
6. Inventory evidence only
7. Healthy resources

This is a sort, not a severity ladder. Warning color is not applied to groups 2–6 by default.

### Scope lens

The persistent first facet is **System**, **Machine**, **User**, **Projects**, or **Across scopes**.
Selecting a scope changes the secondary facets to values that actually exist in the result set.
Unavailable facet values disappear.

Scope labels always include text. Suggested supporting icons are shield for System, computer for
Machine, person for User, and folder/repository for Projects. Icons do not encode provenance.

### Curated views

V1 ships these views over one URL-addressable query model:

- All resources
- Can apply here
- Steps available
- Decisions to make
- Updates available
- Dependencies
- Conflicts and overlaps
- Duplicated placements
- Disabled resources
- Credentials and providers
- Models and runtimes
- Storage and caches
- Recently changed
- Inventory evidence only

Saved named views are deferred. Adding them later must persist the existing query envelope rather
than introduce a second filter model.

### Facets

Facets are multiselect, show counts, render removable chips, and provide one **Clear all** action.
They include only applicable values from:

- Administrative scope and environment
- Project/repository
- Resource type
- Host/adapter consumer
- Placement carrier
- Verified provenance source
- Package manager
- Installed/effective version state
- Guidance availability
- Dependency role
- Conflict classification
- Credential readiness
- Channel
- Evidence fields available
- Recently changed

Search and facets compose. Clearing a scope-dependent facet announces one debounced result update,
not one live-region message per chip.

### Logical group and placement row

A group header shows logical resource name, resource type, placement count, consumer count, and the
most useful bounded outcome. It never offers a write action.

Each selectable row is one exact placement and shows:

1. placement display name;
2. scope icon and text;
3. short location breadcrumb;
4. installed/effective version when verified;
5. source carrier icon and text when verified;
6. consumer-host labels;
7. one Guidance lane label when admitted; and
8. the contextually relevant row action or **Open details**.

Placement and source use independent markers. Example:

```text
Lightpanda                         MCP registration
User · Claude                     Claude configuration
Command dependency: lightpanda    Steps available
```

When project basenames collide, the breadcrumb adds the shortest distinguishing parent segments,
for example `Development › ai › agentic-kit`. User-defined display names are deferred.

### Resource inspector

Desktop opens a side inspector without losing the selected result or filter context. Narrow screens
open a full-screen detail route headed **Back to N results**. The inspector answers questions in
this order:

1. **What is this?** Logical identity, kind, exact placement, environment, condition.
2. **Where is it?** Scope, breadcrumb, carrier, reveal/copy exact path.
3. **Where did it come from?** Verified provenance chain or an omitted field.
4. **What version is here?** Installed, effective, pin, channel, revision/digest.
5. **Who uses it?** Hosts, adapters, projects, routes, runtimes, reverse dependencies.
6. **What changed or conflicts?** Evidence-backed comparison and taxonomy explanation.
7. **What can I accomplish?** Exact action, procedure, decision, update, or no requested action.
8. **What proves this?** Structured evidence scorecard and technical details.
9. **What happened before?** Receipts, dispositions, scan coverage, and source changes.

The exact path reveal is owner-only and never copied automatically. Copy feedback names what was
copied and does not expose the path through a global toast or URL.

## Guidance

Guidance is outcome-first; resource type remains a filter. Its lanes are:

### Can apply here

Contains a Managed operation whose exact target, authority, impact, preflight, verification, and
receipt contract are current. The row verb is specific: **Disable plugin**, **Remove registration**,
**Clean cache**, **Apply project patch**, or **Remove model**—never generic **Fix**.

### Steps available

Contains a signed/versioned built-in or provider procedure. It leads with the intended outcome,
then shows the source, OS, host, package manager, shell, expected effect, verification command, and
privilege requirement. Commands are copyable typed renderings and never auto-executed.

### Decisions to make

Contains one bounded choice, such as choosing an authoritative duplicate, keeping or removing an
exact registration, accepting a verified risk, or selecting a stable update. Every choice names
what changes and what remains.

### Updates available

Contains only a source-bound candidate with verified compatibility. Candidate and compatibility
sources are displayed separately. `Recommended` appears only with a named authority.

### Recovery to finish

Contains open interruption receipts. The primary action is **Audit interruption**. The row never
claims that audit will repair or finish the resource change.

### Inventory evidence only

This is an Inventory filter, not a Guidance lane. A verified condition without a bounded outcome
has no warning badge or action. Its inspector says:

> No action is requested. Agentic Kit does not have a verified operation, procedure, or bounded
> decision to offer for this condition in the current environment.

## Conflict explanations

Each conflict facet and detail disclosure carries a tooltip or inline definition:

| Classification | Explanation |
|---|---|
| Duplicate placement | Separate placements have equivalent verified definitions. Equality does not prove one is disposable. |
| Shadowed override | A narrower scope takes precedence over a broader placement for a verified host. |
| Same name, different definition | Names match but bounded definitions differ. The intended source cannot be inferred. |
| Equivalent MCP transport | Registrations resolve to the same verified transport. Equal transport does not prove equal scope or health. |
| Version requirement divergence | Verified consumers require incompatible version ranges. |
| Dependency resolution collision | The resolved dependency differs from the placement's verified declaration. |
| Shared artifact | Several consumers intentionally use one physical artifact. This is not a duplicate. |

## Discovery

Discovery shows automatic sources, user exact projects, collection roots, exclusions, coverage,
current scan progress, and previous completed scan time. Adding a root opens a preview before Save.

The preview includes:

- root type and environment;
- projects found with distinguishing breadcrumbs;
- automatic and explicit exclusions;
- traversal depth;
- symlinks encountered and not followed;
- external filesystem boundaries;
- estimated entries/bytes/time range when measurable; and
- the hard safety ceilings that would stop collection.

An excluded parent displays a recursive indicator and an affected-project preview. Stopping a
source explains that active Inventory rows will be removed while bounded historical receipts and
scan records remain.

### Scan progress language

Progress distinguishes a time slice from an incomplete source:

```text
Scanning 84,231 entries · 7 of 10 sources complete
This source is paused and will resume; its inventory is not yet complete.
```

If collection stops at a safety ceiling, state the measurement and ceiling. Never show a partial
count as a total or replace the last completed snapshot with a partial run.

## Activity

Activity groups:

- Recovery to finish
- In-progress reads and writes
- Change receipts and eligible undo
- Acknowledged, snoozed, and ignored-candidate decisions
- Recipe refreshes, diffs, acceptances, and withdrawals
- Completed, paused, stopped, and failed scan records

Receipts open a detail sheet with intent, provider, operation, timestamps, evidence, before/after
comparison, result, verification, restart, rollback, and preserved resources. Sanitized export is
the default. **Include local paths** requires a warning and fresh explicit selection.

## Procedure panel

The panel persists a preferred shell per environment and allows a run-local selection. It shows:

1. desired outcome;
2. source authority and recipe version;
3. compatible OS/host/package-manager/shell range;
4. privilege requirement;
5. expected change and preserved resources;
6. copyable command assembled from typed fields;
7. verification command;
8. persistent checklist; and
9. **Audit result** or **Verify after completing these steps**.

Partial success keeps completed checklist evidence and presents only the next grounded steps.

## Responsive behavior

- At wide widths, filters, results, and inspector remain simultaneously available without nested
  horizontal page scrolling.
- At narrow widths, filters use a dedicated sheet, selected details use a full-screen route, and
  Back returns focus to the originating row.
- At 320 CSS pixels, actions reflow vertically and no essential control hides behind a horizontal
  scroller.
- Large inventories use deterministic server-side paging or virtualization that preserves list or
  table semantics, focus, selection, and announced position.

## Accessibility contract

- Visible labels supply accessible names; icon-only meaning is prohibited.
- Selection does not destroy or unexpectedly move focus.
- Search announcements are debounced and summarize settled result counts once.
- Tables, lists, disclosures, dialogs, progress, and status use native semantics where possible.
- Color never carries condition, scope, source, or actionability alone.
- Both themes and forced-colors mode retain boundaries and selected state.
- Graphs have a structured list/table alternative.
- VoiceOver/Safari and NVDA/Chrome-or-Edge complete the critical journeys.

## Tone and terminology

Use factual conditions and concrete verbs. Do not use `Unknown`, `Unsupported`, `Needs attention`,
generic `Review`, `Fix`, `Safe`, `Automatic`, or `Recommended` without the exact evidence their
meaning requires.

Warning treatment is reserved for a verified consequential impact with a bounded containment
choice. Informational evidence without requested action stays visually neutral.

## UX evidence

- [Carbon status indicators](https://v10.carbondesignsystem.com/patterns/status-indicator-pattern/)
  advises against status indicators when no action is necessary.
- [GOV.UK warning text](https://design-system.service.gov.uk/components/warning-text/) reserves
  warnings for important consequences of action or inaction.
- [PatternFly alert guidance](https://www.patternfly.org/components/alert/design-guidelines/)
  separates concise message content from severity indication.
- [W3C accessible-name guidance](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)
  requires names to communicate function and distinguish controls.
- [WCAG Label in Name](https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html) keeps visible
  and programmatic control labels aligned for speech and assistive-technology users.
