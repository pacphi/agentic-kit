# Issue 262 Windows Test Speed Implementation Plan

> **For agentic workers:** Implement each task with a failing test first, focused
> verification, and one unit commit. Keep writing ownership in one worktree.

**Goal:** Return complete CI test feedback from every OS/Node matrix leg within
five minutes while preserving store-integrity and coverage gates.

**Architecture:** A private, closed SQLite schema template replaces repeated
autocommitted DDL in AQE merge fixtures. Independent test files expose safe
file-level parallelism. CI keeps full tests everywhere and collects coverage on
one designated leg.

**Tech Stack:** Node.js 22+, `node:test`, `node:sqlite`, GitHub Actions.

**Spec:** `docs/plans/2026-09-28-ci-windows-test-speed-design.md`

## Global constraints

- All nine test legs run the same full tests; only coverage instrumentation differs.
- Preserve the 36 merge test names and their assertions, including Windows EBUSY.
- Preserve default local 70/70/70 coverage, strict CI tripwire, temp cleanup,
  and the 30-minute CI job timeout.
- Use isolated test directories and never operate on the project's live AQE DB.
- Do not assume local macOS timings predict Windows results.

## Review focus

- Copying a WAL database with an open connection could omit committed rows:
  compare closed-template copies and check integrity and row counts.
- AQE init starts without `captured_experiences`: exercise the absent-table
  template and import's on-demand table creation.
- FTS tables and triggers can diverge during schema batching: compare schema
  objects and exercise FTS search after insert and delete.
- Test-level parallelism could race CLI `console.log` capture: parallelize only
  across isolated files and retain every CLI assertion.
- An opt-out typo could silently disable coverage everywhere: test default,
  explicit zero, and unexpected values; check the designated CI leg.

## Task 1: Closed schema templates

**Files:** Create `tests/kit/helpers/aqe-store-merge-fixture.mjs` and
`tests/kit/aqe-store-merge-fixture.test.mjs`; modify
`tests/kit/aqe-store-merge.test.mjs` to use the helper.

**Interface:** `buildStore(dir, options)` retains the current synchronous
fixture behavior. Other existing helpers are exported for the split in Task 2.

- [ ] Write parity tests that import the new helper and compare both schema
  variants with a sequential reference loader from the captured SQL fixture.
- [ ] Run the parity test and observe failure because the helper is missing.
- [ ] Build closed templates in one DDL transaction, copy the main DB, set WAL
  on the private copy, and insert rows in one transaction.
- [ ] Run the parity and all merge tests through the guarded test runner.
- [ ] Commit `test(aqe): reuse closed schema templates for merge fixtures`.

## Task 2: File-level parallelism

**Files:** Split `tests/kit/aqe-store-merge.test.mjs` into three concern-based
`.test.mjs` files, keeping shared fixtures in the Task 1 helper.

- [ ] Record the sorted current test names and count (36) as the migration
  oracle before moving tests.
- [ ] Move test blocks without changing assertions: preview/refusal,
  apply/archive, and starter patterns/CLI.
- [ ] Compare sorted names/counts with the oracle and run each file alone,
  then run the guarded full unit suite.
- [ ] Commit `refactor(test): parallelize AQE merge cases by file`.

## Task 3: Single coverage leg

**Files:** Modify `scripts/run-tests.mjs`,
`tests/kit/run-tests-runner.test.mjs`, and `.github/workflows/ci.yml`.

- [ ] Add runner tests: default unit suite retains four coverage flags;
  `AK_TEST_COVERAGE=0` removes only those flags; another value keeps coverage.
- [ ] Run focused tests and observe the explicit-zero case fail.
- [ ] Select coverage flags per run, while preserving all test commands and the
  real-state tripwire. Set the opt-out in CI except Ubuntu/Node 24.
- [ ] Run focused tests, the guarded full unit suite, static checks, and
  workflow validation.
- [ ] Commit `fix(ci): collect unit coverage on one matrix leg`.

## Task 4: Windows proof and handoff

**Files:** Update this plan and its design only if measurements require a
different approach. No test subset or blanket Defender exclusion is planned.

- [ ] Run or review CI for the exact branch source revision. Record every test
  leg's job duration, the slowest file, test counts, and coverage gate result.
- [ ] If the five-minute criterion fails, address the measured critical path
  in a separate test-first unit commit, then repeat the matrix.
- [ ] Collect ten consecutive completed runs and compare with issue #262's
  before table. Report any remaining limit honestly.
