# ADR-0010 — Provider-mediated quota reads (the Limits view)

Date: 2026-07-27 · Status: **Accepted** · Amends: ADR-0009 §3

## Context

ADR-0009 §3 deliberately excluded plan/limit modeling from the usage scorecard:
Anthropic and OpenAI publish no limit values, so any locally computed
"percentage of plan used" would rest on an invented denominator — and "an
invented denominator is worse than no number". That reasoning was about
denominators the kit would have to *fabricate*. Research (2026-07-27, cited in
§Research below) established that both vendors now *hand over* their own
percentages through supported channels:

- **Claude Code** pushes a `rate_limits` object — `five_hour` / `seven_day`
  (and per-model weekly buckets) with `used_percentage` and `resets_at` — into
  every statusLine invocation for Pro/Max subscribers. This is documented
  behavior, not an internal.
- **Codex** answers `account/rateLimits/read` over its `codex app-server`
  JSON-RPC surface with per-lane (`rateLimitsByLimitId`) used-percent, window
  duration, reset time, plan type, and rate-limit reset credits.

A vendor-reported percentage IS an honest denominator. What remains dishonest —
and stays excluded — is fetching those numbers through channels the vendors
prohibit or do not support.

## Decision

Quota data enters the kit **only through the vendors' own software**, with ak
never reading, storing, or refreshing a vendor credential:

1. **Claude — statusline tee.** The kit's managed statusline footer tees the
   pushed `rate_limits` (plus `context_window` and `cost`) to
   `~/.config/agentic-kit/claude-rate-limits.json` (0600, atomic, throttled to
   one write per minute). Push, not pull: with no recent Claude session the
   file goes stale, and the UI labels it stale rather than hiding it.
2. **Codex — app-server subprocess.** `src/lib/quota.mjs` spawns
   `codex -s read-only -a untrusted app-server` (codex authenticates itself),
   performs one `initialize` → `account/rateLimits/read` exchange with a hard
   timeout and kill, and caches the normalized answer for `CODEX_TTL_MS`.
   This is the same shell-out trust model the dashboard already uses for
   `ak status --json`.
3. **The dashboard server itself still opens no sockets to the internet.**
   ADR-0005/0007's egress split is unchanged: the Codex subprocess is vendor
   code using vendor auth, and the Claude path is a local file read.

Normalization rules (all in `quota.mjs`, all pinned by tests):

- **Windows are keyed by duration, never by slot.** Codex's `primary` /
  `secondary` fields do not reliably mean "5-hour" / "weekly" — a live
  `prolite` account answered with `primary.windowDurationMins = 10080`.
- `null` timestamps stay `null`; they are never coerced to epoch 0.
- Every payload carries `fetchedAt`, and the UI renders freshness ("as of Nm
  ago") next to every number.

### Explicit non-paths

- **No `api.anthropic.com/api/oauth/usage`.** Undocumented; hostile
  rate-limiting to unrecognized clients; and Anthropic's consumer ToS bars
  subscription OAuth tokens "in any other product, tool, or service", enforced
  server-side since January 2026.
- **No Keychain or credential-file reads** (the macOS item stopped carrying
  the OAuth token in Claude Code 2.1.x; refresh tokens rotate destructively).
- **No `chatgpt.com/backend-api/wham/*`** — private endpoints that would
  require ak to hold and refresh the user's bearer token.
- **No auto-consumption of Codex reset credits.** The panel reports them;
  redeeming a finite grant is the user's action in codex's own `/usage`.

## Consequences

- The Limits sub-view can show authoritative, cross-device session/weekly
  utilization — data local transcript parsing can never produce (ADR-0009 §3's
  table of unknowables shrinks to: extra-usage credit balance and subscription
  tier, which have no supported channel).
- `usage-insights.mjs` gains limit-aware detectors (`detectLimitInsights`)
  under the same evidence rules; vendor percentages count as the user's own
  data, and no dollar impact is ever claimed from a percentage.
- Codex attribution stops being heuristic: `codex-state.mjs` reads Codex's own
  SQLite thread ledger (`state_*.sqlite`, glob — the numeric suffix is a
  migration generation) for `thread_source` and spawn edges, demoting the
  rollout-sniffing subagent guard to a fallback.
- Two new 0600 cache files exist under `~/.config/agentic-kit/`; both are
  derived, deletable, and self-healing.
- The `codex app-server` surface is flagged experimental upstream; the client
  pins nothing beyond two method names and degrades to "no data" with the
  stale cache visible if the protocol shifts.

## Research

Grounded findings behind this ADR (full citations in the planning record):
statusLine `rate_limits` — code.claude.com/docs/en/statusline.md; Admin
Usage/Cost + Claude Code Analytics APIs are org-only —
platform.claude.com/docs/en/manage-claude/usage-cost-api; consumer-OAuth
prohibition — code.claude.com/docs/en/legal-and-compliance; Codex app-server
schema — `codex app-server generate-json-schema` (verified live on codex
0.145.0, 2026-07-27); Codex reset-credit detail — openai/codex#29618 (shipped
via PR #30488); subagent rollout replay inflation — ccusage/ccusage#950;
wham endpoint traffic complaints — openai/codex#10869, #27952.
