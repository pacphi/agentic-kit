// Task 10: dashboard panel + About chip for ruflo components (ADR-0058).
// Payload logic (rufloComponentsPayload) is already covered by
// tests/kit/ruflo-components-snapshot.test.mjs (Task 9's shared projection —
// controller ruling 1), so this file covers only the dashboard-specific
// surface: the route registration and the client bundle renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JS } from '../../src/lib/dashboard/client.mjs';

const src = fs.readFileSync(new URL('../../src/lib/dashboard/client/ruflo-components.mjs', import.meta.url), 'utf8');

test('bundle includes the ruflo components renderer', () => {
  assert.match(JS, /function renderRufloComponents\(/);
});

test('each card renders the state label beside its meaning, never alone', () => {
  assert.match(src, /state\.label/);
  assert.match(src, /state\.meaning/);
  assert.match(src, /rc-meaning/);
});

test('renderer escapes every server string', () => {
  for (const field of ['c.label', 'c.state.label', 'c.state.meaning', 'c.value', 'e.detail', 'o.detail']) {
    assert.ok(src.includes(`esc(${field})`), field);
  }
});

test('dashboard stays read-only: no POST from the panel', () => {
  assert.doesNotMatch(src, /method:\s*["']POST/);
});

test('server registers the route', () => {
  assert.match(fs.readFileSync(new URL('../../src/lib/dashboard-server.mjs', import.meta.url), 'utf8'),
    /'\/api\/ruflo-components': handleRufloComponents/);
});
