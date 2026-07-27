// The Sonnet 5 introductory-pricing time bomb, armed as a TEST instead of a
// comment. pricing.mjs carries Sonnet 5 at the launch $2/$10 with a note that
// it must revert to the standard $3/$15 on 2026-09-01 — a promise nothing
// enforced. This test is the enforcement: it passes while the promo window is
// open, and FAILS THE SUITE from 2026-09-01 onward until the table is updated
// (at which point the assertion flips to pinning the standard rate).
//
// Deliberately reads the real clock — that is the entire point of the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor } from '../../src/lib/pricing.mjs';

const REVERT_DATE = Date.parse('2026-09-01T00:00:00Z');

test('sonnet-5 pricing matches its calendar: intro $2/$10 before 2026-09-01, standard $3/$15 after', () => {
  const p = priceFor('claude-sonnet-5', 'claude');
  assert.ok(p && p.matched, 'sonnet-5 must have a real price row');
  if (Date.now() < REVERT_DATE) {
    assert.equal(p.in, 2, 'intro input rate while the launch window is open');
    assert.equal(p.out, 10, 'intro output rate while the launch window is open');
  } else {
    assert.equal(p.in, 3,
      'the Sonnet 5 introductory price expired 2026-09-01 — update PRICES in pricing.mjs '
      + '(anthropic(3, 15)) and PRICES_AS_OF, then keep this assertion as the pin');
    assert.equal(p.out, 15,
      'the Sonnet 5 introductory price expired 2026-09-01 — update PRICES in pricing.mjs');
  }
});
