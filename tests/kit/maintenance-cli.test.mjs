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

test('maintain is porcelain and its help advertises exact guarded actions', () => {
  const help = spawnSync(process.execPath, [BIN, 'maintain', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /ak maintain scan/);
  assert.match(help.stdout, /apply.*--plan.*--digest.*--actions.*--yes/i);
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

test('executable plan persistence is explicit', async () => {
  const calls = [];
  const service = { async plan(options) {
    calls.push(options);
    return { mode: 'executable', planId: 'maintenance-plan-a', planDigest: 'digest-a',
      sourceFingerprint: 'source-a', safetyClass: 'approval-required', actions: [] };
  } };
  const result = await captureLogs(() => run({
    flags: { json: true, executable: true, findings: 'a' }, positionals: ['plan'], deps: { service },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [{ deep: false, findingIds: ['a'], project: null, executable: true, persist: true }]);
});

test('apply requires and forwards exact plan, digest, actions, and confirmation', async () => {
  const calls = [];
  const service = { async apply(options) { calls.push(options); return { ok: true, status: 'committed', receiptId: 'mnt-a' }; } };
  const missing = await captureLogs(() => run({ flags: {}, positionals: ['apply'], deps: { service } }));
  assert.equal(missing.code, 2);
  assert.match(missing.text, /--plan.*--digest.*--actions.*--yes/i);
  const result = await captureLogs(() => run({
    flags: { json: true, plan: 'maintenance-plan-a', digest: 'digest-a', actions: 'b,a', yes: true },
    positionals: ['apply'], deps: { service },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [{
    planId: 'maintenance-plan-a', expectedPlanDigest: 'digest-a', actionIds: ['a', 'b'], confirmed: true,
  }]);
  assert.equal(JSON.parse(result.text).receiptId, 'mnt-a');
});

test('undo requires a receipt and explicit confirmation', async () => {
  const calls = [];
  const service = { async undo(options) { calls.push(options); return { ok: true, status: 'rolled-back', receiptId: 'mnt-a' }; } };
  const missing = await captureLogs(() => run({ flags: { receipt: 'mnt-a' }, positionals: ['undo'], deps: { service } }));
  assert.equal(missing.code, 2);
  assert.match(missing.text, /--receipt.*--yes/i);
  const result = await captureLogs(() => run({
    flags: { json: true, receipt: 'mnt-a', yes: true }, positionals: ['undo'], deps: { service },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [{ receiptId: 'mnt-a', confirmed: true }]);
});
