// pricing.mjs — model → published-rate tables and the cost arithmetic behind the
// usage scorecard (ADR-0009 §3). PURE: no fs, no clock, no network. Every figure
// it produces is an API-LIST-PRICE EQUIVALENT — on a Max/Pro subscription (or
// Codex-via-ChatGPT) the user is not billed per token, so callers must label it
// as such and never as plan billing.
//
// The cache multipliers are the whole point of this module. On a real corpus
// ~96% of tokens are cache reads, which bill at 0.1× input; pricing them as
// fresh input overstates cost by roughly 10×. Cache writes bill at 1.25×.
//
// Rates drift and are maintained BY HAND (OpenAI publishes nothing
// machine-readable in ~/.codex/models_cache.json, verified). PRICES_AS_OF is
// therefore surfaced in the UI so staleness is visible rather than silent.

// ── Table ────────────────────────────────────────────────────────────────────

/** The date the whole table was last verified — date-stamped in the UI. */
export const PRICES_AS_OF = '2026-07-25';

const anthropic = (i, o) => ({ in: i, out: o, provider: 'anthropic', asOf: PRICES_AS_OF });
const openai = (i, o) => ({ in: i, out: o, provider: 'openai', asOf: PRICES_AS_OF });

/**
 * Model-id PREFIX → { in, out, provider, asOf }, in $ per 1M tokens.
 *
 * Keys are prefixes, not exact ids, so dated releases resolve without a table
 * edit (`claude-haiku-4-5-20251001` → the Haiku entry). Anthropic list prices as
 * of 2026-07; OpenAI rates are maintained (no published machine-readable source).
 */
export const PRICES = {
  // Anthropic — flagship (Fable/Mythos class)
  'claude-fable-5': anthropic(10, 50),
  'claude-mythos-5': anthropic(10, 50),
  // Anthropic — Opus line (5 and the prior generations share a price)
  'claude-opus-5': anthropic(5, 25),
  'claude-opus-4-8': anthropic(5, 25),
  'claude-opus-4-7': anthropic(5, 25),
  'claude-opus-4-6': anthropic(5, 25),
  'claude-opus-4-5': anthropic(5, 25),
  // Anthropic — Sonnet line.
  // Sonnet 5 is on INTRODUCTORY pricing ($2/$10) through 2026-08-31; the
  // standard rate is $3/$15. We carry the rate actually billed today, because
  // the panel's claim is "what these tokens would cost metered" — using the
  // standard rate would overstate a Sonnet-heavy window by 50%.
  // ⚠ ON 2026-09-01 THIS MUST REVERT TO anthropic(3, 15).
  'claude-sonnet-5': anthropic(2, 10),
  'claude-sonnet-4-6': anthropic(3, 15),
  'claude-sonnet-4-5': anthropic(3, 15),
  // Anthropic — Haiku line
  'claude-haiku-4-5': anthropic(1, 5),

  // OpenAI (Codex). Verified against developers.openai.com/api/docs/pricing and
  // /api/docs/models on 2026-07-25. There is NO machine-readable pricing in
  // ~/.codex/models_cache.json (checked: zero price/pricing/usd keys), so this
  // table is maintained by hand and is the most drift-prone thing in this file.
  //
  // UNLIKE ANTHROPIC, OpenAI publishes no introductory or promotional rates —
  // the pricing page carries no promo tiers and no expiry dates. So there is no
  // OpenAI equivalent of the Sonnet 5 intro caveat above; these are simply list.
  //
  // OpenAI's cached-input rate is a 90% discount (0.1x) and cache writes are
  // 1.25x — the SAME multipliers as Anthropic, which is why costOf() needs no
  // per-provider branch.
  //
  // Slugs come from the Codex model cache itself, so an id seen in a real
  // rollout resolves rather than silently hitting FALLBACK_PRICE.
  'gpt-5.6-sol': openai(5, 30),
  'gpt-5.6-terra': openai(2.5, 15),
  'gpt-5.6-luna': openai(1, 6),
  'gpt-5.5-pro': openai(30, 180), // before gpt-5.5, so the longer key wins
  'gpt-5.5': openai(5, 30),
  'gpt-5.4-mini': openai(0.75, 4.5),
  'gpt-5.4-nano': openai(0.2, 1.25),
  'gpt-5.4-pro': openai(30, 180),
  'gpt-5.4': openai(2.5, 15),
  'gpt-5.3-codex': openai(1.75, 14),
  'chat-latest': openai(5, 30),
  'gpt-realtime-2.1-mini': openai(0.6, 2.4),
  'gpt-realtime-2.1': openai(4, 24),
};

/**
 * Pricing factors we deliberately DO NOT model, recorded so their absence is a
 * documented limitation rather than a silent inaccuracy:
 *
 * - **Regional-processing uplift.** OpenAI charges +10% on data-residency
 *   endpoints for models released on/after 2026-03-05. Codex CLI does not use
 *   those endpoints by default, and a transcript does not record which endpoint
 *   served it, so we cannot detect it.
 * - **Large-prompt surcharge.** A 2x input / 1.5x output surcharge above ~272K
 *   input tokens has been reported for the GPT-5.6 line but is NOT restated on
 *   the current pricing page; it is left unmodelled rather than encoded on one
 *   unconfirmed source.
 * - **`*-pro` models list no cached-input rate** (caching appears unsupported).
 *   Their transcripts therefore report zero cached tokens, so the 0.1x branch
 *   is simply never exercised for them.
 * - **Service tiers.** Batch / Flex / Priority multipliers are not applied; the
 *   transcripts do not record the tier a request used.
 */
export const UNMODELLED_PRICING_FACTORS = Object.freeze([
  'regional-processing-uplift', 'large-prompt-surcharge', 'service-tiers',
]);

/**
 * Rate used when a model id matches nothing. Deliberately a real, mid-line rate
 * (Sonnet class): an unknown model must never silently cost 0, and must never
 * throw. `matched:false` travels with it so the UI can flag the estimate.
 */
export const FALLBACK_PRICE = { in: 3, out: 15, provider: null, asOf: PRICES_AS_OF };

/** Cache-read tokens bill at 0.1× the input rate; cache writes at 1.25×. */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

// ── Matching ─────────────────────────────────────────────────────────────────

// Model ids arrive with inconsistent separators and case (`claude-opus-4-8` vs
// `claude-opus-4.8`, Codex's `gpt-5.6`), so both key and id are normalised the
// same way before comparison. Underscores and slashes fold too, so a namespaced
// id (`anthropic/claude-opus-5`) still ends on the same tokens.
const normalize = (s) => String(s).toLowerCase().replace(/[._/]/g, '-');

// A prefix only counts on a TOKEN boundary: `claude-opus-5` must match
// `claude-opus-5-20260401` but not `claude-opus-50`, which is a different model.
const isPrefixOf = (key, id) => id === key || (id.startsWith(key) && id[key.length] === '-');

// Longest key first, so the more specific line wins (`gpt-5.6-sol` over `gpt-5.6`).
const KEYS_BY_LENGTH = Object.keys(PRICES)
  .map((key) => ({ key, norm: normalize(key) }))
  .sort((a, b) => b.norm.length - a.norm.length);

/**
 * Resolve a model id to its rates: `{ in, out, provider, key, matched }`.
 *
 * Longest-prefix match over `PRICES`. `provider` is a HINT used only to break a
 * tie between equally-specific entries — it never vetoes an unambiguous id match,
 * because the id is the stronger signal. An unrecognised (or absent, or
 * non-string) model yields `FALLBACK_PRICE` with `matched:false`; this function
 * never throws.
 */
export function priceFor(model, provider) {
  const id = typeof model === 'string' ? normalize(model) : '';
  if (id) {
    const hits = KEYS_BY_LENGTH.filter(({ norm }) => isPrefixOf(norm, id));
    if (hits.length) {
      const best = (provider && hits.find(({ key }) => PRICES[key].provider === provider)) || hits[0];
      const p = PRICES[best.key];
      return { in: p.in, out: p.out, provider: p.provider, key: best.key, matched: true };
    }
  }
  return { ...FALLBACK_PRICE, key: null, matched: false };
}

// ── Cost ─────────────────────────────────────────────────────────────────────

/** A usable token count: anything non-finite or negative counts as 0. */
const tokens = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

/**
 * API-equivalent cost in USD for one model's token usage:
 *
 *   (input·in + cacheWrite·in·1.25 + cacheRead·in·0.1 + output·out) / 1e6
 *
 * All counters are optional and default to 0, so all-zero usage returns exactly
 * `0`. An unknown model is priced at the fallback rate rather than zeroed, and
 * junk input is coerced rather than thrown on — this runs over transcripts the
 * kit did not write.
 */
export function costOf(usage) {
  const { model, provider, input, output, cacheRead, cacheWrite } = usage ?? {};
  const { in: rin, out: rout } = priceFor(model, provider);
  const inputUnits = tokens(input)
    + tokens(cacheWrite) * CACHE_WRITE_MULTIPLIER
    + tokens(cacheRead) * CACHE_READ_MULTIPLIER;
  return (inputUnits * rin + tokens(output) * rout) / 1e6;
}
