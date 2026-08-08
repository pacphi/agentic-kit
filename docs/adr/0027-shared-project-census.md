# ADR-0027 — One project census, four scopes, every count explains itself

- **Status:** Implemented
- **Date:** 2026-08-07
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0012](0012-observability.md),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0024](0024-project-intelligence-telemetry.md),
  [ADR-0025](0025-machine-footprint-metrics.md)
- **Supersedes:** the machine-wide discovery amendment in ADR-0024 (`discoverRuvfloProjects`)

## Context

Four dashboard areas answered "what projects does this machine have" four different ways, from
four different sources, with four different naming rules — and reported four different numbers for
the same machine:

| Area | Source of truth | Naming | Reported |
|---|---|---|---|
| Overview → Intelligence | directories with `.claude-flow/neural/`, from the 150 most recent transcripts | basename | **4** |
| Observability → History | git-root identity over a 14-day transcript window | identity hash | **14** |
| Usage → Scorecard | `projectLabel()` basename heuristic, over its own day window | cwd basename | **14** (a *different* 14) |
| System → Projects | every `cwd` any host ever recorded | resolved real path | **~48** |

No single number was wrong. What was wrong is that nothing told the user which question each was
answering, so four honest answers read as one broken feature. Worse, the Intelligence number was
answering a question nobody asked: `.claude-flow/neural/` means "ruflo has *trained* here", which
silently excluded every project whose memory came from agentic-qe or swarm storage, and every
project driven by Codex or OpenCode rather than Claude. On the deciding machine it reported 4
projects where 17 had memory or intelligence active.

## Decision

**One census. Four named scopes. Every count is rendered with the scope that produced it.**

`discoverProjectSources()` (`src/lib/footprint/project-sources.mjs`) becomes the single census,
reused verbatim rather than reimplemented. It is already the widest and most carefully bounded of
the four sources: it reads exactly one field — the session `cwd` — out of the head of every Claude
and Codex transcript plus the OpenCode session store, dedupes by resolved real path, and reports
three deliberately distinct figures instead of one lossy total.

`src/lib/project-census.mjs` wraps it with the scope vocabulary:

| Scope | Means | Level |
|---|---|---|
| `everSeen` | every project any host ever recorded a session in, deletions included | directory |
| `onDisk` | the subset that still resolves — the only projects that can be measured | directory |
| `gitRepos` | the on-disk subset under version control | directory |
| `learning` | on-disk projects with `.claude-flow`, `.agentic-qe` or `.swarm` state, whichever host created it | **project** |

Three consequences of that table are the actual decision:

**1. The learning scope is about activation, not training.** Its markers are exactly the ones
`defaultStorageRoots()` already treats as a project's learning stores, so the Intelligence panel and
the Storage panel cannot disagree about what a learning store *is*. Host-independence is the point:
memory activated by Codex counts.

**2. Directory scopes and project scopes are different levels, deliberately.** The System area
measures **directories** because that is what has bytes and lines in it ([ADR-0025](0025-machine-footprint-metrics.md));
folding them would destroy the figures it exists to report. The Intelligence panel aggregates
**projects**, because a project is what a user picks. So the learning scope folds a repository's
sub-directories and its ephemeral `.claude/worktrees/agent-*` checkouts onto the repository root,
keyed by `resolveProjectIdentity()` — the same git-root identity Observability already uses.

This is not cosmetic. The project picker keys on that identity. Listing 24 directories against 17
identities made 7 rows unreachable and let the wrong project be selected.

**3. Counts still differ, and that is correct.** A lifetime census, a 14-day session window and a
learning-state subset are three questions. Shared identity removes the *spurious* differences —
`backend` and `emailibrium` are no longer two projects — and leaves the real ones. For the real ones
the answer is not to force agreement but to explain: `describeScope()` returns one sentence naming
what a count counted and how it narrowed, and **no surface may render a project count without one.**
Where a count is windowed, the window is named, because that is then the only remaining reason two
counts legitimately differ.

## Consequences

- The Intelligence panel reports every project with memory or intelligence state, whichever host
  created it — 17 rather than 4 on the deciding machine.
- The redundant "N projects tracked on this machine" and "N projects available" captions are
  **deleted**, not reworded: with a scope explainer and a KPI card, they restated a number twice and
  explained it zero times.
- `discoverRuvfloProjects()` and `project-discovery.mjs` are retired, and `registryWorkspaces()`
  reverts to module-private. ruflo's machine-level registries do not exist on every machine — which
  is exactly why they made a poor discovery source and a fine daemon-accounting one.
- A census walk is not free (~650 ms over ~3,200 transcripts on the deciding machine). It stays
  behind the existing 60-second snapshot cache, walked once per snapshot and exposed two ways.
- `learningState` rides onto each project row so a project reporting zero patterns can say *why* —
  a project with `.agentic-qe` but no ruflo counters is genuinely active and genuinely has no
  patterns, and without that field it is indistinguishable from a failed read ([ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md)).
- The census reports `complete: false` when a transcript could not be read, and every figure derived
  from it is then rendered as a lower bound rather than a fact.
- Adding a fifth scope means adding a row to `SCOPE_NOTE`; a scope with no explanation returns the
  empty string rather than rendering an unexplained number.

## References

- `src/lib/project-census.mjs` — `projectCensus`, `projectsInScope`, `describeScope`,
  `hasLearningState`, `LEARNING_MARKERS`
- `src/lib/footprint/project-sources.mjs` — `discoverProjectSources` (the census itself)
- `src/lib/live/project-label.mjs` — `resolveProjectIdentity` (the shared identity)
- `src/lib/dashboard-server.mjs` — `censusBackedDiscovery`, `buildProjectSnapshotCache`
- `tests/kit/project-census.test.mjs`
- [docs/ddd/project-intelligence.md](../ddd/project-intelligence.md),
  [docs/ddd/context-map.md](../ddd/context-map.md)
