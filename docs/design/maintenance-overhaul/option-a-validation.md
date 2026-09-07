# Maintenance Option A validation — 2026-09-07

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
