# Proposals

Proposals are written but not yet decided. A proposal is a single `<topic>.md`, or a `<topic>/`
folder when it has several documents. Its governing ADR carries the current status.

| Proposal | Governing decision |
| --- | --- |
| [Autonomous improvement](autonomous-improvement/README.md) | ADR-0022 (Proposed) |
| [MetaHarness companion](metaharness-companion.md) | [ADR-0022](../adr/0022-metaharness-as-optional-assurance-companion.md) (Proposed) |
| [Project metadata adapters](project-metadata-adapters.md) | ADR-0025 (Implemented) and ADR-0048 (Accepted) |
| [v5 planning sources](v5-planning-sources.md) | None yet: input to the v5.0.0 board; ADR-0056 and ADR-0057 are Proposed on a branch |
| [v5 measured against v4](v5-impact-of-v4.md) | None yet: v5.0.0 planning input; decisions X1–X7 pending |

When accepted, a proposal becomes a plan or ADR. Rejected and abandoned proposals move to
[the archive](../archive/README.md) as `YYYY-MM-DD-proposal-<topic>` using
`node scripts/docs-relocate.mjs`.
