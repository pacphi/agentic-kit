> Archived snapshot, 2026-09-08. Original status and evidence below are historical.
> Current guidance: [Maintenance](../MAINTENANCE.md), [acceptance and open gates](../MAINTENANCE-ACCEPTANCE.md),
> and [ADR-0048](../adr/0048-inventory-led-maintenance-resource-management.md).

# Focus browser implementation evidence

Date: 2026-09-08. Status: implemented in the working tree; focused checks pass.
ADR-0048 remains Accepted pending its human and cross-platform gates.

The user approved alternative B. Inventory now requests server-aggregated focus navigation,
uses a single current-level list and breadcrumbs, and opens exact installation details below it.
Navigation counts and pages are derived from all filtered placements. Flat CLI and Guidance
queries retain their existing contract. Worktree visibility changes project choices only.

Relationship cards use recorded consumer bindings, verified plugin provenance, verified dependency
edges, and presentation-family identities. Missing or ambiguous plugin parents are not guessed.
Full plugin references are tested through catalog projection into the inspector. Override links
are not currently emitted. Following a relation preserves the query and supports return navigation.

## Verification

- **441 focused tests passed**, covering management, navigation, relationships, API allowlists,
  presentation, guidance and dependency checks. Tests include full-result counts, node paging,
  more than 500 family labels, exact installation identity, and ambiguous producer evidence.
- **Three browser tests passed**: `tests/ui/maintenance-focus.mjs`,
  `tests/ui/maintenance-projects.mjs`, and `tests/ui/maintenance-guidance.mjs`. They use real
  query/projection DTOs and browser code with fixture evidence. Desktop, mobile width, keyboard
  movement, worktree selection, breadcrumbs, all-installations navigation and relationships pass.
- Build passed (372 shipped files syntax-checked, CLI load and package dry run).
- Markdown lint passed across 104 authored files.
- Typecheck and changed-code ESLint passed with no errors. Existing file-size and projection
  complexity warnings remain. Changed files pass whitespace checks.
- The broader `tests/ui/dashboard-ui.mjs` run is **not green**: seven legacy assertions failed
  and it timed out at re-measure completion. Six assertions and that timeout were previously
  reproduced on the unchanged baseline; this run also failed a legacy Guidance action-label
  expectation. This evidence does not claim full dashboard regression completion.
- The repository-wide AQE gate reports **20/100, failed**, based on overall coverage and
  complexity. It is not a usability score or a source-bound assessment of this feature alone.

The focused source/test fingerprint is `056fed25a91246b022c28396b711a4d5b1db0892976443a465acdb758559cbf6` (SHA-256 over the sorted
path/content-hash manifest of tracked and untracked `.mjs` files in `src/lib/dashboard`,
`src/lib/maintenance`, `tests/kit`, and `tests/ui`). The complete manifest and command-run logs
were retained locally under `/tmp/ak-focus-*`; those local files are not release artifacts.

No release, commit, push, cross-platform live run, representative-user study or screen-reader
signoff is claimed. The approved mockup remains illustrative design evidence.
