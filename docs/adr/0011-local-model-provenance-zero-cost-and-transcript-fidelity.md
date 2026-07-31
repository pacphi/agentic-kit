# ADR-0011 — Local models: provenance out-of-band, $0 per model, and stated transcript fidelity

- **Status:** Proposed; current command references amended by
  [ADR-0020](0020-ga-stable-surfaces.md) — see *Validation required* before acceptance
- **Date:** 2026-07-27
- **Updated:** 2026-07-30
- **Update note:** Repointed the provider-binding reference to the canonical host-management
  module; the unmeasured local-model proposal remains unimplemented.
- **Deciders:** agentic-kit maintainers
- **Amends:** [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md) §3 (cost) and §8 (transcripts)

## Context

`ak` already treats `ollama` as a first-class provider on the *routing* axis: it is in
`PROVIDERS` (`src/lib/routing.mjs:30`), in `SUBSCRIPTION_PROVIDERS` as a $0 local backend
(`:36`), in the aqe provider matrix (`src/lib/providers.mjs:56`), and in the billing hint the
host-management picker prints — *"ollama/onnx = local ($0)"* (`src/commands/x/host.mjs`).

The **usage** axis knows nothing about it. Grepping `ollama|OLLAMA|ANTHROPIC_BASE_URL|OPENAI_BASE_URL`
across `src/` returns hits in exactly those three routing/provider files and none in
`usage-index.mjs`, `pricing.mjs`, or `dashboard-server.mjs`. The scorecard is built on an assumption
it never states: that every transcript on disk was produced by a metered vendor endpoint.

Ollama has since made that assumption easy to violate from the host side. `ollama launch` configures
and starts a frontier CLI against a local model — `ollama launch claude`, `ollama launch codex`, and
fourteen other integrations — so a Claude Code or Codex session backed by a local model is now a
one-command act, not a hand-wired experiment.

**Machine evidence gathered for this ADR** (2026-07-27): `ollama` client **0.32.1** installed, daemon
**not running** at scan time (`curl :11434` → exit 7), **132 GB** of models on disk, 14 tags across
8 families — including `qwen3.6:35b-a3b-q4_K_M`, `qwen3.6:27b-mlx`, `qwen3.6:latest`,
`qwen3-coder:30b`, `qwen3-coder:30b-a3b-q4_K_M`, `gemma4:26b-a4b-it-q4_K_M`, `glm-4.7-flash:q4_K_M`,
`qwen3:32b`, and `hf.co/yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF:Q8_0`.

### Findings

Sources are cited inline; every claim below is either a vendor document, upstream source, or a
measurement on this machine. Where a claim is *derived* rather than observed, it says so.

**F1 — Model identity already flows through, verbatim.** Ollama's Anthropic compatibility layer
(`anthropic/anthropic.go`, `ToMessagesResponse()`) **echoes the request's `model` string** into the
response ([DeepWiki: Anthropic Compatibility Layer](https://deepwiki.com/ollama/ollama/3.5-anthropic-compatibility-layer)).
Claude Code writes that value to `message.model`, which `usage-index.mjs:480` reads verbatim. So a
local session's model *name* is already captured correctly today — `qwen3.6:35b-a3b-q4_K_M` will
appear as a model in play. Nothing needs building for identity. What is missing is everything
attached to it.

**F2 — The tag is not the model.** Quantization, parameter count, family, format, and context length
are **not in the tag** in the general case: `qwen3.6:latest`, `qwen3:32b`, and `qwen3-coder:30b` carry
no quant, while `gemma4:26b-a4b-it-q4_K_M` does. That metadata lives only in the daemon's own
catalogue — `/api/tags` returns `details.{format, family, families, parameter_size,
quantization_level}` plus `digest` and `size` ([Ollama — List models](https://docs.ollama.com/api/tags));
`/api/show` adds `model_info` (`general.architecture`, `general.parameter_count`, `general.file_type`,
`*.context_length`) and `capabilities`; `/api/ps` adds `size_vram`, `context_length`, and `expires_at`
for what is actually resident ([Ollama — List running models](https://docs.ollama.com/api/ps);
[`docs/api.md`](https://github.com/ollama/ollama/blob/main/docs/api.md)). **Surfacing the exact model —
"qwen3.6 · 35B · Q4_K_M · gguf" — therefore requires an out-of-band read. The transcript alone cannot
answer it.**

**F3 — There is no cache accounting, structurally.** Ollama's `/v1/messages` returns
`usage.{input_tokens, output_tokens}` and nothing else; `cache_creation_input_tokens` and
`cache_read_input_tokens` are absent, and **prompt caching is on the explicit unsupported list**
alongside the token-counting endpoint, Batches, citations, and PDFs
([Anthropic compatibility](https://docs.ollama.com/api/anthropic-compatibility)). Since
`usage-index.mjs:483-489` coerces missing counters to `0`, every local session records
`cacheRead = cacheWrite = 0` — so **100% of its input prices at 1×**. ADR-0009 §3 built the entire
cost model around the opposite fact: 96.3% of the reference corpus is cache reads billing at 0.1×.
A local session is the pathological input to that formula.

**F4 — Local token counts are approximations, and not stable ones.** The compatibility doc states
plainly that *"token counts are approximations based on the underlying model's tokenizer."* Upstream,
`prompt_eval_count` has a long history of reporting something other than "tokens in this prompt" —
it disappears entirely on repeated identical requests ([ollama#2068](https://github.com/ollama/ollama/issues/2068))
and has been reported outright broken ([ollama#3427](https://github.com/ollama/ollama/issues/3427)),
with KV-cache reuse meaning the count reflects what was *evaluated*, not what was *sent*. So local
figures are not comparable to vendor-metered ones **in tokens**, before any question of dollars.

**F5 — The model id can be forged, and the vendor recommends it.** For tools that hardcode Anthropic
names, Ollama's own documentation recommends aliasing:
`ollama cp qwen3-coder claude-3-5-sonnet` (Anthropic compatibility; the same advice appears for
OpenAI names). A user following that advice with `ollama cp qwen3-coder claude-opus-5` produces
transcripts whose `message.model` matches `PRICES['claude-opus-5']` **exactly** and bills a free local
session at $5/$25 per 1M. **Any scheme that infers "is this local?" from the model string is
defeated by a documented, recommended workflow.** Provenance must come from a channel the model id
cannot forge.

**F6 — The fallback path is currently unexercised, which is precisely why it is dangerous.** Measured
over the live index (`~/.config/agentic-kit/usage-index.json`, schema 6, **754 indexed files**), the
complete set of model ids carrying usage rows is: `claude-sonnet-5`, `claude-opus-4-8`,
`claude-fable-5`, `claude-opus-5`, `claude-opus-4-7`, `claude-haiku-4-5-20251001`, `gpt-5.6-sol` —
**seven ids, all of which match the price table**. (The bare `sonnet`/`haiku`/`opus` strings visible
in raw transcripts are `Agent`-tool *inputs*, not `message.model`, and never reach pricing — checked.)
So `FALLBACK_PRICE` ($3/$15, Sonnet-class, `matched:false`) has never once been hit on this corpus,
and `matched` has no consumer anywhere in `dashboard-server.mjs` or `usage-index.mjs`. The first
local session would be the first thing to exercise a silent path — and it would exercise it for
every turn.

**F7 — Transcript fidelity is high on content, gapped on metadata.** `/v1/messages` supports
messages, multi-turn, streaming, system prompts, **tool calling**, **thinking**, and vision. Tool
calling is the load-bearing one: `tool_use` blocks are what `usage-index.mjs:492-497` counts, so the
tool-mix prior in `usage-classify.mjs` and the per-turn tool chips keep working. Three gaps:
*(a)* `ai-title` is generated by the host's own titling call, which under a local base URL is served
by the local model — when it yields nothing, `rec.title` falls back to `clip(firstPrompt)`
(`:507`), and classification loses its 93%-coverage signal; *(b)* **server-sent errors during
streaming are unsupported**, so a mid-stream local failure may not arrive as the `isApiErrorMessage`
turn that ADR-0009's exception accounting depends on — local failures can under-report; *(c)* on the
Codex side `ollama launch codex` writes a dedicated profile, `~/.codex/ollama-launch.config.toml`,
with `base_url = "http://localhost:11434/v1/"` and `wire_api = "responses"`
([Ollama — Codex CLI](https://docs.ollama.com/integrations/codex)) — token accounting there is
Codex's own, so `token_count` events survive, while `rate_limits` is simply absent and
`rec.rateLimits` correctly stays `null`.

## Decision

### 1. Provenance is established out-of-band and stamped on the session — never inferred from the model id

F5 forecloses id-based inference. Two channels, in order:

1. **The local catalogue.** `GET http://127.0.0.1:11434/api/tags` yields the exact set of tags and
   digests this machine can serve. Membership is the primary signal.
2. **ak's own wiring.** `ANTHROPIC_BASE_URL` in the managed `.claude/settings.local.json` `env`
   block, and the presence of `~/.codex/ollama-launch.config.toml` — both artifacts `ak` or
   `ollama launch` wrote, both outside the transcript.

When a model id is **both** a local tag and a price-table entry (the F5 alias case), the session is
**`ambiguous`**: no dollar figure, no $0 claim, and the ambiguity is displayed with its cause
("`claude-opus-5` is also a local Ollama tag on this machine"). Resolving it would require guessing,
and this is the ADR series' standing answer to a guess — ADR-0009 §5's `Unclassified` and §6's
*"no $ claimed"* are the same move.

**Stated limitation, load-bearing:** catalogue membership is read **now** and the session ran
**then**. A tag pulled today does not prove last week's session was local, and a tag deleted since
does not prove it was not. Provenance is therefore stamped **at index time**, carries the evidence
that produced it (`catalog` / `config` / `both`), and is re-derivable on reindex. This is weaker
than the vendor-mediated facts of ADR-0010 and is labelled as inference in the UI, not as a fact.

### 2. A loopback read of the local daemon is not egress — ADR-0010's pattern, applied to a third provider

ADR-0009 §2 promised "zero network calls" and ADR-0007 drew the `dashboard`/`admin` line at
**network egress**. A request to `127.0.0.1:11434` crosses no network boundary and touches no
credential — it is the same shape as ADR-0010 spawning `codex app-server` to read quota, and the
same trust model as the dashboard shelling out to `ak status`. It stays in `dashboard`.

Rules: read-only (`/api/tags`, and `/api/show` only for tags actually seen in transcripts); cached to
`~/.config/agentic-kit/ollama-catalog.json` with a TTL; **never starts the daemon** (it was down on
this machine during research — that must be an ordinary state, not a degraded one); on failure the
feature returns `provenance: unknown` and the panel says the catalogue was unreachable. No auto-pull,
no model loading, no write path to Ollama, ever.

### 3. Three cost states replace one silent fallback

`matched` graduates from an unread flag to the thing that decides what may be claimed:

| State | Condition | Cost shown |
|---|---|---|
| `metered` | id matches the price table **and** provenance is not local | dollars, as today |
| `local` | provenance is local | **exactly `$0`** — a fact, not an estimate |
| `unpriced` | no table match, no local provenance | **no dollar figure at all** |

`FALLBACK_PRICE` **retires from the cost path.** Pricing an unrecognised model at Sonnet-class rates
was defensible when it could only mean "the table is one release behind"; with local hosts in play it
means "we invented a rate for tokens that may have cost nothing," which is the fabricated-denominator
error ADR-0009 §3 rejects, wearing a different hat. `priceFor` keeps returning the fallback for
callers that want a *rate*; `costOf` returns `null` for `unpriced`, and `null` renders as "unpriced",
never as `$0`. **`$0` and "no figure" must never render the same** — one is a measurement, the other
is a refusal.

### 4. Per-model rows for local models — no blanket "local" bucket

Collapsing local usage to a single row would answer "did I use local models" and destroy "*which*
local models, and how much". Every local model keeps **its own row**, ranked by **tokens** (ranking
by cost is meaningless when every row is `$0`), carrying tokens, responses, and sessions. Above them
sits one aggregate line — *"N local models · M sessions · T tokens · $0"* — so the count is directly
readable rather than something the reader has to tally. The Scorecard's headline cost KPI gains a
sibling: metered spend and local-and-free stand side by side, never summed.

### 5. Local model identity is keyed on digest and displayed with its quantization

Tags are mutable (`:latest` moves; `ollama cp` makes two names for one blob), so the **digest** is
the only stable identity. Records carry
`{ tag, digest, family, parameterSize, quantization, format, contextLength }` from `/api/tags` +
`/api/show`, displayed as **`qwen3.6:35b-a3b-q4_K_M · 35B · Q4_K_M · gguf · 262k ctx`** and keyed on
digest. This is what makes the panel able to say two rows are the same weights under different names,
or that "qwen3.6" in June and "qwen3.6" in July were different models — neither of which the tag can
express. Metadata absent (daemon down, tag since removed) renders as the tag alone; a missing field
is shown missing, not defaulted.

### 6. Token totals split the same way cost does

F4 means local token counts are approximations from a different tokenizer with unstable
prompt-accounting semantics. Blending them into one headline "tokens" KPI would produce a number
that is neither metered-accurate nor locally-accurate. The KPI therefore reports metered and local
separately, on the same footing as §3's cost split. One honest number in two parts beats one
dishonest number.

### 7. Transcript fidelity is stated per session, not silently degraded

ADR-0009 §8's principle — *withheld content announces itself* — extends from truncation and masking
to **provider capability**. Local sessions render turn-for-turn identically (F7: tools, thinking,
vision, multi-turn all survive), and carry a **fidelity note** listing what the provider could not
report:

- **no cache accounting** — `0` cache reads is a fact about Ollama, not about the work;
- **approximate token counts** — per the vendor's own wording;
- **no vendor rate limits** — the Limits view shows nothing for this session rather than a stale
  Anthropic figure (ADR-0010's staleness reporting already covers the mechanism);
- **titling served locally** — when `ai-title` is absent the title is the first prompt, and the
  category basis says so.

A reader who sees `cacheRead: 0` next to a metered session showing 96% cache reads must be able to
tell "this workload had no cache hits" from "this provider cannot report cache hits". Those are
different statements and the panel currently renders them identically.

### 8. Ollama is the implementation; the seam is "OpenAI/Anthropic-compatible local endpoint"

LM Studio, llama.cpp's server, vLLM, and any OpenAI-compatible gateway create the same three
problems (no cache fields, forgeable ids, absent quota). Only Ollama is implemented, because it is
what `ak` already wires and what is installed here. The provenance channel in §1 is defined as an
interface — *"a catalogue that can be asked which models are local"* — so a second backend is a new
catalogue reader, not a second cost model. **Nothing else is implemented on speculation.**

## Validation required

This ADR is **Proposed**, not Accepted, and the reason is recorded rather than papered over: **no
local-model session exists on this machine to observe.** The Ollama daemon was down during research,
and all 754 indexed files are vendor-metered. Every claim about *what Claude Code actually writes*
for an Ollama-backed session — §3's `cacheRead: 0`, F7's title and streaming-error behaviour — is
**derived from two specifications, not measured**.

Before this may be marked Accepted:

1. Run one `ollama launch claude` session and one `ollama launch codex` session against a known tag.
2. Capture the resulting transcript and confirm: the literal `message.model` string; presence/absence
   of `usage.cache_*`; whether an `ai-title` event is emitted; and what a deliberately interrupted
   stream records.
3. Confirm `/api/tags` `digest` values match what the transcript's tag resolves to.
4. Record the observations in `docs/USAGE-SCORECARD-METRICS.md` and correct any finding above that
   the evidence contradicts.

The executable form of this list — exact commands, the six questions with their predicted answers,
the content-free capture step, and a results table — is
**[`docs/LOCAL-MODEL-VALIDATION.md`](../LOCAL-MODEL-VALIDATION.md)**. It also carries the optional
alias experiment (`ollama cp qwen3-coder claude-opus-5`) that would turn F5 from a documented claim
into a measured one, which is the single highest-value observation available: **§1 exists entirely
because the model id is forgeable, and if it turns out not to be, §1 collapses to something much
simpler.**

## Consequences

### Good

- Local sessions become **visible and correctly free** rather than invisible or fictitiously
  expensive, and "how many local models ran at $0" is a directly readable number (§4).
- The exact model — family, parameter size, **quantization**, context — is surfaced, which the
  transcript alone can never provide (F2).
- Retiring the silent fallback (§3) fixes a latent honesty defect that predates local models:
  an unrecognised **vendor** id also stops being quietly priced as Sonnet.
- The offline-first contract holds. Loopback is not egress, and the daemon being absent is an
  ordinary state.

### Costs and risks

- **Provenance is as-of-read-time, not as-of-session-time** (§1). Explicitly labelled inference.
- **The alias case is reported, not resolved** (§1). A user who aliases a local model to a vendor
  name gets `ambiguous` rows until they rename. Accepted: the alternative is guessing about money.
- **Schema bump.** Provenance and local-metadata fields force `SCHEMA_VERSION` 6 → 7 and a full
  reindex (~1 min cold, per ADR-0009 §2).
- **A new dependency surface.** Ollama's API is not versioned in lockstep with `ak`; `/api/tags`
  field drift degrades metadata to the tag alone rather than breaking the panel.
- **Local token counts stay approximate** (F4). The panel can label that, not fix it.
- **`$0` is right for marginal cost and silent about electricity, hardware, and time.** The panel
  claims API-equivalent metered cost, which for a local model is genuinely zero; it does not claim
  total cost of ownership, and §4's label says "free" in that specific sense.

## References

- Amends [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md) §3, §8; extends
  [ADR-0010](0010-provider-mediated-quota-reads.md)'s provider-mediated read pattern to a third
  (loopback, credential-free) provider; stays inside [ADR-0005](0005-dashboard-in-page-routing-reveal.md)
  / [ADR-0007](0007-maintainer-admin-local-telemetry.md)'s offline `dashboard` contract.
- Ollama — [Anthropic compatibility](https://docs.ollama.com/api/anthropic-compatibility)
  ([source `.mdx`](https://github.com/ollama/ollama/blob/main/docs/api/anthropic-compatibility.mdx)):
  `/v1/messages`, `usage.{input_tokens, output_tokens}`, unsupported list (prompt caching, token
  counting, streaming errors), `ollama cp` aliasing, "token counts are approximations".
- Ollama — [Claude Code integration](https://docs.ollama.com/integrations/claude-code) and
  [blog: Claude Code with Anthropic API compatibility](https://ollama.com/blog/claude)
  (v0.14.0+; `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ollama launch claude`).
- Ollama — [Codex CLI integration](https://docs.ollama.com/integrations/codex)
  (`~/.codex/ollama-launch.config.toml`, `base_url = "http://localhost:11434/v1/"`,
  `wire_api = "responses"`, 64k+ context recommendation).
- Ollama — [List models `/api/tags`](https://docs.ollama.com/api/tags),
  [List running models `/api/ps`](https://docs.ollama.com/api/ps),
  [`docs/api.md`](https://github.com/ollama/ollama/blob/main/docs/api.md) (`/api/show` `model_info`,
  `capabilities`; `/api/chat` `prompt_eval_count` / `eval_count`).
- Implementation grounding: [DeepWiki — Anthropic Compatibility Layer](https://deepwiki.com/ollama/ollama/3.5-anthropic-compatibility-layer)
  (`anthropic/anthropic.go` `FromMessagesRequest()` / `ToMessagesResponse()`,
  `middleware/anthropic.go`; `model` echoed from request; `input_tokens ← prompt_eval_count`,
  `output_tokens ← eval_count`).
- Upstream token-accounting instability: [ollama#2068](https://github.com/ollama/ollama/issues/2068)
  (`prompt_eval_count` disappears on repeated identical requests),
  [ollama#3427](https://github.com/ollama/ollama/issues/3427) (`prompt_eval_count` broken).
- Machine measurements (2026-07-27): `ollama` 0.32.1, daemon down, 132 GB / 14 tags in
  `~/.ollama/models/manifests`; usage index schema 6, 754 files, 7 distinct priced model ids, zero
  `FALLBACK_PRICE` hits.
