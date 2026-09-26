// The Observability "Sources" inspector formats adapter health in the browser
// bundle. These two single-line helpers are extracted and evaluated directly,
// the same way text-safety.test.mjs checks the live escaper (#237 §E).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const client = fs.readFileSync(path.join(ROOT, 'src/lib/dashboard/live/client.mjs'), 'utf8');
const extract = (name) => {
  const line = client.split('\n').find((l) => l.trim().startsWith(`function ${name}(`));
  assert.ok(line, `guard: ${name} must stay a single-line function declaration`);
  return new Function(`return (${line.trim().replace(new RegExp(`^function ${name}`), 'function')});`)();
};

test('source health text keeps the established counters and adds presence only when it differs', () => {
  const summary = extract('liveHealthSummary');
  assert.equal(summary({ status: 'ok', files: 2, events: 8, errors: 0 }),
    'ok · 2 files · 8 events · 0 errors', 'rows without the new fields render exactly as before');
  assert.equal(summary({ status: 'ok', files: 2, readable: 2, events: 8, errors: 0 }),
    'ok · 2 files · 8 events · 0 errors');
  assert.equal(summary({ status: 'awaiting-file', files: 1, readable: 0, events: 0, errors: 0 }),
    'awaiting file · 0 of 1 files readable · 0 events · 0 errors');
  assert.equal(summary({ status: 'no-events', files: 1, readable: 1, events: 0, errors: 0 }),
    'no events yet · 1 files · 0 events · 0 errors');
  assert.equal(summary({ status: 'degraded', files: 1, readable: 1, events: 0, errors: 0, rejected: 3 }),
    'degraded · 1 files · 0 events · 0 errors · 3 rejected');
});

test('source health text says when the tailed files are only the newest of more', () => {
  const summary = extract('liveHealthSummary');
  assert.equal(summary({ status: 'ok', files: 128, readable: 128, candidateFiles: 257, events: 9, errors: 0 }),
    'ok · 128 files (newest of 257) · 9 events · 0 errors');
  assert.equal(summary({ status: 'ok', files: 3, readable: 3, candidateFiles: 3, events: 9, errors: 0 }),
    'ok · 3 files · 9 events · 0 errors', 'nothing is added when every discovered file is tailed');
});

test('the Sources toggle counts degraded sources as issues and awaiting files separately', () => {
  const toggle = extract('liveHealthToggle');
  assert.equal(toggle({ claude: { status: 'ok' }, 'codex-state': { status: 'unavailable' } }), 'Sources',
    'an optional source absent on this machine is not an issue');
  assert.equal(toggle({ ruflo: { status: 'degraded' }, aqe: { status: 'awaiting-file' } }), '1 source issue');
  assert.equal(toggle({ ruflo: { status: 'degraded' }, codex: { status: 'error' } }), '2 source issues');
  assert.equal(toggle({ ruflo: { status: 'awaiting-file' }, aqe: { status: 'awaiting-file' } }),
    '2 sources awaiting file');
  assert.equal(toggle({ ruflo: { status: 'awaiting-file' } }), '1 source awaiting file');
  assert.equal(toggle(null), 'Sources');
});
