import test from 'node:test';
import assert from 'node:assert/strict';

import { presentHookFinding, upstreamConstraintIdFor } from '../../src/lib/hook-presentation.mjs';

test('hook findings use bounded user-facing language instead of internal codes', () => {
  assert.deepEqual(presentHookFinding('dynamic-shell'), {
    title: 'Shell expansion needs review',
    explanation: 'This definition uses a shell wrapper, so expansion, working directory, and environment behavior need source-owner review.',
  });
  assert.equal(presentHookFinding('sessionend-timeout-clamped').title,
    'Declared timeout exceeds the host limit');
  assert.equal(presentHookFinding('aqe-npx-hot-path-fallback').title,
    'Hook may resolve a package when it runs');
});

test('unknown diagnostic codes remain honest and bounded', () => {
  assert.deepEqual(presentHookFinding('vendor-secret-new-code'), {
    title: 'Unclassified configuration finding',
    explanation: 'The static audit recorded a finding that this dashboard does not yet describe. Inspect the referenced definition and use the code for support.',
  });
});

test('AQE generator findings name no upstream constraint after the agentic-qe#654 sunset; Ruflo\'s still does', () => {
  // agentic-qe-3.14.0-stop-hook-generator was sunset once AQE 3.14.4 passed the
  // offline Stop conformance (tests/live/aqe-stop-hook-conformance.test.mjs).
  assert.equal(upstreamConstraintIdFor('aqe-npx-hot-path-fallback'), null);
  assert.equal(upstreamConstraintIdFor('aqe-claude-timeout-unit-mismatch'), null);
  assert.equal(upstreamConstraintIdFor('ruflo-codex-stop-output-not-json'), 'ruflo-3.38.20-stop-output-contract');
});
