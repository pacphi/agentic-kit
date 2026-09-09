> Archived snapshot, 2026-09-08. Original status and evidence below are historical.
> Current guidance: [Maintenance](../MAINTENANCE.md), [acceptance and open gates](../MAINTENANCE-ACCEPTANCE.md),
> and [ADR-0048](../adr/0048-inventory-led-maintenance-resource-management.md).

# Approved Focus browser reference and alternatives

Status: **B — Focus browser approved by the user, 2026-09-08.** The prototype is a design
reference with illustrative data, not a deployed implementation or evidence of adapter support.
Implementation and [focused verification](2026-09-08-validation-maintenance-focus.md) are complete; ADR-0048 remains Accepted pending human and cross-platform
evaluation. A and C remain comparison alternatives, not additional production modes.

Open [the interactive prototype](2026-09-08-artifact-maintenance-progressive-inventory.html) directly in a browser. It is a
self-contained HTML file with illustrative data, no network requests, and no mutation actions.
It opens in approved Focus mode. The top controls retain comparison presentations; journey
buttons set up representative scenarios. The production design is specified in the
[experience specification](2026-09-04-design-maintenance-overhaul-experience-specification.md).

| Alternative | Behavior | Tradeoff |
| --- | --- | --- |
| A. Scope tree | Four scope roots; expand branches in place | Familiar and supports comparing branches, but long when deeply expanded |
| B. Focus browser — approved | Show one hierarchy level with a breadcrumb | Selected default; comparing branches requires navigation |
| C. Column browser | Each selection opens an adjacent level | Strong path visibility on desktop; requires horizontal scrolling on narrow screens |

All use the same taxonomy. System and Machine expose resource types, User exposes capability
and configuration types, and Projects exposes repositories first. Resource families then reveal
exact installations. Across scopes is the four scope roots, never a giant expanded placement list.
Projects uses Include worktrees below project search instead of a Project type control; hidden
worktree choices do not remove measured placements. Exact details appear below the current list,
with compact expandable relationship cards. Host bindings appear where they clarify those installations; several hosts
reading one physical skill do not create multiple installation rows.

Selecting a scope or resource-type filter removes that redundant hierarchy level. Applying a
resource-type filter while browsing User retains User as explicit filter context. Removing a
filter restores the broader hierarchy. The production contract keeps singleton scope/project/type/family choices in breadcrumbs without
duplicate chips; other and multiselect refinements retain removable chips. The comparison fixture
may show broader chip context than the final production layout. The prototype intentionally uses small fixture lists, not production-scale pagination.

## Relationship presentation

Relationships appear only after selecting an exact installation. Each is a compact expandable
card. Opening a related installation preserves the inventory filters and labels an out-of-filter
selection explicitly. Counts never add relationship links to the number of installations.

| Relationship | Example shown | Evidence required in the product |
| --- | --- | --- |
| Provides / provided by | Plugin ↔ included skills | Manifest or explicit recorded producer relationship |
| Available to | One skill → Codex and OpenCode | Recorded consumer bindings; does not imply recent use |
| Requires / required by | MCP registration ↔ Node.js runtime | Configuration reference plus resolved executable evidence |
| Overrides / overridden in | Project MCP configuration ↔ User configuration | Adapter-specific precedence and effective-configuration evidence |
| Also installed | Resource ↔ separate installations | Explicit shared resource identity, not a matching name |
| Origin not established | Skill with no proven producer | Absence remains unknown, never inferred independent ownership |

The fixture explicitly establishes equivalence for its repeated resources. Plugin inclusion does
not prove that a plugin performed an installation: **Installed by** would require an installer
receipt. Likewise, an available update, shared digest, symlink target, or conflict can become a
separate relationship only with its own supporting evidence. Avoid treating physical containment,
shared identity, content equality, and configuration precedence as interchangeable edges.

Current code has artifact, consumer, provenance and dependency concepts; these mockups do not
claim that every adapter already emits every illustrated relationship. In particular, the project
MCP override is hypothetical host-specific evidence, not a universal configuration rule.

## Evaluation journeys

1. In the default Focus browser, start at All scopes; select User, MCP registrations, context7,
   then an exact installation. Use the breadcrumb to return.
2. Enter User and select MCP registrations in the sidebar; the type level is skipped and User
   context remains visible.
3. Open a plugin's Included skills, then inspect one skill and follow Provided by back.
4. Open MCP → runtime; expand Requires and follow the link into Machine without losing filters.
5. Open One skill → two hosts; inspect the single location and two consumer bindings.
6. Open Project → user configuration; inspect the recorded precedence relationship.
7. Toggle worktrees, change host filters, clear chips, and compare the same journeys across modes.

Earlier prototype smoke checks covered the three alternatives, User + kind filtering, related
selections, plugin-specific branch identities, and narrow-screen overflow. They do not validate
the integrated production browser. Focus is now the approved presentation; task-based human and
assistive-technology evaluation, source-bound integration checks, and cross-platform gates remain
open. No usability score or production completion is claimed.
