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

// ── Rate constructors ────────────────────────────────────────────────────────
// A rate entry is always a SCHEDULE — an ordered list of periods, each with the
// day it takes effect. The overwhelmingly common case is one period that has
// always applied, so `anthropic(3, 15)` stays the terse form and builds a
// single-period schedule; `.dated([...])` is for the rare entry whose rate the
// vendor has PUBLISHED a change to.
//
// The mechanism is deliberately IDENTICAL for both vendors. A date range is a
// fact about a price, not about a provider, and today's asymmetry — Anthropic
// has published a dated change, OpenAI has not — is a fact about the DATA, not
// about the mechanics. Encoding it in the shape of the table would mean that
// the day OpenAI ships a promo rate, someone has to build a second mechanism
// under deadline pressure and then keep two sets of boundary tests from
// drifting apart. This mirrors `costOf`, which has no per-provider branch for
// exactly the same reason (see the multiplier note below).
//
// NOT expressible here, on purpose: rates that vary by HOW a request was served
// rather than WHEN — regional uplift, the large-prompt surcharge, service
// tiers. Those are a different axis, transcripts do not record the endpoint or
// tier, and stretching this into a general modifier system would manufacture
// precision the data cannot support. They stay in UNMODELLED_PRICING_FACTORS.
const schedule = (provider) => {
  // `from` absent on the first period = "has always applied". Periods are kept
  // sorted so selection is a scan for the last one already in effect.
  const build = (periods) => ({
    provider,
    asOf: PRICES_AS_OF,
    periods: [...periods]
      .map((p) => ({ from: p.from ?? null, in: p.in, out: p.out }))
      .sort((a, b) => String(a.from ?? '').localeCompare(String(b.from ?? ''))),
  });
  const make = (i, o) => build([{ in: i, out: o }]);
  make.dated = build;
  return make;
};
const anthropic = schedule('anthropic');
const openai = schedule('openai');

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
  // Sonnet 5 launched on INTRODUCTORY pricing ($2/$10) through 2026-08-31,
  // reverting to the standard $3/$15 on 2026-09-01. Anthropic PUBLISHED that
  // end date, so it is a recorded fact rather than a forecast — which is the
  // bar for putting anything in a `dated` schedule. Tokens spent before the
  // boundary stay priced at the rate they were metered at, forever; only
  // tokens spent on or after it price at the standard rate.
  'claude-sonnet-5': anthropic.dated([
    { in: 2, out: 10 },                      // introductory, from launch
    { from: '2026-09-01', in: 3, out: 15 },  // standard
  ]),
  'claude-sonnet-4-6': anthropic(3, 15),
  'claude-sonnet-4-5': anthropic(3, 15),
  // Anthropic — Haiku line
  'claude-haiku-4-5': anthropic(1, 5),

  // OpenAI (Codex). Verified against developers.openai.com/api/docs/pricing and
  // /api/docs/models on 2026-07-25. There is NO machine-readable pricing in
  // ~/.codex/models_cache.json (checked: zero price/pricing/usd keys), so this
  // table is maintained by hand and is the most drift-prone thing in this file.
  //
  // As of the verification date OpenAI publishes no introductory or promotional
  // rates — the pricing page carries no promo tiers and no expiry dates — so
  // every entry below is a single always-applied period. That is a fact about
  // the DATA, not a limitation of the table: `openai.dated([...])` is available
  // and behaves identically to the Anthropic case, so if OpenAI ships a dated
  // promo it is a one-line edit here rather than new machinery.
  //
  // OpenAI's cached-input rate is a 90% discount (0.1x) and cache writes are
  // 1.25x — the SAME multipliers as Anthropic, which is why costOf() needs no
  // per-provider branch.
  //
  // Slugs come from the Codex model cache itself, so an id seen in a real
  // rollout resolves rather than silently hitting FALLBACK_PRICE.
  //
  // RETIRED IDS STAY. `gpt-5.4*` and `gpt-5.3-codex` are in routing.mjs's
  // RETIRED_MODELS — ak no longer ROUTES to them, but transcripts that already
  // spent tokens on them are read forever, and deleting their keys would
  // silently re-cost that history at FALLBACK_PRICE. Retirement is a routing
  // decision; this table is a historical record. Never prune one from the other.
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
 * The period of a schedule in effect on `day` — the last one whose `from` has
 * already arrived. `day` is an ISO date string (`YYYY-MM-DD`), compared
 * lexicographically, which is exact for that format and needs no Date parsing.
 *
 * A missing/invalid `day` falls back to **PRICES_AS_OF**, the date this table
 * was last verified — deliberately NOT the newest period. "Newest" only means
 * "current" once every published change has taken effect, and deciding whether
 * one has requires a clock this module does not read (its purity is what makes
 * the arithmetic testable). Verification date is the honest answer to a
 * dateless query, and it is the same date the UI already prints as
 * "rates as of …", so the default and the label can never disagree.
 */
function periodOn(periods, day) {
  const raw = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day) ? day : PRICES_AS_OF;
  const when = raw.slice(0, 10);
  let chosen = periods[0];
  for (const p of periods) {
    if (p.from === null || p.from <= when) chosen = p;
    else break;
  }
  return chosen;
}

/**
 * Resolve a model id to its rates: `{ in, out, provider, key, matched }`.
 *
 * Longest-prefix match over `PRICES`. `provider` is a HINT used only to break a
 * tie between equally-specific entries — it never vetoes an unambiguous id match,
 * because the id is the stronger signal. An unrecognised (or absent, or
 * non-string) model yields `FALLBACK_PRICE` with `matched:false`; this function
 * never throws.
 *
 * `day` (ISO `YYYY-MM-DD`) selects the rate IN EFFECT ON THAT DAY. Cost
 * attribution is historical: tokens spent in August were metered at August's
 * rate and must still read that way in October. Pricing by "now" instead would
 * retroactively restate finished windows the moment a published rate changed —
 * a panel whose claim is "what these tokens would cost metered" cannot do that.
 * Omitting `day` prices as of `PRICES_AS_OF` (see `periodOn`).
 */
export function priceFor(model, provider, day) {
  const id = typeof model === 'string' ? normalize(model) : '';
  if (id) {
    const hits = KEYS_BY_LENGTH.filter(({ norm }) => isPrefixOf(norm, id));
    if (hits.length) {
      const best = (provider && hits.find(({ key }) => PRICES[key].provider === provider)) || hits[0];
      const p = PRICES[best.key];
      const r = periodOn(p.periods, day);
      return { in: r.in, out: r.out, provider: p.provider, key: best.key, matched: true };
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
 *
 * `usage.day` (ISO `YYYY-MM-DD`) prices the row at the rate in effect that day.
 * Usage rows are already keyed by day upstream, so the caller has it in hand;
 * omitting it falls back to the current standing rate.
 */
export function costOf(usage) {
  const { model, provider, input, output, cacheRead, cacheWrite, day } = usage ?? {};
  const { in: rin, out: rout } = priceFor(model, provider, day);
  const inputUnits = tokens(input)
    + tokens(cacheWrite) * CACHE_WRITE_MULTIPLIER
    + tokens(cacheRead) * CACHE_READ_MULTIPLIER;
  return (inputUnits * rin + tokens(output) * rout) / 1e6;
}
