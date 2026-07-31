import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseLiveSources } from '../../src/commands/x/dashboard.mjs';

test('dashboard parses repeatable explicit structured live sources', () => {
  const cwd = path.resolve('/tmp/ak-live-source-fixture');
  assert.deepEqual(parseLiveSources([
    'ruflo=.claude-flow/live.jsonl',
    'aqe=/tmp/aqe.jsonl',
  ], cwd), [
    { surface: 'ruflo', file: path.resolve(cwd, '.claude-flow/live.jsonl') },
    { surface: 'aqe', file: path.resolve('/tmp/aqe.jsonl') },
  ]);
});

test('dashboard rejects ambiguous or unsupported live-source specifications', () => {
  for (const value of ['ruflo', 'plugin=events.jsonl', 'dual-run=plans.jsonl', 'aqe=', '=events.jsonl']) {
    assert.throws(() => parseLiveSources(value, '/tmp'), /invalid --live-source/);
  }
});
