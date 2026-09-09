> Archived snapshot, 2026-09-08. Original status and evidence below are historical.
> Current guidance: [Maintenance](../MAINTENANCE.md), [acceptance and open gates](../MAINTENANCE-ACCEPTANCE.md),
> and [ADR-0048](../adr/0048-inventory-led-maintenance-resource-management.md).

# Maintenance experience specification

- **Design status:** Accepted — Focus browser approved 2026-09-08; integration verification and ADR-0048 human/cross-platform gates remain open
- **Governing decision:** [ADR-0048](../adr/0048-inventory-led-maintenance-resource-management.md)

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
Maintenance                 Inventory | Guidance | Discovery | Activity
Refresh evidence            Re-measure machine
Filters                     Across scopes › User › MCP registrations
  Scope                     context7                 2 installations
  Project                   playwright               1 installation
  Include worktrees         …
  Type                      [Select a resource to reveal its installations]
  Hosts / Adapters
  More filters              [Exact installation opens details below the list]
  Active chips / Clear all
```

### Narrow-screen flow

The same Focus browser shows one level at a time. Filters open in a sheet, breadcrumbs wrap,
and selecting an exact installation opens details below the current list. Closing details restores the prior
level and row focus. No essential navigation requires horizontal scrolling or a hover gesture.

## Inventory

**B — Focus browser**, approved 2026-09-08, is the current interaction design. The earlier compact
Option A cards remain historical context; the expandable tree and column-browser alternatives
remain comparison prototypes. Approval does not complete integration, usability, assistive-
technology, or cross-platform verification.

Across scopes initially shows four labelled roots: **System**, **Machine**, **User**, and
**Projects**. It does not render every resource family or installation at once. Selecting a root
reveals the next level:

- System / Machine / User → resource type → resource family → exact installation.
- Projects → repository → resource type → resource family → exact installation.

Only the current level is rendered as the main list. A breadcrumb records the selected context;
ancestor controls return to a broader level while retaining active filters. Resource types come
from verified measurements, not hardcoded assumptions about what a host must have installed.
Scope roots remain distinguishable even when a source is empty or incomplete; coverage explains
which conclusions the saved evidence can support.

### Scope lens and filter shortcuts

The scope lens remains **System**, **Machine**, **User**, **Projects**, or **Across scopes**.
Selecting a scope filter skips the scope roots; selecting one project skips its repository level;
selecting one type skips the type level. Already selected context stays in the heading, breadcrumb,
or chips. Selecting a type while inside User must retain User; it must not unexpectedly broaden
the view across scopes. Removing a filter restores the corresponding navigable level. Multiselect
filters narrow available branches while preserving any level with more than one possible value.
Search and host filters narrow the same query; they do not create a separate inventory.

Guidance-first, name, recently changed, and kind sorting apply within the current level where
meaningful. The Guidance-first order remains Recovery to finish, Can apply here, Steps available,
Decisions to make, Updates available, Inventory evidence only, then Healthy resources. This is a
sort, not a severity ladder or a reason to expand every matching branch. Healthy verified
resources remain available.

Scope labels always include text. Supporting icons do not encode provenance or actionability.

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

Facets are multiselect, show counts, and provide one **Clear all** action. Singleton scope, project,
type, and family choices appear in the breadcrumb, without duplicate chips. Other refinements and
multiselect choices retain removable chips. Breadcrumb backtracking or sidebar deselection removes
navigation choices.
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

### Resource family and exact installation

The compact filter rail and full-width list remain until an exact installation is selected.
Common views and project, type, host, and adapter facets are available immediately; More views
and More filters retain advanced controls. Extra and multiselect refinements remain removable chips;
singleton navigation choices use breadcrumbs. Long option
lists are searchable and scroll inside their disclosure.

A family row names the resource and distinct installation count in context. Choosing it reveals
exact installations, each with measured location first, **Available to** host names, and meaningful
version evidence. Shared scope, repository, and type are supplied by navigation context instead
of repeated on every row. Project labels contain repository identity, not an installation suffix;
colliding basenames use the shortest distinguishing parent breadcrumb. Missing location evidence
falls back to a factual breadcrumb, never a guessed host directory. Relative project locations
must stay inside the measured project root; exact absolute paths remain owner-private.

Canonical family identity may group different measured versions for presentation; it never
collapses exact resource or placement IDs or relies on display-name equality alone. One physical
installation consumed by several hosts is one row. Resource and branch counts do not add repeated
relationship links. Bounded paging remains source-generation-bound and must not turn a partial
page into a complete count. No loading path opens all installations across the whole inventory.

Rows offer neutral **View details** navigation. Variant markers and content digests remain in
technical evidence. Optional write actions appear only in exact installation details and use the
existing preview and confirmation flow. Exploring **Also installed** is a contextual relationship:
it preserves filters and identifies any related selection outside them, rather than silently
clearing the view. A separately labelled reset or clear-filter control is the explicit way to
broaden filters.

### Resource inspector

Selecting an exact installation opens details below the current list without losing its
breadcrumb or filters. Closing details restores the originating row focus; Escape also closes
them. Details and expandable relationship cards reflow on narrow screens, with an accessible
**Close details** control. The inspector answers questions in this order:

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

### Evidence-backed relationship disclosures

Relationships are compact expandable sections in exact installation details. Following a related
installation preserves filters and the originating browsing context. A related item outside the
current filters is explicitly labelled; returning restores the original installation or list.
Every relationship is read-only navigation and counts each placement once.

| Relationship | Required evidence |
|---|---|
| Provides / Provided by | Manifest or explicit recorded producer relationship; inclusion is not an installer receipt |
| Available to | Recorded consumer bindings; availability does not claim recent use |
| Requires / Required by | Declared configuration reference and resolved dependency evidence; reverse links derive from the same edge |
| Overrides / Overridden in | Adapter-specific precedence and effective-configuration evidence, never scope order alone |
| Also installed | Explicit canonical resource identity; equal names alone are insufficient |
| Origin not established | No supported origin claim; absence is not proof of independent ownership |

Plugin-provided skills may be explored from a plugin only when inclusion is established. They
remain the same installations reachable from their resource type. **Installed by** requires an
installer receipt. Symlink targets, physical containment, content equality, conflict, and update
availability are separate facts; none substitutes for a producer or override edge. Adapters that
lack evidence omit the relationship rather than imitating prototype fixture relationships.

## Guidance

Guidance is outcome-first; resource type remains a filter. Merely supporting removal or disablement
does not admit a recommendation. Such capabilities stay under **Optional actions** in installation
details, using the same exact preview and confirmation flow. Relationships never admit Guidance
without its independent condition, evidence, and outcome requirements. Its lanes are:

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

Contains source-bound, demonstrably newer releases. Host-reported availability is visible even
when compatibility is not verified; candidate source and compatibility status are displayed
separately. This does not grant an update action. `Recommended` appears only with a named authority.
Ambiguous candidates and versions whose ordering cannot be established remain detail evidence.

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

- At wide widths, the filter rail and current list remain visible; selected details appear below
  the list without horizontal page scrolling.
- At narrow widths, filters use a dedicated sheet, selected details reflow below the list, and
  closing returns focus to the originating row.
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

### Measurement feedback (retained in Focus browser)

The toolbar directly below Inventory, Guidance, Discovery, and Activity is the single location
for Refresh evidence and Re-measure machine within Maintenance. Coverage notices are passive.
Both controls are disabled during an operation. Local feedback shows elapsed time and the same
measurement phases as Full scan, then evidence checking and inventory publication. Activity
reflects the running operation. Completion requires fresh provider and inventory results;
failures and remaining coverage gaps are explicit. The elapsed timer is not announced every second.
Discovery reports filesystem coverage separately from non-filesystem evidence checks. Automatic
project discovery is a policy toggle, not an extra filesystem root in the coverage denominator.

### Hosts and external adapters (2026-09-07 correction)

The filter rail keeps **Hosts** (Claude, Codex, OpenCode) separate from **Adapters**
(external host integrations, including Hermes). This follows [Host support](../HOST-SUPPORT.md)
and the [Hermes external adapter guide](../HERMES-HOST-ADAPTER.md). An adapter filter counts
associated inventory resources; a zero count does not assert installation, admission, trust,
or runtime health. Existing preview and capability gates continue to govern actions.

Model host attribution comes from matching consumer bindings. Merely appearing in Agentic Kit's
model inventory does not establish Agentic Kit as a consuming host. Known managed host-state
roots are excluded from implicit catalog project candidates; explicitly designated project
objects remain eligible. Version-like project names are not filtered by their spelling.

### Project designations (approved 2026-09-07)

Projects include repositories and ordinary project folders. A Git branch icon with **Git**,
a folder icon with **Folder**, or a branch icon with **Worktree** appears beside each project
choice and once in its browsing context. **Include worktrees** below project search controls
worktree visibility; worktrees are hidden by default, while selected worktrees stay reachable
until deselected. The toggle remains available during project search and when only worktree
choices exist. There is no **Project type** control. The preference changes presentation, not
discovery inclusion, measured placements, or exact write targets. Labels accompany icons.

New catalog measurements retain classification for all project candidates, independently of
the narrower hosted-repository disk measurement. A readable folder with no Git marker in its
ancestry is Folder; verified Git markers identify Git, and linked metadata identifies Worktree.
Unreadable, missing, malformed, or dangling evidence is **Not checked**. Old snapshots with no
explicit negative evidence do not imply non-Git. A fresh measurement improves these labels.

The classification is added after project identity assignment. It cannot change project IDs,
placement IDs, receipt targets, or action authority. Installed tool caches remain excluded from
implicit project candidates; a version-like name alone never excludes a genuine project folder.

### Resource families and measured versions — approved 2026-09-08

Families appear at their selected hierarchy level; Across scopes starts at scope roots. The
canonical family key excludes definition digest while every exact resource and placement identity
is retained. Family identity is separate from branch/disclosure identity. Installation rows carry
measured locations, consumer bindings, and versions. Related installations can be inspected across
scopes with the current filters preserved and any outside-filter selection labelled. Bounded pages
remain at most 200 placements and continuations merge by canonical family without losing branch
context.

Plugin release versions come from measured native inventory or installed manifests. Skills,
agents, and commands may inherit a parent-plugin version, labelled separately from their own
release. Content digests and cache generations remain separate evidence. Update candidates come
from explicit provider refresh, never network work during inventory reads. Missing version or
update sources remain explicit; an MCP registration does not establish the server package version.
Native candidate probing currently covers Claude/Codex plugins; OpenCode and external adapters
retain unknown status until their collectors provide equivalent evidence.

Maintenance models are local Ollama inventory or configured/effective/bound remote models.
Discoverable-only provider catalog entries stay in model discovery. Remote configurations are
not labelled as local blobs. Reveal exact path is available only with a recorded private locator;
local storage roots retain their measured paths in that locator store.
