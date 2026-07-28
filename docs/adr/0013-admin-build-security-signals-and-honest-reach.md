# ADR-0013 — Admin: build/security signals, an honest Reach panel, and a pagination fix

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** agentic-kit maintainers

## Context

ADR-0007 shipped `ak x admin` as a loopback, deliberate-egress maintainer console answering "how is
this project actually doing" from GitHub + npm. A follow-up audit (live queries against the real
`pacphi/agentic-kit` repo, with the same token the admin server itself resolves) found the page
answered that question less completely than it could:

1. **Two of the four Reach hero tiles were permanently dead for this project.** "bundle downloads"
   and "newest release pulls" read from GitHub release **assets**. agentic-kit ships exclusively via
   npm — verified live, 0 of 29 releases carry any asset — so both tiles rendered `—` forever. That
   is correct behavior per the model's "unknown is not zero" rule (ADR-0007 §4.1), not a bug, but it
   is dead screen real estate for this project's actual distribution channel.
2. **`admin-collect.mjs` capped the releases fetch at `per_page=20`** while the "bundle downloads"
   tile's own copy claimed "lifetime, **all releases**." The repo already has 29 releases; the oldest
   9 were silently dropped from both the releases list and `totalAssetDownloads`. Harmless today only
   because no release carries assets — the moment one does, the label becomes false with no
   truncation indicator.
3. **No CI/build health or security-alert signal reached the page at all**, despite `ci`/`release`
   GitHub Actions workflows running on every push and Dependabot maintaining the dependency tree —
   both directly answer "how is this project doing" and both were one more `Promise.all` entry away.
4. **Two already-collected fields were invisible in the UI**: `repo.watchers` (GitHub subscriber
   count) was computed in the collector and never rendered; `npm.lastWeek`/`npm.lastMonth` were
   computed and only ever consumed as a trend-arrow input in Momentum, never shown as an absolute
   number anywhere.
5. On point 4's npm figures specifically: `admin-view.mjs` already carried a **deliberate** decision
   to keep npm's absolute download count out of the Reach panel, because `npm downloads are dominated
   by mirrors` (CI runners, cache warmers, and registry mirrors re-pull as often as a real install,
   and `api.npmjs.org` cannot distinguish them). That rationale was correct but stated in one
   half-sentence buried in a footnote — worth stating as its own first-class, explicit entry so a
   maintainer reading the Gaps tab understands *why* npm never appears as a reach number, not just
   that it doesn't.

## Decision

### 1. Fix the releases pagination bug

`admin-collect.mjs` now fetches `/releases?per_page=100` (GitHub's per-request ceiling), matching the
same single-page-best-effort cap already used for issues/stargazers/forks in this file. This is a
correctness fix, not a new pagination system — the file's existing house pattern (one page, capped at
100, no further pages followed) is extended consistently rather than reinvented. The 100-item ceiling
is now called out in a code comment at the fan-out site so a future reader does not mistake it for
full pagination.

### 2. Replace the two dead Reach tiles with real, GitHub-native people signals

"bundle downloads" and "newest release pulls" are replaced with:

- **contributors** — `GET /repos/{slug}/contributors`, count only. A genuinely different circle from
  "people who filed issues/PRs" (buildPeople's `people.contributors`): this counts who has code in
  the tree via GitHub's own merge history.
- **watching** — `repo.watchers` (already collected, previously unrendered). A standing-interest
  signal distinct from a one-time visitor.

Both stay inside GitHub's own numbers, so neither reopens the mirror-inflation problem npm carries.
The npm absolute-download question raised by point 4 was decided explicitly: **npm downloads still do
not appear in Reach.** The existing exclusion was correct; only the messaging around it was thin (see
Decision 4).

### 3. A new "Project health" section: latest CI run + open Dependabot alerts

A new subsection in the Overview panel, fed by two more `Promise.all` entries:

- `GET /repos/{slug}/actions/runs?per_page=5` → latest run's `{name, status, conclusion, at, url}`
  plus a failure count over the fetched page. No runs found renders `—`, never a fabricated
  "passing" (the same unknown-is-not-zero discipline as everywhere else in this file).
- `GET /repos/{slug}/dependabot/alerts?state=open&per_page=100` → open alert count. This endpoint
  needs a token with `security_events` scope (classic PAT) or equivalent fine-grained access; an
  unconfigured or under-scoped token 403s, which `ghJson` already folds to `null` — the tile
  degrades to "unknown" with an explanatory `why`, never a false "0 alerts."

Both are additive `Promise.all` entries in the existing single fan-out (ADR-0007 §3) — no new
request pattern, no new auth flow, no new caching layer.

### 4. Make the npm mirror-inflation rationale a first-class, explicit statement

The Gaps tab (ADR-0007's "honesty section") gains a `design`-tagged entry stating plainly that npm
download counts are shown as **trend only, never as a reach number**, and why: mirrors/CI/cache
warmers are indistinguishable from real installs in npm's own data, so an absolute total would
overstate reach. The Reach panel's footer note and the Momentum tile's note are both tightened to
carry the same point concisely rather than as an aside.

## Consequences

- `admin-collect.mjs`'s single `Promise.all` grows from 9 to 12 entries: `contributors`,
  `actions/runs`, `dependabot/alerts` join the existing set. All three follow the file's existing
  discipline — internally try/caught, degrade to `null`/empty on any failure, never reject the batch,
  never appear in the payload if the credential is absent from the request itself (contributors and
  CI runs work unauthenticated on a public repo; Dependabot alerts do not and degrade honestly).
- The payload contract gains `contributorsCount` (number|null), `ci: {latest, recentFailures,
  recentTotal}`, and `security: {dependabotAlerts}`. `defaultCollect`'s fail-soft path returns honest
  empty values for all three so a thrown collector error still yields a renderable payload.
- The Reach panel's four tiles are now: unique repo visitors (hero), contributors, watching, opted-in
  installs (still an honest gap) — all either real headcounts or an explicit "not built" admission,
  none permanently dead for this project's npm-only distribution model.
- `tests/admin.test.cjs` gained fixtures and assertions for the three new endpoints, including the
  same never-fabricate-a-zero discipline tested elsewhere (Dependabot 403 → `null`, no workflow runs
  → `ci.latest: null`, a failing contributors fetch nulls only `contributorsCount`) and an explicit
  assertion that the releases fetch requests `per_page=100`.
- `admin-model.mjs` is unchanged — every new field renders through the existing `metric()` helper, so
  the pure-model import-nothing constraint (ADR-0007 §5) is untouched.

## Alternatives considered

- **Show npm absolute downloads as a Reach tile instead of GitHub-native signals.** Rejected: it
  would reintroduce exactly the mirror-inflation overstatement the original design deliberately
  avoided (Context, point 5). GitHub-native signals (contributors, watchers) answer the same "kill
  the dead tiles" goal without that risk.
- **Full pagination (follow `Link` headers) for releases/issues/stargazers/forks/contributors.**
  Rejected for now: none of these currently exceed the 100-item cap for this repo, and full
  pagination is a larger, inconsistent change against the file's established one-page-best-effort
  house pattern. The 100-item ceiling is now documented in code rather than silently assumed; revisit
  if/when any list genuinely exceeds it.
- **Cache GitHub/npm responses between polls (ETag/`If-None-Match`) to cut request volume on
  auto-refresh.** Out of scope for this ADR — freshness-over-caching is ADR-0007's explicit contract
  (`Cache-Control: no-store` on every `/api/*` response), and today's request volume is nowhere near
  GitHub's rate ceiling. Worth its own ADR if auto-refresh usage patterns change that calculus.

## References

- ADR-0007 (maintainer admin: loopback telemetry with deliberate egress) — this ADR extends its
  collector/payload/Reach-panel decisions rather than superseding them.
- `src/lib/admin-collect.mjs`, `src/lib/admin-view.mjs`, `src/lib/admin-server.mjs`,
  `src/lib/admin-styles.mjs`, `tests/admin.test.cjs`.
