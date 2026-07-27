import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICES, PRICES_AS_OF, FALLBACK_PRICE, priceFor, costOf,
} from '../../src/lib/pricing.mjs';

// A million tokens is the rate unit, so it makes every expected value a whole rate.
const M = 1_000_000;

// ── Table shape ──────────────────────────────────────────────────────────────

test('PRICES_AS_OF is the ISO date the table was last verified', () => {
  assert.equal(PRICES_AS_OF, '2026-07-25');
});

test('every PRICES entry carries finite in/out rates, a provider, and asOf', () => {
  const keys = Object.keys(PRICES);
  assert.ok(keys.length >= 8, 'table covers the shipped model lines');
  for (const [key, p] of Object.entries(PRICES)) {
    assert.ok(['anthropic', 'openai'].includes(p.provider), `${key} provider`);
    assert.match(p.asOf, /^\d{4}-\d{2}(-\d{2})?$/, `${key} asOf`);
    // Every entry is a SCHEDULE, uniformly — the single-rate case is a
    // one-period schedule, so there is no second shape to special-case.
    assert.ok(Array.isArray(p.periods) && p.periods.length >= 1, `${key} periods`);
    for (const r of p.periods) {
      assert.ok(Number.isFinite(r.in) && r.in > 0, `${key} in rate`);
      assert.ok(Number.isFinite(r.out) && r.out > 0, `${key} out rate`);
      assert.ok(r.out >= r.in, `${key} output is never cheaper than input`);
      assert.ok(r.from === null || /^\d{4}-\d{2}-\d{2}$/.test(r.from), `${key} period from`);
    }
    // The first period is the open-ended one ("has always applied"); only
    // later periods carry a start date, and they must be strictly ordered.
    assert.equal(p.periods[0].from, null, `${key} first period must be open-ended`);
    const dated = p.periods.slice(1).map((r) => r.from);
    assert.deepEqual(dated, [...dated].sort(), `${key} periods are chronological`);
    assert.equal(new Set(dated).size, dated.length, `${key} has no duplicate boundaries`);
  }
});

test('the table carries the ADR-0009 §3 rates for each Anthropic tier', () => {
  assert.deepEqual([priceFor('claude-fable-5').in, priceFor('claude-fable-5').out], [10, 50]);
  assert.deepEqual([priceFor('claude-opus-5').in, priceFor('claude-opus-5').out], [5, 25]);
  assert.deepEqual([priceFor('claude-opus-4-8').in, priceFor('claude-opus-4-8').out], [5, 25]);
  // Sonnet 5 runs INTRODUCTORY pricing through 2026-08-31; standard is 3/15.
  assert.deepEqual([priceFor('claude-sonnet-5').in, priceFor('claude-sonnet-5').out], [2, 10]);
  assert.deepEqual([priceFor('claude-sonnet-4-6').in, priceFor('claude-sonnet-4-6').out], [3, 15]);
  assert.deepEqual([priceFor('claude-haiku-4-5').in, priceFor('claude-haiku-4-5').out], [1, 5]);
});

test('the table carries the maintained OpenAI rates', () => {
  assert.deepEqual([priceFor('gpt-5.6-sol').in, priceFor('gpt-5.6-sol').out], [5, 30]);
  assert.deepEqual([priceFor('gpt-5.6-terra').in, priceFor('gpt-5.6-terra').out], [2.5, 15]);
  assert.deepEqual([priceFor('gpt-5.6-luna').in, priceFor('gpt-5.6-luna').out], [1, 6]);
  // gpt-5.5 is the model real Codex rollouts on this machine actually used.
  assert.deepEqual([priceFor('gpt-5.5').in, priceFor('gpt-5.5').out], [5, 30]);
  assert.deepEqual([priceFor('gpt-5.4-mini').in, priceFor('gpt-5.4-mini').out], [0.75, 4.5]);
  assert.deepEqual([priceFor('gpt-5.3-codex').in, priceFor('gpt-5.3-codex').out], [1.75, 14]);
});

// ── priceFor: prefix matching ────────────────────────────────────────────────

test('a dated model id resolves to its family entry (longest-prefix match)', () => {
  const p = priceFor('claude-haiku-4-5-20251001');
  assert.equal(p.matched, true);
  assert.equal(p.in, 1);
  assert.equal(p.out, 5);
});

test('longest prefix beats short prefix (gpt-5.5-pro is not billed as gpt-5.5)', () => {
  assert.equal(priceFor('gpt-5.5-pro').in, 30, 'the pro tier must not inherit the base rate');
  assert.equal(priceFor('gpt-5.5').in, 5);
  assert.equal(priceFor('gpt-5.5-pro-20260601').in, 30, 'still longest-prefix once dated');
  assert.equal(priceFor('gpt-5.5-preview').in, 5, 'an unknown suffix falls back to the shorter family');
});

test('a prefix only matches on a token boundary, never mid-identifier', () => {
  // `claude-opus-50` is a different (unknown) model, not Opus 5 with a suffix.
  const p = priceFor('claude-opus-50');
  assert.equal(p.matched, false);
});

test('matching is case- and separator-insensitive (4.8 and 4-8 are one model)', () => {
  assert.equal(priceFor('CLAUDE-OPUS-4-8').in, 5);
  assert.equal(priceFor('claude-opus-4.8').in, 5);
  assert.equal(priceFor('claude-opus-4.8').matched, true);
});

test('provider disambiguates when given, and is reported back', () => {
  assert.equal(priceFor('claude-opus-5').provider, 'anthropic');
  assert.equal(priceFor('gpt-5.5', 'openai').provider, 'openai');
  assert.equal(priceFor('gpt-5.5', 'openai').matched, true);
  // A provider that contradicts the only match does not veto it — the id wins.
  assert.equal(priceFor('claude-opus-5', 'openai').in, 5);
});

// ── priceFor: unknown models never throw ─────────────────────────────────────

test('an unknown model returns the documented fallback with matched:false', () => {
  const p = priceFor('llama-4-405b-instruct');
  assert.equal(p.matched, false);
  assert.equal(p.in, FALLBACK_PRICE.in);
  assert.equal(p.out, FALLBACK_PRICE.out);
  assert.ok(p.in > 0 && p.out > 0, 'a fallback is never a silent zero');
});

test('a missing / non-string model falls back instead of throwing', () => {
  for (const bad of [undefined, null, '', 42, {}, []]) {
    const p = priceFor(bad);
    assert.equal(p.matched, false, `${String(bad)} → fallback`);
    assert.ok(Number.isFinite(p.in) && Number.isFinite(p.out));
  }
});

// ── costOf: the formula ──────────────────────────────────────────────────────

test('a known model costs exactly the hand-computed figure', () => {
  // Opus 5 @ 5/25: (200k·5 + 100k·5·1.25 + 1M·5·0.1 + 50k·25) / 1e6
  //              = (1_000_000 + 625_000 + 500_000 + 1_250_000) / 1e6 = 3.375
  const cost = costOf({
    model: 'claude-opus-5', input: 200_000, output: 50_000, cacheRead: M, cacheWrite: 100_000,
  });
  assert.equal(cost, 3.375);
});

test('fresh input and output bill at the listed per-1M rates', () => {
  assert.equal(costOf({ model: 'claude-opus-5', input: M }), 5);
  assert.equal(costOf({ model: 'claude-opus-5', output: M }), 25);
  assert.equal(costOf({ model: 'claude-haiku-4-5-20251001', input: M }), 1);
});

test('a cache READ costs exactly 1/10 of the same volume of fresh input', () => {
  // The single most important behaviour in this module: 96% of a real corpus is
  // cache reads, so a naive tokens×rate overstates cost ~10× (ADR-0009 §3).
  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-sol', 'unknown-model-x']) {
    const fresh = costOf({ model, input: 3 * M });
    const cached = costOf({ model, cacheRead: 3 * M });
    assert.equal(cached, fresh / 10, `${model}: cache read is 0.1× input`);
  }
});

test('a cache WRITE costs exactly 1.25× the same volume of fresh input', () => {
  const fresh = costOf({ model: 'claude-opus-5', input: 4 * M });
  const written = costOf({ model: 'claude-opus-5', cacheWrite: 4 * M });
  assert.equal(written, fresh * 1.25);
});

test('all-zero usage costs exactly 0', () => {
  assert.equal(costOf({ model: 'claude-opus-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), 0);
  assert.equal(costOf({ model: 'claude-opus-5' }), 0, 'omitted counters default to 0');
  assert.equal(costOf({}), 0, 'even with no model at all');
});

test('an unknown model is still priced (fallback rate), never zeroed or thrown', () => {
  const cost = costOf({ model: 'llama-4-405b-instruct', input: M, output: M });
  assert.equal(cost, FALLBACK_PRICE.in + FALLBACK_PRICE.out);
  assert.ok(cost > 0);
});

test('missing, negative, and non-finite counters are treated as zero', () => {
  assert.equal(costOf({ model: 'claude-opus-5', input: -M, output: NaN, cacheRead: undefined }), 0);
  assert.equal(costOf({ model: 'claude-opus-5', input: M, output: 'lots' }), 5);
  assert.equal(costOf({ model: 'claude-opus-5', input: Infinity }), 0);
});

test('costOf is additive across the four counters', () => {
  const parts = ['input', 'output', 'cacheRead', 'cacheWrite']
    .map((k) => costOf({ model: 'claude-sonnet-5', [k]: 250_000 }))
    .reduce((a, b) => a + b, 0);
  const together = costOf({
    model: 'claude-sonnet-5', input: 250_000, output: 250_000, cacheRead: 250_000, cacheWrite: 250_000,
  });
  assert.equal(together, parts);
});

test('costOf never throws on junk input', () => {
  assert.doesNotThrow(() => costOf());
  assert.doesNotThrow(() => costOf(null));
  assert.doesNotThrow(() => costOf({ model: {}, input: {}, output: [] }));
  assert.equal(costOf(null), 0);
});
