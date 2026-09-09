# Model listing and pricing audit — 2026-09-08

The maintained OpenAI and Anthropic text-token rate entries were checked against
provider-owned public documentation. API-equivalent estimates are not subscription
bills or evidence of account access. Existing routing defaults remain unchanged.

## Corrections

- Added GPT-6 Astra at $10 input, $1 cached input, $12.50 cache writes and $50 output
  per million tokens. [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-6-astra).
- Confirmed Fable 5.1 and Mythos 5.1 already exist with $10 input, $0.25 cache reads,
  $12.50 five-minute writes and $50 output. One-hour writes cost $20 and remain
  outside the estimator's five-minute assumption. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).
- Removed Sonnet 5's canceled September increase: $2/$10 is now standard.
  [Anthropic pricing notice](https://platform.claude.com/docs/en/about-claude/pricing).
- Resolved the exact `gpt-5.6` alias to Sol; unknown variants remain unmatched.
  [Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
- Removed the unsupported cached-input discount on Pro models. GPT-5.5 Pro
  explicitly has no discount; GPT-5.4 Pro publishes no cached rate, so the
  estimator conservatively uses ordinary input rates for reported cached tokens.
  [GPT-5.5 Pro](https://developers.openai.com/api/docs/models/gpt-5.5-pro),
  [GPT-5.4 Pro](https://developers.openai.com/api/docs/models/gpt-5.4-pro).
- Applied OpenAI's 1.25× write premium only to GPT-5.6 and later; older OpenAI
  entries use ordinary input rates. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
- Removed GLM 5's static “cheapest” claim. Current OpenRouter listings put
  GLM 5.2 below GLM 5 in per-token price; provider offers can change.
  [GLM 5.2](https://openrouter.ai/z-ai/glm-5.2), [GLM 5](https://openrouter.ai/z-ai/glm-5).

## Model facts and retained rates

Fable 5.1 and Mythos 5.1 have 1M context and 128K maximum output. Mythos is
invitation-only; listing it as a choice does not assert entitlement.
[Official overview](https://platform.claude.com/docs/en/models/fable-5-1/overview).
The remaining bundled Anthropic lifecycle entries match the
[deprecation history](https://platform.claude.com/docs/en/about-claude/model-deprecations);
Mythos availability is established by the model overview, not the retirement table.

OpenAI base input/output rates below were verified and retained (USD/MTok):

| Model | Input | Output | Source |
|---|---|---|---|
| GPT-5.6 Sol | 4 | 20 | [Pricing](https://developers.openai.com/api/docs/pricing) |
| GPT-5.6 Terra | 2 | 12 | [Pricing](https://developers.openai.com/api/docs/pricing) |
| GPT-5.6 Luna | 0.20 | 1.20 | [Pricing](https://developers.openai.com/api/docs/pricing) |
| GPT-5.5 | 5 | 30 | [Model](https://developers.openai.com/api/docs/models/gpt-5.5) |
| GPT-5.5 Pro | 30 | 180 | [Model](https://developers.openai.com/api/docs/models/gpt-5.5-pro) |
| GPT-5.4 | 2.50 | 15 | [Model](https://developers.openai.com/api/docs/models/gpt-5.4) |
| GPT-5.4 Mini | 0.75 | 4.50 | [Model](https://developers.openai.com/api/docs/models/gpt-5.4-mini) |
| GPT-5.4 Nano | 0.20 | 1.25 | [Model](https://developers.openai.com/api/docs/models/gpt-5.4-nano) |
| GPT-5.4 Pro | 30 | 180 | [Model](https://developers.openai.com/api/docs/models/gpt-5.4-pro) |
| GPT-5.3 Codex | 1.75 | 14 | [Pricing](https://developers.openai.com/api/docs/pricing) |
| chat-latest | 5 | 30 | [Pricing](https://developers.openai.com/api/docs/pricing) |
| Realtime 2.1 (text) | 4 | 24 | [Pricing](https://developers.openai.com/api/docs/pricing) |
| Realtime 2.1 Mini (text) | 0.60 | 2.40 | [Pricing](https://developers.openai.com/api/docs/pricing) |

Sol's promotional price is guaranteed at least through November 21, 2026;
no definite expiry is published. No future price is invented. Retained historical
rates do not imply that a host still offers a model.

## Estimator limits

Request-level long-context surcharges, service modes, regional uplifts, audio/image
rates and one-hour cache writes are not inferred from daily aggregate token counts.
OpenAI's API cache-write counter is included in total input; native host transcripts
must expose equivalent evidence before their parsers can attribute those writes.
The model list and pricing table do not constitute a complete provider catalog.
