# Model listing and pricing audit — 2026-09-23

The maintained OpenAI and Anthropic text-token rate entries were checked against
provider-owned public documentation. API-equivalent estimates are not subscription
bills or evidence of account access. Routing defaults moved to the current generation (see below).

## Additions

- **Claude Opus 5.5** (`claude-opus-5-5`, released 2026-09-22): $4 input, $5
  five-minute writes, $8 one-hour writes, $0.20 cache reads and $20 output per
  million tokens. Cache reads are 0.05× input, not the usual 0.1×. 1M context,
  128K output, retirement not sooner than 2027-09-22.
  [Pricing](https://platform.claude.com/docs/en/about-claude/pricing),
  [models overview](https://platform.claude.com/docs/en/about-claude/models/overview),
  [deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations).
- **GPT-6 Sol** (`gpt-6-sol`): $2 input, $0.20 cached input, $2.50 cache writes,
  $10 output. [Model page](https://developers.openai.com/api/docs/models/gpt-6-sol).
- **GPT-6 Luna** (`gpt-6-luna`): $0.10 input, $0.01 cached input, $0.125 cache
  writes, $0.50 output. [Model page](https://developers.openai.com/api/docs/models/gpt-6-luna).

Both GPT-6 models were announced on 2026-09-22
([SiliconANGLE](https://siliconangle.com/2026/09/22/anthropic-releases-claude-opus-5-5-and-openai-counters-with-two-cheaper-gpt-6-models/)).
Their model pages list April 20 and May 18, 2026 as the "release date", which
match the stated knowledge cutoffs, not the public launch. Both have a 1.05M
context window, 128K output and the same >272K request surcharge as Astra,
which the estimator does not model.

## Routing defaults

- Claude reasoning activities (architecture, design, security-analysis,
  debugging, and the implementation/testing escalation rung) now default to
  `claude-opus-5-5`, Anthropic's recommended starting model
  ([models overview](https://platform.claude.com/docs/en/about-claude/models/overview)).
  Opus 5 remains listed for pins.
- Codex implementation, testing and security-scan now default to `gpt-6-sol`,
  documentation and packaging to `gpt-6-luna`. Codex's own model catalog ranks the
  GPT-6 models first and labels GPT-5.6 "Older"; OpenAI's Codex docs make Sol the
  default preset ([Codex models](https://learn.chatgpt.com/docs/models)). GPT-5.6
  models remain listed for pins.
- Cross-host tiers pair by role: GPT-6 Sol ↔ Sonnet 5 (balanced, $2/$10),
  GPT-6 Astra ↔ Opus 5.5 (reasoning; Astra also pairs with Fable 5.1), GPT-6
  Luna ↔ Haiku 4.5 (fast). A Codex-driven seed runs reasoning work on Astra.
- Routes seeded before this change are reported as diverged and keep their model
  until `ak x host refresh`.
- Not added as retirements: OpenAI's Codex docs retire GPT-5.4 / 5.4 Mini
  (2026-08-31) and GPT-5.5 (2026-10-14) for ChatGPT sign-in, but the API still
  serves them, so a read-time substitution would override API-key users' pins.

## Corrections

- `claude-opus-5-5` had no entry and matched `claude-opus-5` on the token
  boundary, so real Opus 5.5 usage was costed at $5/$25 with 0.1× cache reads.
  It now resolves to its own row.
- Provider-namespaced ids (`anthropic/claude-opus-4.7`, `openai/gpt-5.5`) fell
  through to the fallback rate because matching is by prefix. They now match on
  their last path segment.
- The previous audit said one-hour cache writes were outside the estimator.
  They are priced at 2× input from the transcript's TTL split.

## Verified and unchanged

All other Anthropic entries match the live pricing table, including Fable 5.1 /
Mythos 5.1 (0.025× cache reads) and Sonnet 5 at $2/$10. No Anthropic model was
deprecated since the last audit; Sonnet 4.5 and Haiku 4.5 remain Active.

OpenAI base rates (USD/MTok), checked against
[OpenAI pricing](https://developers.openai.com/api/docs/pricing):

| Model | Input | Output |
|---|---|---|
| GPT-6 Astra | 10 | 50 |
| GPT-5.6 Sol | 4 | 20 |
| GPT-5.6 Terra | 2 | 12 |
| GPT-5.6 Luna | 0.20 | 1.20 |
| GPT-5.5 | 5 | 30 |
| GPT-5.5 Pro | 30 | 180 |
| GPT-5.4 | 2.50 | 15 |
| GPT-5.4 Mini | 0.75 | 4.50 |
| GPT-5.4 Nano | 0.20 | 1.25 |
| GPT-5.4 Pro | 30 | 180 |
| GPT-5.3 Codex | 1.75 | 14 |
| chat-latest | 5 | 30 |
| Realtime 2.1 (text) | 4 | 24 |
| Realtime 2.1 Mini (text) | 0.60 | 2.40 |

GPT-5.6 Sol's promotional price is guaranteed at least through November 21,
2026; no future price is invented. Some third-party summaries list GPT-5.6 Sol
at $5/$30; OpenAI's own pricing page shows $4/$20.

## Not priced, deliberately

- `codex-auto-review`, Codex's automatic approval reviewer, appears in local
  Codex rollouts with real token counts. OpenAI publishes no per-token price for
  it. It is a server-side alias: Codex
  [PR #18169](https://github.com/openai/codex/pull/18169) replaced a hardcoded
  `gpt-5.4` with it so the backend can choose the model. It stays unmatched and
  is costed at the flagged fallback rate rather than at a guessed one.
- `gpt-reserve` (Luna Reserve) is a hidden Codex fallback allowance with no
  published API price.

## Estimator limits

Request-level long-context surcharges, service modes (Batch, Flex, Priority,
Fast), regional uplifts and audio/image rates are not inferred from daily
aggregate token counts. OpenAI's API cache-write counter is included in total
input; native host transcripts must expose equivalent evidence before their
parsers can attribute those writes. The model list and pricing table do not
constitute a complete provider catalog.
