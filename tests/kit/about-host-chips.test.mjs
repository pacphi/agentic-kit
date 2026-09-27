// `ak about` host chips (ADR-0026 twin of the dashboard About cards) read the
// same management words as every other host surface (ADR-0053, 2026-09-26):
// an installed host ak does not manage is "Found, not managed", never a bare
// "installed", and an absent unmanaged host is not told that ak setup adds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipText, hostAboutState } from '../../src/commands/about.mjs';

test('a managed host chip says so, with its version', () => {
  assert.equal(chipText(hostAboutState({ method: 'npm', version: '2.1.3' }, true)), 'Managed by ak · v2.1.3');
  assert.equal(chipText(hostAboutState({ method: 'absent', version: null }, true)),
    'Managed by ak · not installed — ak sync installs it');
});

test('an unmanaged host chip reads Found, not managed or Not installed', () => {
  const found = hostAboutState({ method: 'external', version: '0.9.0' }, false);
  assert.equal(chipText(found), 'Found, not managed · v0.9.0');
  assert.equal(found.management, 'found');
  assert.equal(chipText(hostAboutState({ method: 'absent', version: null }, false)), 'Not installed');
});

test('unknown management keeps the plain presence chip rather than guessing', () => {
  assert.equal(chipText(hostAboutState({ method: 'npm', version: '1.0.0' }, null)), 'installed · v1.0.0');
});
