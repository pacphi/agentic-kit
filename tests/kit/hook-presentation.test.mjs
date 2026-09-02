import test from 'node:test';
import assert from 'node:assert/strict';

import { presentHookFinding } from '../../src/lib/hook-presentation.mjs';

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
