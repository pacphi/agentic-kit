# Fleet evidence export and aggregation

`ak telemetry` exports a consistent, vendor-neutral subset of local usage and retained maintenance
evidence. It works without the dashboard, a service account, a collector, or a network connection.
The versioned contract is intended for your own ingestion pipeline, reporting system, or archive.
It does not export all local databases or raw transcripts.

## Export and aggregate

On each installation:

```bash
ak telemetry export --days 30 --output ./machine-a-2026-09-20.json
ak telemetry validate ./machine-a-2026-09-20.json
```

Transfer the files using your organization's approved mechanism. On the aggregation machine:

```bash
ak telemetry aggregate ./machine-a-2026-09-20.json ./machine-b-2026-09-20.json \
  --as-of 2026-09-20T23:59:59.000Z --output ./fleet-2026-09-20.json
```

Without `--output`, commands print JSON to stdout. With it, they create a new file with POSIX mode
0600 and refuse an existing destination, including a symlink. Windows permissions follow the
account/directory ACL; POSIX modes do not establish a Windows ACL guarantee. Parent directories must
already exist. Use unique filenames when scheduling exports; this command does not install a job,
retain an export history, send data, or retry uploads. `--output` avoids shell redirection's default
permissions and truncation behavior.

All successful machine output is JSON. `validate` prints `{valid:true,schemaVersion,snapshotId}`.
Failure returns exit code 2 and a generic stderr message without repeating private paths or input.
A successfully exported snapshot can contain unavailable source sections; success means the
contract was produced, not that every source was healthy. Inspect its coverage fields.

## Discover the contract

```bash
ak telemetry schema       # JSON Schema, draft 2020-12, for snapshot admission
ak telemetry metrics      # metric units, evidence basis and aggregation rules
```

The executable schema is [schema.mjs](../src/lib/telemetry/schema.mjs). The reference admission and
reducer are [contract.mjs](../src/lib/telemetry/contract.mjs) and
[aggregate.mjs](../src/lib/telemetry/aggregate.mjs). Third-party importers must check the schema,
content digest and the semantic invariants enforced by `validateSnapshot`; JSON Schema alone does
not establish digest validity, unique record identities or cross-field evidence consistency.

Version 1 requires its exact field set: unknown fields and versions are rejected. Breaking or
additive wire changes require an explicitly supported new contract version; internal Usage cache
schema changes do not change this contract automatically. Canonical timestamps are UTC with
milliseconds: `YYYY-MM-DDTHH:mm:ss.sssZ`. Files and combined aggregate input are bounded to 64 MiB;
an aggregate accepts at most 256 snapshots. A snapshot admits at most 100,000 sessions and 100,000
receipts. Exceeding bounds fails instead of silently truncating evidence.

### Snapshot envelope

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `kind` | `1`, `agentic-kit.telemetry.snapshot` |
| `snapshotId` | SHA-256 over canonical JSON of the envelope excluding `snapshotId` |
| `installationId` | Random UUID for one user/environment installation |
| `generatedAt`, `producerVersion` | Collection reference time and agentic-kit package version |
| `selection.days` | Integer 1–365; defaults to 30 |
| `selection.scope` | `whole-retained-sessions-selected-by-end` |
| `usage` | Session observations, source health, acquisition completeness and pricing date |
| `inventory` | Available retained scan counts and its original capture time, or nulls |
| `maintenance` | Retained receipt references and controlled states, or unavailable |

Canonical JSON recursively sorts object keys lexically, preserves array order and uses JSON string
and number encoding without whitespace. Export sorts session/receipt arrays by their opaque IDs.
The digest detects changes, **not authenticity**. It is not a signature or compliance attestation.
A receiver must authenticate senders and map installations to authorized organizations separately.

### Data and metric semantics

Every session reference is qualified by execution host (`claude`, `codex`, `opencode`) before
pseudonymization. Hosts are not inference providers. Provider/model strings, repository labels and
prompt fingerprints are deliberately absent from this initial contract.

| Fields | Unit and interpretation |
| --- | --- |
| `input`, `output`, `cacheRead`, `cacheWrite` | Token counts from existing normalized host parsers; reasoning output is not added again |
| `prompts`, `responses` | Normalized transcript activity counts; not task success or productivity |
| `exceptions`, `aborts` | Observed parser counters; not a complete count of tool failures or security events |
| `observedCostUsd` | Source-reported USD, not reconciled invoice spend |
| `estimatedCostUsd` | API-equivalent USD using local pricing; never presented as billing |
| `observedCostMessages`, `estimatedCostMessages`, `unpricedMessages` | Coverage for the distinct cost bases |
| `latencyBuckets` | Six non-cumulative response-latency counts with inclusive upper bounds 2, 5, 10, 30, 60 seconds, then overflow |
| `inventory.resources`, `inventory.placements` | Last retained inventory counts, not a fresh machine scan |
| `maintenance.receipts` | Retained action receipt references, status codes and last update timestamps |

Missing values remain `null`; measured zero remains zero. When the source carries no usage-message
evidence (including a replay-excluded record), token counts are null. Unknown future receipt status
codes become `unknown`. Unreadable/integrity-failed journals remain `unknown-recovery-required`.
The absent or unverifiable inventory store is `unavailable`, not an inventory containing zero items.

`usage.sourceHealth` reports each transcript source and the Codex ledger independently. These are
collection facts, not integration runtime health. `acquisitionComplete` reflects the existing
index's bounded-acquisition signal only; it does not prove every possible session was discovered.
An unavailable source can coexist with retained session observations. Pricing dates can differ
between installations and are retained per installation in the aggregate.

## Correct fleet aggregation

The reference reducer selects the newest **whole snapshot per installation** before computing any
metric. It accepts identical retries. Different content at the same installation timestamp is a
conflict; supply a corrected later snapshot, never arbitrarily pick an input ordering. Different
lookback selections are rejected, including among superseded inputs. Future snapshots relative to
`--as-of` are rejected. Fix the clocks or use an appropriate explicit as-of time.

The aggregate's `kind` is `agentic-kit.telemetry.aggregate`, with schema version 1. It contains:

- `selection`, `asOf`, `staleAfterSeconds` and `installationCount`;
- `installations`: selected snapshot identities, collection age/staleness, source coverage,
  pricing date, original inventory capture timestamp/age and maintenance availability;
- `usage.metrics`: each metric's `{value, measured, missing}` across selected session observations;
- `usage.sessionObservations`, available/unavailable/incomplete installation counts;
- `usage.cacheReadShare` and its numerator, denominator and measured/missing session counts;
- `usage.latency`: bucket counts, second-based upper bounds and measured/missing session counts;
- `inventory`: resource and placement `{value, measured, missing}` across installations;
- `maintenance`: available/unavailable installations, retained receipt count and counts by status.

All-missing metric contributions yield `value:null`, even when no session was retained. Empty source
arrays alone cannot distinguish no activity from unavailable evidence, so retain the coverage fields.
Counts of sessions and receipts are installation-scoped observations, not global unique tasks.

Cache-read share is `sum(cacheRead) / sum(input + cacheRead + cacheWrite)`, using only sessions with
all three known counts; a zero denominator yields null. Percentages and machine percentiles are
never averaged. Latency buckets are summed by position, with null when no histogram is available.
Token and count sums preserve safe integers; arithmetic overflow fails. USD totals are rounded to
six decimal places. No fleet operator-hours metric is supplied because concurrent sessions across
machines cannot establish unique human engagement.

Repeated 30-day exports do **not** provide disjoint 30-day increments. The source retains whole
sessions selected by their end time, so a selected session can include older tokens. Files can be
collected at different times; `asOf` does not reconstruct an atomic fleet instant. A newer snapshot
replaces all older sections, even when a source has become unavailable or a session disappeared.
Consumers needing historical trends should store these dated snapshots as separate as-of views.
Do not sum successive views or carry forward old rows as if they were current.

`--stale-after` defaults to 86,400 seconds and accepts 1–31,536,000. Stale installations remain in
totals and are flagged; inventory has its own capture age. There is no expected-machine roster, so
an installation that never reports is absent rather than silently counted as healthy.

## Identity, privacy and operations

First explicit export creates `telemetry/identity.json` under agentic-kit's platform config
directory, alongside `kit.json`. It contains a UUID and a random 256-bit HMAC key. The directory
and file are owner-private on POSIX. Existing unsafe, linked or corrupt state is rejected; it is
never silently regenerated. Keep it across upgrades, back it up privately, and restore the original
if damaged. Do not include it in telemetry or clone it to other machines. Losing it creates a new
identity on the next export and requires the receiver to retire the old installation explicitly.

Session/receipt references use HMAC-SHA256 with separate domains. These pseudonyms permit linking
exports from the same installation; they are not anonymous evidence. Copies of the same transcript
on separate installations cannot be deduplicated automatically. An ingestion system must account
for clones or choose an authoritative source when fleet-wide unique activity matters.

The allowlist excludes raw prompts, responses, paths, filenames, hostnames, usernames, commands,
configuration, environment values, free-form errors and credentials. Export refreshes the existing
local Usage cache and reads retained Maintenance stores. It does not inspect arbitrary repository
files, export databases, start scans, execute host probes or bootstrap experimental adapters.

Detailed authorization, policy decisions and verification remain in the existing maintenance
receipts; this telemetry summary is not their replacement. Use `ak maintain receipt --receipt ID
--export --json` locally when an authorized audit requires a detailed sanitized receipt. Enforce
organization mapping, transport encryption, access controls and retention at your receiver. No
network destination, scheduler, upload queue or vendor dashboard is bundled.

Architecture and implementation evidence: [ADR-0054](adr/0054-fleet-evidence-export.md).
