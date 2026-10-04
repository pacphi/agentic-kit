# Estate convergence: bringing every managed project to current

## Status

**Active** (2026-10-03). Design approved by the maintainer in chat on 2026-10-03. Queued: the
two cards below enter the inventory in this pull request and become issues through the
dependency-sync runbook; the `sync --all --upgrade` wording for P5-02 landed in the plan
amendment (master plan Decision G15). No code is written for this spec until the
4.1.0 and v5.0.0 cards are scheduled.

## Outcome

A person with twenty projects opted in on one machine can see which of them are current and
converge the rest in one motion, without ak ever writing outside an opted-in project or moving a
version nobody asked for.

The v5 product is **fleet management**. Its first high-value activity is this one, on one machine.
Everything cross-machine, scheduled or policy-driven builds on it later.

## Vocabulary

- **Estate:** every project opted in on this machine. Found through the project index in the
  cache, confirmed by each project's `.agentic-kit/project.json` marker, and completed by the
  census `optedIn` scope (project-scoped management design, "Finding every managed project").
- **Current:** a per-project predicate with five parts. A project is current when all five hold.
  1. Its `kitVersion` pin is satisfied by the running `ak`.
  2. Every tool pin is inside that tool's support window.
  3. Its projections match their receipts (nothing drifted, nothing edited and stale).
  4. Its prerequisites pass.
  5. Its status snapshot is younger than 7 days (the Health card's threshold).
- **Verdict:** `current`, `stale` (one of parts 1, 2 or 5 fails), `needs attention` (part 3 or
  4 fails, or the project's own status has attention rows), `unknown` (no snapshot, unreadable
  marker, or the project moved).
- **Estate convergence:** the primitive: a report of every project's verdict, then an explicit,
  approved move of the pins that make stale projects current.
- **Fleet:** the v5 capability that adds plans, policies, cohorts and more than one machine.

## Invariants

These hold for every part of this design. They come from ADR-0064 and the v5 decisions X1 to X3
in `docs/proposals/v5-impact-of-v4.md`.

- The unit of management is the opted-in project. There is no machine-level configuration.
- ak writes only inside opted-in project roots or to the cache. `estate.json` is cache: safe to
  delete, rebuilt on every run.
- ak schedules nothing. It never edits launchd or systemd and never self-updates.
- Nothing moves a pin except `sync --upgrade`, after a plan is shown and the maintainer says yes.
- Applying a plan is always `ak sync` running in each opted-in project in turn; a failure in one
  project never stops or silently retries another.
- The dashboard stays read-only for project files until X2 decides otherwise.
- In 4.x, pins are pinned only. Policies that let a pin float wait for X1 in v5.

## Delivery

### 4.1.0: the estate report (card C41-05)

`ak status --all` is read-only. It aggregates every opted-in project's `state/status.json` into
one table and one file, `cacheDir()/estate.json`. Per project it shows the root, the `kitVersion`
pin against the running version, each tool pin against the support window, projection drift,
snapshot age, the verdict, and the exact command to run there (`ak sync` or
`ak sync --upgrade <name>` in that root). It refreshes nothing by default and prints each
snapshot's age; `--refresh` re-collects two projects at a time, like the dashboard's Refresh all.

The dashboard's Health, Needs attention and Versions in use cards read the same aggregate, so the
CLI and the dashboard agree on every project.

Acceptance: writes only `estate.json` in the cache (the real-state tripwire proves it); a project
with any pin outside the support window is reported stale and never moved; a snapshot older than
7 days is reported with its age; CLI and dashboard verdicts match for every project.

### P5-02 (beta.3): `sync --all --upgrade` semantics

`ak sync --all --upgrade [name[@version]]` shows one per-project plan (which pins move, from what
to what), takes one yes, then moves the named pin in every opted-in project, or, with no name,
every pin to the newest version inside its support window. `--dry-run` prints the plan and stops.
A failure in one project is reported and the batch continues. The report lists projects moved,
left and failed. This wording is added to card P5-02 by the plan amendment that also introduces
the `managed-tools` skill, because P5 implements `sync` and the composition is the same code path.

### v5.0.0: estate convergence design (card V5-13)

A research card under the v5 intake epic. It produces the spec for the fleet's convergence loop:

- `fleet plan` builds a plan from `estate.json`; `fleet apply` runs the plan as `ak sync --upgrade`
  in each opted-in project under one approval per plan (X3's rule); verify re-reads the estate.
- Policies Notify, Stage (fill the cache ahead of time) and Managed care, as X1 decides them.
- Team rollout through pull requests that change pins in `project.json` (B6.2).
- Cohorts and canaries (X3), the fleet cockpit in the dashboard once X2 is decided (B1.6), and
  more than one machine through telemetry v2 (T01, X4).

It is blocked by V5-08 (which decides X1 to X4 and X6) and by C41-05 (its input). The feature
epic and its cards are created from the spec when V5-08 has decided; this card does not create
them.

## What this does not decide

- Whether pins may float in 4.x. Decided: no. The question returns as X1 in v5.
- Whether the dashboard may run convergence. That is X2.
- Anything about machines other than this one. That is X3 and X4.

## Sources

- [Project-scoped management design](2026-10-01-project-scope-only-design.md): Commands; Sync,
  status, uninstall; Finding every managed project; Dashboard and metrics.
- [ADR-0064](../adr/0064-project-scoped-management.md).
- [v5 plans measured against the v4 decisions](../proposals/v5-impact-of-v4.md): X1, X2, X3, X4,
  B1.6, B5.2, B6.1, B6.2, T01.
- [v4 GA master plan](2026-10-01-v4-ga-master-plan.md): Decision G14, card format, dependency
  sync runbook.
