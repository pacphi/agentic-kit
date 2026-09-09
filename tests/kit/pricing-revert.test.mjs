// Vendor cancellation regression plus synthetic dated-schedule mechanics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, costOf, PRICES, PRICES_AS_OF } from '../../src/lib/pricing.mjs';

// Anthropic canceled the September 1 increase; $2/$10 is now standard.
// https://platform.claude.com/docs/en/about-claude/pricing (2026-09-08)
test('Sonnet 5 never applies the canceled September price increase', () => {
  for (const day of ['2026-08-31', '2026-09-01', '2026-09-08', '2027-03-14', undefined]) {
    const p = priceFor('claude-sonnet-5', 'anthropic', day);
    assert.deepEqual([p.in, p.out], [2, 10], String(day));
    assert.equal(costOf({ model: 'claude-sonnet-5', day, input: 1_000_000, output: 1_000_000 }), 12);
  }
  assert.deepEqual(PRICES['claude-sonnet-5'].periods, [{ from: null, in: 2, out: 10 }]);
});

test('dated schedules select historical boundaries and the clock-free default for either provider', () => {
  // Synthetic prices exercise the mechanism without asserting a vendor change.
  for (const model of ['claude-sonnet-5', 'gpt-5.6-sol']) {
    const original = PRICES[model];
    PRICES[model] = { ...original, periods: [
      { from: null, in: 1, out: 5 },
      { from: '2026-09-01', in: 2, out: 10 },
      { from: '2099-01-01', in: 3, out: 15 },
    ] };
    try {
      const rates = ['2026-09-01', '2026-08-31', '2099-01-01', '2026-08-01']
        .map((day) => costOf({ model, day, input: 1_000_000 }));
      assert.deepEqual(rates, [2, 1, 3, 1]);
      assert.deepEqual(priceFor(model), priceFor(model, undefined, PRICES_AS_OF));
      assert.notEqual(priceFor(model).in, 3, 'future period is not the dateless default');
    } finally {
      PRICES[model] = original;
    }
  }
});

test('invalid or omitted dates use the baseline verification date', () => {
  for (const day of [null, undefined, '', 'not-a-date', 42, {}, 'ate-2026-09-01']) {
    assert.deepEqual(priceFor('claude-sonnet-5', undefined, day),
      priceFor('claude-sonnet-5', undefined, PRICES_AS_OF));
  }
});
