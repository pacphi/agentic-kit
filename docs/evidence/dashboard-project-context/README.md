# Dashboard project and context evidence

All screenshots use deterministic fixtures, not private project data. The design
and host capability research are in [ADR-0050](../../adr/0050-dashboard-project-identity-and-context-reporting.md).

## Browser coverage

The committed browser suites use the real dashboard markup, styles, and client
code with fixture HTTP observations. They verify:

- Repository/worktree grouping and independent Desktop-origin filtering.
- Existing totals, old payload fallback, empty states, and unknown attribution.
- Maintenance folder/name alignment, shared Git badge, all language icons, and
  navigation through installations and back.
- Alphabetized Intelligence optgroups, plain names, stable selection keys, and
  empty-history navigation.
- Usage Score top-ten Git-project ranking, timeframe changes, plain names,
  excluded unclassified entries, and preserved overall totals.
- Compact collapsed context configuration, bounded expanded model lists,
  cache/configuration semantics, and catalog fallback columns.
- Desktop, tablet, and phone overflow checks, keyboard controls, focus retention,
  native select semantics, accessible icon labels, and browser errors.

These are targeted accessibility checks, not a claim of a complete WCAG audit.

## Screenshots

| Surface | Desktop | Phone |
| --- | --- | --- |
| Context configuration | [Default](context-desktop.png), [model disclosure](context-models-desktop.png) | [390 px](context-390.png) |
| System Projects | [Desktop](system-projects-desktop.png) | [390 px](system-projects-390.png) |
| Maintenance Projects | [Desktop](maintenance/project-cards-desktop.png) | [390 px](maintenance/project-cards-mobile.png) |
| Intelligence picker | [Desktop](intelligence/intelligence-picker-1360.png) | [390 px](intelligence/intelligence-picker-390.png) |
| Usage project groups | [Desktop](usage/usage-project-groups-1440.png) | [390 px](usage/usage-project-groups-390.png) |

Native popup rendering belongs to the operating system; the Intelligence test
asserts optgroup contents and ordering directly in the native select.

## Reproduction

```sh
npm test
npm run typecheck
npm run lint
npm run lint:cc
npm run lint:md
npm run build
npm run test:ui
```

The four focused browser suites are also included in `test:ui`. Ordinary runs
write screenshots only to the ignored UI artifact directory, or to an explicit
`AK_UI_ARTIFACTS` / `AK_DASHBOARD_EVIDENCE_DIR` destination. CI results and the exact
reviewed source commit are linked from the pull request.

## Remaining boundaries

- Older footprint snapshots need a remeasurement to acquire new identity/origin
  metadata; they remain readable and unclassified in the meantime.
- Usage index schema 20 reparses retained records once; originals are untouched.
- Desktop labels reflect exact recorded declarations, not independently verified
  launching applications. Undiscovered Desktop history stays outside coverage.
- Cached model capacities and configuration calculations are not live-session
  window/usage observations. Only Codex currently has kit-owned context writes.
