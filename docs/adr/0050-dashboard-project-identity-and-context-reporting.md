# ADR-0050 — Dashboard project identity and context reporting

- **Status:** Implemented
- **Date:** 2026-09-09
- **Related:** [ADR-0036](0036-dashboard-client-modularization-and-shared-loopback-server.md),
  [ADR-0048](0048-inventory-led-maintenance-resource-management.md)

## Problem and boundaries

Projects can be Git checkouts, linked worktrees, other folders, or unavailable
working directories. Session launch origin is independent: Desktop sessions can
use any of these locations. Treating Desktop and Git as competing project types
loses information. A remote URL alone cannot prove that two checkouts share Git
administration or that a session came from Desktop.

Overview also rendered Codex configuration and per-model limits as separate
cards. That repeated labels while making cached capacities look comparable to
session usage. Claude, Codex, and OpenCode expose different evidence and controls.

## Project decision

Canonical working paths retain their existing identities. Verified Git common
directories establish repository groups; linked worktrees require a readable
Git pointer, common directory, and matching reverse pointer. Missing or malformed
metadata remains unknown. Bare repositories need no invented main checkout.
Independent clones sharing a remote do not become a worktree group.

Session origin comes from bounded transcript metadata, separate from the existing
`origins` discovery-method field. Exact recognized declarations are:

- Claude `entrypoint`: `claude-desktop`, `claude-desktop-3p`, `remote_desktop`.
- Codex `session_meta.originator`: `Codex Desktop`, `codex_work_desktop`.
- Everything else, including ambiguous SDK and VS Code markers: unknown.

These are source declarations, not attestation of the initiating application.
Claude's installed 2.1.266 runtime maps those entrypoints to Claude Desktop;
Codex values were observed in local bounded session metadata. No prompt content,
user project names, or private transcript examples are included in this document.
Desktop history outside the configured discovery roots remains outside coverage.
Origin count basis distinguishes transcript files, database sessions, recovered
project sightings, and mixed observations; UI badges show membership only.

The System Projects default keeps its existing measured population. An additive
lightweight discovery catalog exposes excluded and missing paths without adding
expensive disk walks. The all-discovered view joins measurements by path, so each
path appears once. Unknown measurements are not zero. Existing ever-seen/on-disk
counts remain unchanged. Rows retain their details without repeated directory-path
headings. Disk and LOC are not
summed across overlapping parent/child paths.

Maintenance project cards preserve their installation counts and navigation.
Repository groups and Desktop-origin filters use separate dimensions. Only known
Desktop qualifiers appear on cards; unclassified entries remain in the filter.
The fallback heading is Other projects, without repeated uncertainty or technical
explanations on each card. Cards show
folder icon with name, the sidebar's same kind icon/label, then all detected
language icons in a wrapping row. Language icons distinguish source-line evidence
from artifact detection in their accessible labels. Installation count and
navigation arrow remain on the right.

## Context research and decision

| Concept | Claude | Codex | OpenCode |
| --- | --- | --- | --- |
| Model capacity | Evidenced cached Anthropic catalog limits | Native default and maximum in cache | Evidenced provider catalog limits |
| Kit-owned context control | None | Opt-in `model_context_window` request | None |
| Configured session request | Not inspected | Read from native configuration | Not inspected |
| Calculated usable window | Unknown here | Allocation × effective percentage, verified profile only | Unknown here |
| Usage evidence elsewhere | Historical input; optional statusline sample | Paired token-count input/window | Historical message input/cache components |
| Actual compaction threshold | Unknown here | User scalar retained; runtime/scope unverified | Unknown here; version-dependent controls |

Codex inspection remains limited to the verified 0.153.4 profile, fresh dated
cache (seven-day maximum), native OpenAI provider and supported catalog. A request
clamps to each model's maximum before the effective percentage is applied.
An advertised API maximum is not a session allocation. Inspection time and cache
capture time are separate fields. Unknown values remain null.

Claude's statusline can expose session window, input/cache components, and
percentages. The existing kit tee is conditional on rate-limit data, throttled
to one write/minute, and retains only the most recent writer. This change does
not promote that sample into fleet-wide live context. Claude's compaction-window
override can differ from its statusline denominator.

OpenCode V1 documents `auto`, `prune`, and `reserved`; V2 documents `auto`,
`keep.tokens`, and `buffer`. Kit does not claim to inspect or manage either set.
Codex additionally documents compaction counting scope; kit's retained scalar
alone does not establish the active scope or runtime trigger.

Use **one compact Context configuration card with host-specific rows**, plus
expandable bounded model tables where cached capacity evidence exists. Native
control documentation is linked per host; only Codex currently has kit-managed
context ownership. This avoids repeated usage placeholders and long explanations. A shared nullable report names host, management state, source,
inspection/capture times, model values, usage, compaction, and limitations.
The existing model-inventory snapshot supplies Claude/OpenCode capacity and output
limits (and Codex fallback catalog limits). Each numeric field requires matching
source and scope evidence. Stale observations stay marked stale; catalog capacity
never becomes an effective session window. At most 100 valid models per host
render, with omitted count and navigation to the complete inventory. No refresh
commands or network API calls run during dashboard polling. No capacities are summed. The original CLI rows and repair instructions remain;
the dashboard groups them for display and preserves warnings.

Usage → Context remains the historical pressure view. Only paired input/window
observations establish pressure. Cached Codex input is a subset, not an extra
quantity to add. Kit's 60/70/75% recommendations are policy thresholds, not native
host compaction controls. This change does not reconfigure any host.

## Authoritative references checked

- [Claude statusline](https://code.claude.com/docs/en/statusline)
- [Claude environment variables](https://code.claude.com/docs/en/env-vars)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [OpenCode configuration](https://opencode.ai/docs/config)
- [OpenCode V2 compaction](https://opencode.ai/v2/docs/compaction)

Research performed 2026-09-09 against documentation and existing integrations.
Future host versions require renewed evidence rather than inferred parity.

Claude is not inherently missing context controls: `/model`, `[1m]` selection,
`/autocompact`, `--autocompact`, and persisted `autoCompactWindow` are native
surfaces. The compaction window is bounded by the model window. Its Models API
also exposes nullable capacity/output metadata; API entitlement does not prove
Code session entitlement. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` corrects assumed
windows for gateway/custom model IDs, rather than providing a universal maximum.
OpenCode exposes `/provider`, `/config/providers`, and `/config` HTTP reads,
`models --verbose --pure` catalog reads, and per-model `limit` configuration.
These controls are not interchangeable with Codex's verified per-model clamp.

- [Anthropic Models API](https://platform.claude.com/docs/en/api/models/list)
- [OpenCode server API](https://opencode.ai/docs/server)
- [OpenCode provider limits](https://opencode.ai/docs/providers)

Extending kit-owned writes to another host would require a separate native
configuration ownership/restoration contract. This reporting change performs no
host configuration writes.

## Intelligence picker

The native select uses alphabetized optgroups for Git repositories, Git worktrees,
User-level learning, and Other/unclassified locations. Option labels contain only
learning-location names; origin metadata is retained without tying the learning
store to the host that initiated a session.
User-level classification requires exact home or configured host-state roots.
The existing cached census supplies metadata; no additional transcript scan is
performed for the picker. Values, selected key, initial recency choice, learning
paths, and history remain unchanged. Names and UUID-like labels do not establish
origin. Native select keyboard behavior and optgroup semantics are retained.

## Machine-wide Intelligence table

The table uses the picker's same four learning-scope categories, alphabetized
within each. Metadata comes from the existing project entries, not a label join.
Each subgroup retains all rows in a keyboard-scrollable region with five visible
rows; the surrounding table area is bounded. The layout stacks on narrow screens.
The hero totals and underlying learning population remain unchanged.

## Historical context coverage

Usage Context reports recorded session observations, separately from Runtime's
cached model configuration. Claude transcript usage fields supply input/cache
tokens but not a paired window. Claude's native statusline supplies a true pair,
but the existing quota cache retains only one latest payload and is conditional
on quota data; it cannot establish historical coverage for other sessions.
Codex records with paired token-count fields establish pressure; cumulative-only
or older records do not. OpenCode's sessions may simply fall outside the selected
timeframe; its recorded message tokens do not establish the runtime window.

The cards distinguish input-only records, partial paired coverage, no recorded
measurements, and no sessions. Missing numeric evidence displays as an em dash,
not zero. The count is labelled Sessions with pressure because it counts sessions
with a pair, rather than individual telemetry samples. A meter appears only for
a measured pressure value; otherwise the card states that pressure is unmeasured.

Future Claude coverage could use bounded per-session statusline snapshots with
session/model/time identity. OpenCode would require validated request/response
correlation across retries and model switches. Neither is implemented here, and
model catalogs are not substituted for historical runtime windows.

## Usage Score projects

An additive `gitProjects` projection ranks discovered Git projects using exactly
the sessions admitted by the existing time/host filters. Existing `byProject`
and overall totals remain unchanged. Parse-time metadata carries opaque working
and repository identifiers; display names never establish repository identity.
Git observations describe the filesystem at parse time, with timestamps.
Repository inspection is bounded and memoized; rendering performs no filesystem
inspection.

The panel shows a simple top 10 by spend, with plain names and cost/session/time
values. Verified worktree spend rolls into an existing parent Git project.
Standalone worktrees, exact user-level roots, bare repositories without a parent
checkout, and unclassified directories do not appear in the ranking. There are no
expanded group lists or Desktop suffixes. Overall Usage totals retain activity
excluded from these ten rows. Older payloads request a usage refresh instead of
guessing Git membership from labels.

Usage index schema 20 rebuilds the derived cache once to recover metadata missing
from the previous release. This reads retained records without changing originals.
Subsequent reads use incremental cached observations.

## Verification

Focused tests cover repository association, unknown metadata, origin attribution,
count preservation, cache/configuration semantics, and display grouping. Browser
fixtures cover populated/empty/unknown states, keyboard filtering/navigation,
wrapping language icons, bounded model-table height, and responsive layouts.
Screenshots and final validation are recorded in the pull request.
