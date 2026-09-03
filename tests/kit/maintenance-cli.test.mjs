import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { run } from '../../src/commands/maintain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'bin', 'agentic-kit.mjs');

async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const code = await fn();
    return { code, text: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

const readModel = {
  schemaVersion: 1,
  mode: 'read-only',
  capabilities: { plan: true, apply: false, undo: false },
  asOf: '2026-09-03T12:00:00.000Z',
  freshness: { status: 'fresh', completeness: 'complete', gaps: [] },
  sourceFingerprint: 'source-a',
  summary: { updatesReady: 0, safeCleanup: 1, needsReview: 0, unsupportedOrBlocked: 0, recentChanges: 0 },
  findings: [{ id: 'finding-a', state: 'orphaned-cache', bucket: 'safeCleanup',
    resource: { id: 'cache:a', kind: 'regenerable-cache', name: 'Cache A' } }],
  receipts: [],
};

test('maintain is porcelain and its help advertises the read-only boundary', () => {
  const help = spawnSync(process.execPath, [BIN, 'maintain', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /ak maintain scan/);
  assert.match(help.stdout, /apply.*not enabled/i);
  const rootHelp = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(rootHelp.stdout, /ak maintain/);
});

test('scan delegates deep explicitly and emits the read DTO as JSON', async () => {
  const calls = [];
  const service = { async scan(options) { calls.push(options); return readModel; } };
  const result = await captureLogs(() => run({
    flags: { json: true, deep: true }, positionals: ['scan'], deps: { service },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [{ deep: true }]);
  assert.equal(JSON.parse(result.text).mode, 'read-only');
});

test('plan passes exact finding selection and emits an immutable-plan envelope', async () => {
  const calls = [];
  const service = { async plan(options) {
    calls.push(options);
    return { schemaVersion: 1, mode: 'read-only', planId: 'plan-a', planDigest: 'digest-a',
      sourceFingerprint: 'source-a', safetyClass: 'safe-automatic', actions: [] };
  } };
  const result = await captureLogs(() => run({
    flags: { json: true, findings: 'b,a', project: '/repo' },
    positionals: ['plan'], deps: { service },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [{ deep: false, findingIds: ['a', 'b'], project: '/repo' }]);
  assert.equal(JSON.parse(result.text).planId, 'plan-a');
});

for (const verb of ['apply', 'undo']) {
  test(`${verb} fails clearly because mutation is not enabled`, async () => {
    const result = await captureLogs(() => run({
      flags: {}, positionals: [verb], deps: { service: {} },
    }));
    assert.equal(result.code, 2);
    assert.match(result.text, /not enabled.*read-only/i);
  });
}
