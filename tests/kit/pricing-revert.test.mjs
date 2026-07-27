// Published rate changes, pinned at their BOUNDARIES.
//
// This file used to be a time bomb: it read the wall clock and failed the suite
// from 2026-09-01 onward until a human edited the Sonnet 5 rate. That worked as
// a reminder but was a bad test — it would go red on a calendar date with no
// code change, and CI red-for-a-reason-that-is-not-a-defect trains people to
// ignore CI.
//
// The dated schedule in pricing.mjs removes the need for it. A published change
// is DATA now, so what needs proving is that the boundary behaves: the day
// before takes the old rate, the day of takes the new one, and — the part that
// actually matters for a usage panel — a finished window keeps the rate it was
// metered at forever, rather than being restated the moment the change lands.
//
// Nothing here reads a clock, so these assertions are stable for all time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, costOf, PRICES, PRICES_AS_OF } from '../../src/lib/pricing.mjs';

// ── Sonnet 5: introductory $2/$10 → standard $3/$15 on 2026-09-01 ────────────
// Anthropic published this end date; that is the bar for encoding a schedule.

test('sonnet-5 prices at the introductory rate on the last day of the promo', () => {
  const p = priceFor('claude-sonnet-5', 'claude', '2026-08-31');
  assert.deepEqual([p.in, p.out], [2, 10]);
});

test('sonnet-5 prices at the standard rate on the first day after it', () => {
  const p = priceFor('claude-sonnet-5', 'claude', '2026-09-01');
  assert.deepEqual([p.in, p.out], [3, 15]);
});

test('sonnet-5 stays on the standard rate well beyond the boundary', () => {
  const p = priceFor('claude-sonnet-5', 'claude', '2027-03-14');
  assert.deepEqual([p.in, p.out], [3, 15]);
});

test('a day before any dated period falls to the opening rate', () => {
  const p = priceFor('claude-sonnet-5', 'claude', '2026-01-01');
  assert.deepEqual([p.in, p.out], [2, 10]);
});

// ── The property the schedule exists to protect ──────────────────────────────

test('a finished window is NOT restated when a later rate change takes effect', () => {
  // Same tokens, same model. Priced on the day they were spent, an August row
  // must read identically whether the reader opens the panel in August or in
  // December. A clock-driven table would inflate this by 50% on 2026-09-01.
  const august = { model: 'claude-sonnet-5', provider: 'claude', day: '2026-08-15', input: 1_000_000, output: 1_000_000 };
  assert.equal(costOf(august), 2 + 10);
  // ...while tokens genuinely spent after the boundary carry the new rate.
  assert.equal(costOf({ ...august, day: '2026-09-15' }), 3 + 15);
});

test('the day is what selects the rate — not the order rows are priced in', () => {
  const rows = ['2026-09-15', '2026-08-15', '2026-09-01', '2026-08-31']
    .map((day) => costOf({ model: 'claude-sonnet-5', provider: 'claude', day, input: 1_000_000 }));
  assert.deepEqual(rows, [3, 2, 3, 2]);
});

// ── The dateless default ─────────────────────────────────────────────────────

test('a dateless query prices as of the table verification date, not the newest period', () => {
  // The subtle one. "Newest period" only means "current" once every published
  // change has landed; on a table verified before the boundary it would price
  // Sonnet at a rate nobody is paying yet. PRICES_AS_OF is the honest answer
  // and is the same date the UI prints as "rates as of …".
  const dateless = priceFor('claude-sonnet-5', 'claude');
  const asOf = priceFor('claude-sonnet-5', 'claude', PRICES_AS_OF);
  assert.deepEqual([dateless.in, dateless.out], [asOf.in, asOf.out]);
  const last = PRICES['claude-sonnet-5'].periods.at(-1);
  assert.ok(PRICES_AS_OF < last.from,
    'this assertion is only meaningful while the table predates the boundary — '
    + 'once PRICES_AS_OF passes 2026-09-01 the two coincide and the case is moot');
  assert.notDeepEqual([dateless.in, dateless.out], [last.in, last.out]);
});

test('junk or missing day never throws and never yields a zero rate', () => {
  for (const day of [null, undefined, '', 'not-a-date', 42, {}, 'ate-2026-09-01']) {
    const p = priceFor('claude-sonnet-5', 'claude', day);
    assert.ok(p.in > 0 && p.out > 0, `day=${JSON.stringify(day)} produced ${p.in}/${p.out}`);
  }
});

// ── The mechanism is uniform across providers ────────────────────────────────

test('an undated entry is a one-period schedule and ignores the day entirely', () => {
  // Both vendors: no schedule means the rate is the same on any date. This is
  // what makes the OpenAI table a data question rather than a mechanism gap —
  // if OpenAI ships a dated promo it is one edit, not new machinery.
  for (const id of ['gpt-5.6-sol', 'claude-opus-5']) {
    const early = priceFor(id, undefined, '2020-01-01');
    const late = priceFor(id, undefined, '2030-01-01');
    assert.deepEqual([early.in, early.out], [late.in, late.out], id);
    assert.equal(PRICES[id].periods.length, 1, `${id} should carry a single period`);
  }
});

test('both providers build schedules through the same constructor shape', () => {
  const shapes = new Set(Object.values(PRICES).map((p) => (Array.isArray(p.periods) ? 'schedule' : typeof p)));
  assert.deepEqual([...shapes], ['schedule'],
    'a provider-specific rate shape would mean two code paths through priceFor');
});
