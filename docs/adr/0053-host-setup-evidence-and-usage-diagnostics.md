# ADR-0053 — Qualified host health and separate usage diagnostics

- **Status:** Implemented
- **Release:** `4.0.0-alpha.50`; publication is verified through the matching GitHub release and npm registry artifact
- **Date:** 2026-09-20
- **Updated:** 2026-09-20 — record inclusion in `4.0.0-alpha.50`; replace setup-only badges with consistent local health and explicit provider connection checks for Claude, Codex and OpenCode
- **Amends:** [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md)
- **Related:** [ADR-0041](0041-host-neutral-hook-configuration-assurance.md), [ADR-0051](0051-supported-peer-delegation-and-host-realignment.md)

## Context

Usage acquisition once drove persistent branded host badges. One historical
Codex rollout could label the entire host degraded. The initial revision of this
ADR separated setup evidence, but left OpenCode unassessed and offered no actual
connection check. The user requested a qualified health check consistently for
all three hosts. This decision supersedes that setup-only contract.

## Decision

The persistent badge answers whether required checks passed at a stated level,
in the dashboard launch directory. Clicking it opens a keyboard-accessible dialog
with the level, project, timestamp, individual evidence and connection controls.
Usage date ranges and Intelligence project selection do not change this scope.

| Status | Meaning |
| --- | --- |
| OK | Required checks at the displayed level passed |
| Attention | A check established a concrete actionable failure |
| Checking | A requested check is running |
| Unknown | Required evidence is unsupported, ambiguous, inaccessible or timed out |
| Disabled | Host is intentionally outside the enabled kit setup |

### Local health

Automatic local checks cover executable launch, supported configuration inputs,
provider/model selection, applicable authentication setup, and known blocking
transport configuration. Native defaults are valid; optional files and tools are
not mandatory. Credentials are locally configured evidence, never proof of remote
validity, quota, model access or provider uptime. Tool execution and plugin runtime
behavior remain outside this local claim.

Native capabilities and recognizable result schemas gate probes, rather than
exact version equality. Unsupported contracts remain Unknown. Claude uses doctor
and structured authentication results plus local selection precedence. Codex uses
native configuration loading through MCP listing and login status, with supported
system/user selection projection; unresolved trust/profile overrides remain Unknown.
Its broader doctor invokes network/runtime checks and is not used automatically.

OpenCode reads bounded local JSON/JSONC layers, environment substitutions, provider
filters, selected default-agent/model fields and applicable credentials. Known
invalid nested configuration is actionable; unresolved remote organization config,
file references, selected agent Markdown or ambiguous native-default selection is
Unknown. Native debug/config startup is not called automatically: its upstream
implementation can install dependencies, update files and fetch remote config.

Each subprocess is bounded and emits only allowlisted states, reasons, versions
and model/provider selectors. Raw credentials and native diagnostic output never
enter the API. Local results have a 60-second single-flight cache. Observed file,
environment, executable and kit configuration changes invalidate cached evidence;
opaque keys use a per-server secret, not a public hash of credentials. Claude usage
bookkeeping does not invalidate otherwise unchanged integration configuration.

### Explicit connected checks

The dialog requires affirmative confirmation before sending a bounded inference
request. It discloses normal provider billing/context usage and native startup's
possible dependency, cache and session initialization. This is a user-triggered
native operation; polling never triggers inference or automatic repair.

The connection adapter has one absolute native-execution budget of at most 60
seconds, capped output, no retry, cancellation and process-tree cleanup. Local
revalidation occurs before and after the native check. A fresh nonce challenge
and a recognized successful completion are required; exit zero alone cannot pass.

Claude uses supported safe mode with tools/hooks/MCP disabled. Codex uses a
read-only sandbox, denies approvals, disables supported tool/plugin features and
verifies that the effective MCP roster is disabled. OpenCode uses pure mode and
a dedicated deny-all agent with discovered MCP integrations disabled. Unsupported
isolation capabilities produce Unknown before inference. The intended explicit
model selection is preserved, including OpenCode's provider/model selector.

Connected evidence is specifically **provider inference**. Optional MCP server
handshakes are not claimed; their untested state is shown separately. Local checks
must still pass for a Connected OK. This scope prevents provider success from
being presented as proof that every installed integration works.

The server issues a source-bound confirmation token. A check requires that exact
current token, consumes it, refuses concurrent requests, and rejects changed
inputs before attaching a result. Connected evidence expires after 15 minutes,
invalidates on observed input changes, and exists only for this server session.
Changes during a check discard its result. Closing the dashboard or disconnecting
the requesting client cancels the owned connected subprocess.

### HTTP and presentation boundaries

`GET /api/host-health` reads local/cached evidence. The separate POST allowlist is
`/api/host-health/local` and `/api/host-health/connection`. Both require the session
token header and exact same-origin fetch metadata; query tokens cannot authorize
POST. Requests are size-bounded and accept fixed fields, never arbitrary commands,
paths, prompts, environment or client-selected models. Connection checks additionally
require explicit confirmation and a fresh observation token. Native errors are
sanitized before HTTP responses.

Usage keeps its original four `sourceHealth` fields and full diagnostics under
Usage data sources. The historical scan's extra 90 days are disclosed. Those
observations never drive the host health badges.

## Grounding

- [Claude CLI and safe mode](https://code.claude.com/docs/en/cli-reference), [installation diagnostics](https://code.claude.com/docs/en/setup), and [model configuration](https://code.claude.com/docs/en/model-config).
- [Codex native commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) and [configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic).
- [OpenCode CLI](https://opencode.ai/docs/cli/), [JSON/JSONC configuration](https://opencode.ai/docs/config/), and [permissions](https://opencode.ai/docs/permissions/).
- Installed native help and bounded read-only preflight inspected on 2026-09-20. OpenCode v1.18.31 source explains configuration initialization and stdin/structured completion behavior.

## Validation

Tests cover native schema/capability changes, all three local adapters, defaults
and precedence, invalid nested configuration, credential isolation, source
invalidation, expiration, explicit consent, replay/concurrency rejection, origin
and token enforcement, and native challenge completion/cancellation. Browser
verification exercises all three hosts, keyboard navigation, consent, pending
state, desktop/mobile layouts and separation from usage diagnostics.

No paid live inference is part of the test suite. Connected paths use deterministic
native-boundary fixtures; real read-only preflight checks stop before inference.

### Implementation evidence — 2026-09-20

The final focused suites passed 77 tests, including real subprocess stdin and
process-tree timeout cleanup against a local fixture executable. No model
request was made by that fixture. The full browser suite passed 491 assertions
plus 9 tests; the final health dialog also passed independently on desktop and
mobile. Legacy suites, typecheck, lint, complexity checks, Markdown lint and
build passed (lint retains repository warnings).

The broader unit run passed 4,159 tests with 6 existing skips and one failure:
the existing stock OpenCode fixture timed out installing its npm SDK dependency
before any provider request. It measured 92.05% line, 81.28% branch and 91.55%
function coverage. That broad run preceded the last effective-isolation and
HTTP error-classification regressions, which passed in the final focused suite.
The full repository test command is therefore not claimed green.

A live local collection reported Local OK for Claude, Codex and OpenCode, with
connection state not-run for each. Claude/Codex real native preflight reached
intercepted inference; OpenCode native help was checked while config startup was
mocked to avoid initialization. No paid inference, commit, push or release was
performed. ADR-0051's alpha.48 publication correction remains in this branch.
