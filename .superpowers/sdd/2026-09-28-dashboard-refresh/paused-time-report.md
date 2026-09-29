# V3 Activity paused-time consumer report

## Source and contract

- Base: `66982f22` in `feat/dashboard-refresh`.
- Read the V4 B8 producer in `agentic-kit-v4-rest` without changing it. A paused history row has `recordedAt` and `completedAt: null`; completed rows retain `completedAt`.

## Change

- Activity projection keeps a bounded, valid ISO `recordedAt` separately from `completedAt`, uses it to choose the latest state per source and environment, and falls back to a valid completion time. Invalid scan timestamps become `null`; unrelated metadata is not projected.
- The v2 Activity API allowlists a bounded ISO pause timestamp and omits invalid stamps and private metadata.
- The Activity history table sorts, groups, and displays by the valid recorded time or completion time. Its labels and empty copy describe scan records without claiming every scan completed.

## Evidence

- Red phase: guarded focused suites had 3 expected failures for missing pause time and stale latest-state selection.
- Green phase: `env -u FORCE_COLOR node scripts/run-tests.mjs exec -- --test tests/kit/maintenance-management-activity.test.mjs tests/kit/maintenance-dashboard-v2-api.test.mjs`: 58 passed, 0 failed.
- Guarded actual dashboard browser run, `env -u FORCE_COLOR node scripts/run-tests.mjs exec -- tests/ui/dashboard-ui.mjs`: 514 passed, 0 failed. The new assertion inspects actual rendered table rows for a newer paused record and older completed records.
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`: passed.
- Focused ESLint: 0 errors, one pre-existing `max-lines` warning in `maintenance-api.mjs` (file has 1021 lines, threshold 1000).
- `git diff --check`: passed.

## Limits

- V4 B8 producer remains on its separate branch. This change is the consumer contract only, pending integration and independent review.
- Full unit and UI suites were not repeated after the final timestamp-validation refinement; focused unit tests, lint, and typecheck passed after it. The guarded browser run covered the Activity renderer before that refinement.

## Scoped review fix: impossible calendar dates

- Review found that the prior ISO shape plus `Date.parse` accepted `2026-09-31T12:00:00Z`, letting a paused row outrank a real September 30 completion and render on October 1.
- The Activity projection now checks the calendar day against its month and leap year, plus clock component bounds, before accepting a scan timestamp. The v2 Activity API uses the same validator for `recordedAt`.
- New cases reject September 31 and a non-leap February 29 at both projection boundaries, retain a valid completion timestamp when the recorded time is rejected, and retain a valid leap day with an offset and fractional seconds.
- Guarded focused tests: `env -u FORCE_COLOR node scripts/run-tests.mjs exec -- --test tests/kit/maintenance-management-activity.test.mjs tests/kit/maintenance-dashboard-v2-api.test.mjs` passed 61 tests after the validator change. The final fallback assertions were added afterward and rerun before this fix commit.
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit` passed. Focused ESLint had 0 errors and the existing file-length warning in `maintenance-api.mjs`.
- Browser and full suites were not repeated for this scoped validation fix; the prior guarded browser run remains the renderer evidence, with full gates assigned to integration.
