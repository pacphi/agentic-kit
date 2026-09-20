# ADR-0054 — Vendor-neutral fleet evidence export

- **Status:** Implemented
- **Date:** 2026-09-20
- **Updated:** 2026-09-20 — snapshot export, admission, aggregation, CLI and documentation delivered;
  local regression/static/package gates passed on `feat/fleet-evidence-export`.

## Context

Operators need consistent data across agentic-kit installations without a vendor dashboard.
Existing CLI JSON and dashboard projections are local presentation contracts, not additive fleet
records. ADR-0009 and ADR-0012 are Implemented; ADR-0048 remains Accepted with its existing
human-evaluation and cross-platform gates. This decision does not resolve those gates.

Usage selects whole retained sessions by end time. Tokens may precede the lookback boundary.
Repeated rolling-window totals must never be summed. Receipts and inventory have different
retention and freshness. Missing evidence is not a measured zero.

## Decision

Introduce a Telemetry bounded context under `src/lib/telemetry/`, with a public version-1 JSON
snapshot contract, strict admission, an explicit metric catalogue, and a reference reducer.
`ak telemetry export` collects local evidence independently of the dashboard; `validate`,
`schema`, and `aggregate` operate offline. Export itself makes no network request and never
executes integration probes or starts maintenance scans.

Each installation gets a random UUID and a private HMAC key on its first explicit export.
The identity belongs to a user/environment installation, not physical hardware or a person.
Session and receipt references are domain-separated HMACs. No hostname, username, paths,
repository names, prompt text, model/provider free text, commands, errors, configuration, or
credentials enter the contract. No raw data dump is provided. The installation identity file
must not be copied to another installation; retain it across upgrades. Deleting it starts a new
identity. The aggregate cannot automatically recognize copied transcripts on different machines.

Snapshots contain:

- Producer version, collection timestamp, installation identity, content digest, selection scope.
- Usage: host-qualified session references, nullable token totals, prompt/response/error/abort
  observations, separate observed and API-equivalent estimated USD, cost coverage counters,
  mergeable response latency buckets, source health, acquisition coverage and pricing date.
- Inventory: last retained capture time and resource/placement counts; unavailable stays null.
- Maintenance: retained receipt references and controlled status codes. Integrity failures remain
  recovery evidence; the export is not a signed compliance attestation or complete audit archive.

These are observations, not proof of user identity, authorization, runtime success or billing.
Unknown source fields are discarded by allowlist projection. Unknown wire fields and schema
versions are rejected on admission. Content hashes detect alteration but do not authenticate
senders; a receiving system supplies organization membership, access controls and authentication.

## Aggregation rules

Select the newest whole snapshot per installation, never merge old and new partial sections.
Identical re-delivery is idempotent. Conflicting content at the same installation timestamp is
an error, independent of input order. Require identical schema and lookback selection. Sort
outputs deterministically. Missing sessions in a newer snapshot do not resurrect from an older
snapshot. Aggregation is an as-of view of supplied installations, not a longitudinal ledger.

Sum session counters only after snapshot replacement. Emit measured contribution sums together
with measured/missing counts; all-missing measures remain null. Preserve observed and estimated
cost separately. Compute cache-read share from summed numerator and denominator, never averaged
percentages. Sum fixed non-cumulative latency bucket counts; do not average percentiles. Omit
operator engaged time because concurrent work across installations cannot establish unique human
hours. Report source health, incomplete acquisition, collection age and inventory capture age.
Without an external expected-installation roster, absent machines cannot be called healthy or
counted as reporting. Reject future snapshots relative to the aggregator's explicit as-of time.

## Alternatives

1. Scrape dashboard JSON: low effort, but ties collection to browser lifecycle and unstable private
   projections, with no fleet identity, deduplication or export privacy boundary.
2. Ship a network daemon and OTLP transport now: adds credentials, retry queues and service lifecycle
   before a stable domain contract exists. Defer transport; scheduled exports and external ingestion
   can consume the same contract without a built-in remote destination.
3. Selected: self-contained snapshots and deterministic local aggregation. Simple recovery and
   replay semantics; larger payloads and no automatic delivery or cross-machine transcript dedup.

## Validation and limits

Contract tests exercise allowlist privacy, null/zero, immutable input, digest validation, strict
versions/fields, bounded file reads, hostile paths/symlinks, duplicate/reordered delivery,
replacement, conflicting ties, selection mismatch, stale/future input, and histogram arithmetic.
Adapter tests use existing parsers with synthetic local stores. CLI tests isolate home/config roots.
Static, build and repository regression gates must pass before marking this ADR Implemented.
No vendor integration, autonomous upload, scheduler, machine enrollment, remote control, raw
transcript export, financial billing reconciliation or complete historical audit claim is included.

## Implementation evidence

Implemented by the Telemetry modules, CLI dispatch and shared retained-inventory read bounds.
Local verification on Node v26.4.0, macOS arm64:

- 56 focused telemetry/source-bound tests passed; 99.81% telemetry line coverage,
  93.81% branch coverage and 97.47% function coverage. Contract and private-store modules
  reached 100% line coverage; this is not a claim of exhaustive security verification.
- Full coverage-enforced suite: 4,230 passed, 6 existing skips, 0 failed, followed by all legacy
  suites passing. Overall measured coverage: 92.16% lines, 81.44% branches, 91.57% functions.
- Type checking, lint, complexity gate, markdown lint and build/package checks passed.
  Lint retains repository warnings (70 general and 3 complexity-gate warnings), with zero errors.
- Independent read-only review found counter rounding, timestamp-schema mismatch, CLI parser
  error echo and unbounded retained inventory reads; regression tests and fixes address each.
- AQE execution returned internally inconsistent results without actionable diagnostics;
  it supplies no passing assurance here. Direct Node test results are the validation authority.
- Synthetic 10-installation / 10,000-session aggregation: approximately 52 ms per measured run,
  3,546,741 input JSON bytes. This is one local workload, not a fleet service guarantee.

Windows/Linux execution, remote transport and authenticated fleet enrollment are not claimed.
The original Maintenance acceptance gates remain unchanged. No commit or publication was performed.
