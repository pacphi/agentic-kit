# ADR-0042 — Retire Prompts capability from the mainline product

- **Status:** Accepted; implementation in progress
- **Date:** 2026-09-01
- **Deciders:** agentic-kit maintainers
- **Supersedes:** [ADR-0039](0039-prompts-intelligence.md) on the mainline release
- **Related:** [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0038](0038-consistent-cross-host-session-metrics.md)
- **Preservation ref:** `archive/prompts-capability-main-2026-09-01`
- **Pinned implementation:** `91e892f523f307ecb29271cb0e370b538115a2c0`

## Context

PR #187 combined two separable changes: cross-host session metrics (Matrix A)
and a Prompts/Coaching product surface. The latter added scan-time prompt
fingerprints, repetition clusters, personal baselines, three findings,
coaching and enrichment engines, private label/outcome stores, the
`ak usage prompts` command, and dashboard routes and controls.

The capability is useful experimental work, but it should not remain part of
the supported mainline product. Reverting PR #187 wholesale would also remove
the independently valuable Matrix A metrics and security/correctness fixes.
Rewriting published history would make the shipped implementation harder to
inspect and recover.

## Decision

1. Preserve the exact pre-removal main tree at commit
   `91e892f523f307ecb29271cb0e370b538115a2c0` and publish the named archive
   branch above. The archive remains buildable source, not a claim of current
   support on main.
2. Remove the Prompts capability from the mainline release with an ordinary,
   reviewable PR. Keep Matrix A, transcript reading, ordinary human-prompt
   counts, model lifecycle evidence, security hardening, private atomic writes,
   and pipe-safe output.
3. Advance the derived usage index from schema 16 to schema 17. Schema 16 is
   rejected wholesale and transcripts are re-derived without the retired
   `promptFPs` and `promptFPOverflow` fields. The migration creates no backup
   of the derived index because a backup would retain feature-only hashes and
   the source transcripts remain authoritative.
4. Leave `usage-prompt-labels.json` and `usage-outcome-ledger.json` untouched.
   They are owner-only compatibility state for the preservation branch. Main
   neither reads nor writes them. Any future purge must name the exact files,
   obtain explicit confirmation, and back them up first.
5. Restore the dashboard to GET-only operation. Remove Prompts UI, payload,
   sample, dismissal, and enrichment paths. A legacy `#usage/prompts` bookmark
   migrates to `#usage/score`; it is not reinterpreted as transcript id
   `prompts`.
6. Remove current-behavior documentation for the capability while keeping
   ADR-0039 and the archived design specifications as historical evidence.
7. Do not introduce a new DDD bounded context. This change retires a bounded
   capability and returns ownership to the existing Usage context; an
   additional domain model would create architecture for behavior that no
   longer runs.

## Operational migration

Schema 16 and schema 17 use the same default config path. A process started
from one branch keeps its loaded implementation even after Git switches the
checkout, and concurrent schema-16/schema-17 processes can repeatedly replace
the shared cache. Operators must stop old dashboard processes before switching
branches and use an isolated `XDG_CONFIG_HOME` for side-by-side verification.

Schema 17 does not claim to erase all prompt-derived information. Ordinary
prompt counts remain part of session analytics, and a session title may be the
parser's bounded first-prompt fallback. The two inert compatibility stores can
also retain derived labels, card prose, or coaching evidence metadata.

## Consequences

### Positive

- Main has one smaller, observation-only Usage surface with no opt-in inference
  path or coaching write route.
- The full implementation remains inspectable and recoverable without keeping
  it in supported releases.
- Cache migration has an explicit, testable privacy boundary and remains
  idempotent on a warm schema-17 cache.
- The change is reviewable as normal history; no force-push or mainline history
  rewrite is required.

### Costs and limitations

- The archive and mainline branches cannot safely share a live usage cache at
  the same time.
- Existing private label and outcome files remain on disk until the owner
  explicitly chooses to purge them.
- Links and scripts that call `ak usage prompts` or `/api/prompts/*` break
  deliberately; only the dashboard bookmark receives a compatibility redirect.
- Restoring the feature later is a new product decision, not an automatic
  merge of the archive branch.

## Verification required before implementation status

- The archive branch resolves locally and remotely to the pinned commit.
- `ak usage prompts` and its former flags fail before transcript reads or
  writes, and help no longer advertises them.
- Schema 16 is reparsed into schema 17 without either retired fingerprint
  field; a second read is a warm-cache hit.
- `/api/usage` has no `prompts` member; removed GET routes return 404 and POST
  remains 405.
- The dashboard bundle has no Prompts view, but a stale bookmark lands on the
  Scorecard.
- Matrix A, masking, transcript attribution, model lifecycle, private atomic
  writes, and output draining continue to pass their regression suites.
- Active docs describe current mainline behavior; historical detail remains in
  ADR-0039 and the archive.
