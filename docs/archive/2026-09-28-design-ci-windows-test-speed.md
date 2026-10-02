# Issue 262: Windows test feedback under five minutes

## Status

Approved 2026-09-28; implemented and merged via PR #267 (`ab2fc5cb`, 2026-09-29). Two runs at the
merged head showed Windows legs at 3:21–4:22 (down from 11:28–12:56 before). The ten-consecutive-run
stability proof and closing #262 remain open, tracked as branch V1 in
[remediation program v2](2026-09-28-plan-remediation-program-v2.md).

## Outcome

Every test job in the existing three-OS, three-Node CI matrix runs the full unit
and statusline suite and finishes within five minutes from job start. The other
CI jobs continue to finish within that budget. GitHub queue delay is reported
separately because the repository cannot control runner allocation.

## Baseline and cause to test

Issue #262 reports 8–15 minute Windows test jobs after the AQE store integrity
change. A completed run on 2026-09-28 took 11 minutes 50 seconds in the Windows
Node 22 `Unit + statusline tests` step. The 36 current AQE merge tests passed in
6.4 seconds on a local macOS Node 26 run. These observations establish a
Windows-specific critical path; they do not establish that Defender or coverage
is the cause.

After the fixture and file split, those same 36 tests passed in 0.63 seconds
locally on macOS Node 26. This is local evidence, not a Windows speed result.

Before this change, `tests/kit/aqe-store-merge.test.mjs` built three AQE 3.14.4
stores per typical test, repeatedly executing the captured schema statement by
statement. Node ran those tests in one file serially. The runner instrumented
the kit `.mjs` command with 70% line, branch and function floors on all nine
matrix legs; the seven statusline/admin `.cjs` commands ran separately.

## Fixture contract

Use a test-only helper. Build two closed templates per test-file process from
the captured AQE schema in one transaction: one with `captured_experiences` and
one without it. Copy only the main database file into each test's private temp
directory; set WAL mode on that copy, insert its rows in one transaction, close
it, and create its `patterns.rvf` file. No writable SQLite connection or WAL
sidecar is shared between tests.

Compare the resulting schema to the existing sequential loader for both
variants, including the FTS table and triggers. Check `integrity_check`,
`foreign_key_check`, fixture rows, and the no-table import path. Preserve the
current merge assertions and the Windows `EBUSY` case.

## Parallel execution and coverage

Split the 36 merge tests by concern into private-file processes: preview and
refusal, apply and archive, and starter patterns and CLI. Extract their shared
fixture into a non-test helper. Keep test-level concurrency off: CLI output
capture temporarily replaces `console.log`. Adjust file grouping only from
Windows per-test timings if one file remains the critical path.

Keep the same full tests on all nine matrix legs. By default `pnpm test` retains
coverage and its 70/70/70 floors. CI sets an explicit opt-out on eight legs and
leaves Ubuntu/Node 24 as the coverage gate. An unexpected opt-out value keeps
coverage enabled. No test or real-state tripwire is removed.

## Acceptance and evidence

- Existing 36 test names and assertions remain present; fixture parity tests
  pass on supported Node versions.
- `node scripts/run-tests.mjs unit` passes the real-state tripwire, coverage
  floors, and temp cleanup. Windows `EBUSY` and store-integrity tests still run.
- CI's full test matrix, minimum-runtime, quality, UI, and links jobs pass.
- Ten consecutive completed CI runs show every test job under five minutes,
  measured from job start to completion. Record the before/after job durations
  and slowest test-file durations. The 30-minute timeout remains unchanged.
- If a Windows leg exceeds five minutes, retain the full matrix and profile its
  measured remaining critical path before another optimization.

## Relevant decisions

ADR-0062 is Accepted (2026-09-27). This design changes test construction and
CI instrumentation, not the store merge contract it describes. ADR-0014 is
Implemented (updated 2026-09-28) and promises default local `pnpm test`
coverage on the kit `.mjs` suite; CI's single coverage leg is documented there.
