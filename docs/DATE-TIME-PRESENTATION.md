# Date and time presentation

**Audit date:** 2026-09-04  
**Status:** contract adopted for System session identity; remaining surfaces are recorded below

The dashboard should feel like one application even though its views were built at different
times. This contract separates four values that look similar on screen but cannot be formatted by
one interchangeable helper.

## Presentation contract

| Semantic value | Presentation | Accessibility and machine value |
|---|---|---|
| Instant | Browser locale and browser timezone. Compact rows include date, year, and minute; disclosure adds seconds and timezone. | Use `<time datetime="normalized-ISO-instant">`. Relative-only text must disclose the exact instant on focus or hover. |
| Relative instant | `just now`, minutes, hours, or days only where age/freshness is the question. Future clock skew must not be silently clamped to now. | Preserve the exact instant for assistive technology and disclosure. |
| Duration | Elapsed units such as `22h 52m`; never feed a duration through `Date`. | Plain text with its unit; source remains a duration scalar. |
| Calendar date or bucket | Keep the producer's date-only value. Do not convert through UTC or shift it into another day. | Use `<time datetime="YYYY-MM-DD">` when it names a day. |

Unknown and invalid values say **Time not recorded** or a field-specific equivalent. They do not
render as zero, epoch, the current time, or an empty cell. A fallback must name its different
meaning—for example, **Last active** for file mtime instead of **Started**.

`src/lib/dashboard/client/datetime.mjs` is the browser bundle's canonical exact-instant formatter.
It intentionally leaves locale and timezone unspecified so `Intl.DateTimeFormat` uses the reader's
browser settings. Tests inject locale and timezone only to make expectations deterministic. Native
session IDs remain opaque; shortening is presentation only and never parsing.

## UI audit

| Surface | Current behavior | Finding / remediation |
|---|---|---|
| System > Sessions | Localized date and time, shortened native ID, exact focus/hover disclosure, `<time datetime>`, explicit last-active fallback | Conforms in this change. |
| System header and project freshness | Uses the shared `ago(seconds)` helper | Keep relative age, add exact localized disclosure, and move to the canonical relative-instant helper. |
| System > Maintenance preview expiry | Browser-local `toLocaleString()` | Use the exact-instant helper and `<time>`; retain the explicit validity wording. |
| Usage > Limits reset and Sessions start | Separate partial `toLocaleString()` formats omit year and timezone | Replace with the canonical exact-instant formatter; disclose timezone where space is constrained. |
| Usage > Models | Some change times are localized, while source capture and snapshot times render raw ISO-like strings | Normalize all true instants through the exact-instant helper; keep provider date-only release/rate dates as calendar dates. |
| Usage > Context attention | Converts a session start through UTC and slices `YYYY-MM-DD` | Fix first: this can display the wrong local calendar day. Format the instant locally, or preserve a producer date-only field when that is the actual type. |
| Observability > Live | Has its own relative helper; playback shows time-of-day without date or timezone | Reuse canonical relative and exact helpers. Review/history playback needs the date and an exact disclosure. |
| Admin telemetry | Uses an intentionally compact UTC/relative vocabulary in a separate page | Preserve UTC where operationally intentional, but add a visible UTC label and machine-readable instant before sharing helpers. |
| Charts and storage growth | Raw `YYYY-MM-DD` day buckets | Treat as calendar buckets; do not timezone-shift them. Improve localized axis labels without changing bucket identity. |

## Remediation order

1. Fix the Usage Context UTC day-shift risk and raw Model lifecycle instants.
2. Consolidate dashboard exact-instant and relative-instant helpers, preserving durations and
   calendar buckets as distinct APIs.
3. Add focus/hover exact disclosure and `<time>` markup wherever compact relative text remains.
4. Audit narrow layouts and screen-reader names after each surface moves; a formatting refactor is
   not complete if the exact value becomes unreachable.

This is an audit and contract, not evidence that every listed surface has already been migrated.
Keeping that distinction explicit prevents a broad mechanical rewrite from silently changing date
semantics.
