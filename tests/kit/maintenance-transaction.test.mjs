import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyMaintenancePlan, undoMaintenanceReceipt,
} from '../../src/lib/maintenance/coordinator.mjs';
import {
  MAINTENANCE_RECEIPT_SCHEMA, createMaintenanceTransaction,
  listUnfinishedMaintenanceReceipts, readMaintenanceReceipt, writeMaintenanceReceipt,
} from '../../src/lib/maintenance/transaction-store.mjs';
import { acquireMaintenanceLock } from '../../src/lib/maintenance/mutation-lock.mjs';

const NOW = Date.parse('2026-09-03T20:00:00.000Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-tx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function action(id, overrides = {}) {
  return {
    id,
    providerId: 'test-provider',
    providerVersion: '1',
    operation: 'disable',
    resource: { kind: 'plugin', id: `plugin-${id}`, host: 'claude', scope: 'user' },
    classification: 'approval-required',
    rollback: 'reversible',
    restart: 'required',
    executable: true,
    sourceFingerprint: `source-${id}`,
    ...overrides,
  };
}

function plan(actions = [action('a')], overrides = {}) {
  return {
    schemaVersion: 1,
    planId: 'maintenance-plan-test',
    planDigest: 'digest-test',
    sourceFingerprint: 'inventory-test',
    generatedAt: '2026-09-03T19:59:00.000Z',
    expiresAt: '2026-09-03T20:04:00.000Z',
    safetyClass: actions[0]?.classification ?? null,
    actions,
    ...overrides,
  };
}

function provider(events, overrides = {}) {
  return {
    id: 'test-provider',
    version: '1',
    async preflight(item) {
      events.push(`preflight:${item.id}`);
      return { ok: true, sourceFingerprint: item.sourceFingerprint };
    },
    async apply(item) {
      events.push(`apply:${item.id}`);
      return { status: 'applied', postFingerprint: `post-${item.id}`, summary: 'changed by native owner' };
    },
    async verify(item, outcome) {
      events.push(`verify:${item.id}`);
      return { ok: true, postFingerprint: outcome.postFingerprint };
    },
    async undo(entry) {
      events.push(`undo:${entry.actionId}`);
      return { status: 'restored', sourceFingerprint: entry.sourceFingerprint };
    },
    async verifyUndo(entry) {
      events.push(`verify-undo:${entry.actionId}`);
      return { ok: true, sourceFingerprint: entry.sourceFingerprint };
    },
    ...overrides,
  };
}

const registry = (p) => new Map([[p.id, p]]);

test('apply refuses stale, tampered, duplicate, mixed, and unavailable selections before providers run', async (t) => {
  const root = fixture(t);
  const cases = [
    { input: { expectedPlanDigest: 'wrong' }, status: 'preflight-refused' },
    { input: { now: () => NOW + 10 * 60_000 }, status: 'preflight-refused' },
    { input: { actionIds: ['a', 'a'] }, status: 'preflight-refused' },
    {
      input: { plan: plan([action('a'), action('b', { classification: 'safe-automatic' })]), actionIds: ['a', 'b'] },
      status: 'preflight-refused',
    },
    {
      input: { plan: plan([action('a', { executable: false })]) },
      status: 'preflight-refused',
    },
  ];
  for (const [index, row] of cases.entries()) {
    const events = [];
    const p = provider(events);
    const selectedPlan = row.input.plan ?? plan();
    const result = await applyMaintenancePlan({
      plan: selectedPlan,
      actionIds: row.input.actionIds ?? ['a'],
      expectedPlanDigest: row.input.expectedPlanDigest ?? selectedPlan.planDigest,
      providers: registry(p),
      transactionsRoot: path.join(root, String(index)),
      refreshPlan: async () => selectedPlan,
      now: row.input.now ?? (() => NOW),
      nonce: () => `n${index}`,
    });
    assert.equal(result.status, row.status);
    assert.deepEqual(events, []);
  }
});

test('all actions preflight before the first effect and success is verified and receipted', async (t) => {
  const root = fixture(t);
  const events = [];
  const selectedPlan = plan([action('a'), action('b')]);
  const result = await applyMaintenancePlan({
    plan: selectedPlan, actionIds: ['b', 'a'], expectedPlanDigest: selectedPlan.planDigest,
    providers: registry(provider(events)), transactionsRoot: root,
    refreshPlan: async () => selectedPlan, now: () => NOW, nonce: () => 'success',
  });
  assert.equal(result.status, 'committed');
  assert.deepEqual(events, [
    'preflight:a', 'preflight:b', 'apply:a', 'verify:a', 'apply:b', 'verify:b',
  ]);
  const loaded = readMaintenanceReceipt(root, result.receiptId);
  assert.equal(loaded.receipt.status, 'committed');
  assert.equal(loaded.receipt.actions.every((entry) => entry.state === 'verified'), true);
  assert.equal(loaded.receipt.actions[0].outcome.summary, 'changed by native owner');
  assert.equal('command' in loaded.receipt.actions[0], false);
  assert.deepEqual(listUnfinishedMaintenanceReceipts(root), []);
  assert.equal(fs.statSync(root).mode & 0o077, 0);
  assert.equal(fs.statSync(loaded.file).mode & 0o077, 0);
});

test('live plan drift refuses after preflight and before apply', async (t) => {
  const root = fixture(t);
  const events = [];
  const selectedPlan = plan();
  const result = await applyMaintenancePlan({
    plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
    providers: registry(provider(events)), transactionsRoot: root,
    refreshPlan: async () => ({ ...selectedPlan, planDigest: 'changed' }),
    now: () => NOW, nonce: () => 'drift',
  });
  assert.equal(result.status, 'preflight-refused');
  assert.deepEqual(events, ['preflight:a']);
});

test('verified failures compensate in reverse order while uncertain outcomes require recovery', async (t) => {
  const root = fixture(t);
  const events = [];
  const selectedPlan = plan([action('a'), action('b'), action('c')]);
  const p = provider(events, {
    async apply(item) {
      events.push(`apply:${item.id}`);
      if (item.id === 'c') return { status: 'refused', summary: 'native owner refused before changing state' };
      return { status: 'applied', postFingerprint: `post-${item.id}` };
    },
  });
  const result = await applyMaintenancePlan({
    plan: selectedPlan, actionIds: ['a', 'b', 'c'], expectedPlanDigest: selectedPlan.planDigest,
    providers: registry(p), transactionsRoot: root,
    refreshPlan: async () => selectedPlan, now: () => NOW, nonce: () => 'rollback',
  });
  assert.equal(result.status, 'rolled-back');
  assert.deepEqual(events.slice(-4), ['undo:b', 'verify-undo:b', 'undo:a', 'verify-undo:a']);

  const uncertainEvents = [];
  const uncertainPlan = plan([action('a')], { planId: 'uncertain', planDigest: 'uncertain-digest' });
  const uncertain = await applyMaintenancePlan({
    plan: uncertainPlan, actionIds: ['a'], expectedPlanDigest: uncertainPlan.planDigest,
    providers: registry(provider(uncertainEvents, {
      async apply(item) {
        uncertainEvents.push(`apply:${item.id}`);
        return { status: 'unknown', summary: 'process outcome unavailable' };
      },
    })),
    transactionsRoot: path.join(root, 'uncertain'),
    refreshPlan: async () => uncertainPlan, now: () => NOW, nonce: () => 'uncertain',
  });
  assert.equal(uncertain.status, 'partial-recovery-required');
  assert.deepEqual(uncertainEvents, ['preflight:a', 'apply:a']);
  assert.equal(listUnfinishedMaintenanceReceipts(path.join(root, 'uncertain')).length, 1);
});

test('a provider exception after dispatch is an unknown outcome and is never retried or blindly rolled back', async (t) => {
  const root = fixture(t);
  const events = [];
  const selectedPlan = plan();
  const result = await applyMaintenancePlan({
    plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
    providers: registry(provider(events, {
      async apply(item) { events.push(`apply:${item.id}`); throw new Error('connection ended after dispatch'); },
    })),
    transactionsRoot: root, refreshPlan: async () => selectedPlan,
    now: () => NOW, nonce: () => 'dispatch-error',
  });
  assert.equal(result.status, 'partial-recovery-required');
  assert.deepEqual(events, ['preflight:a', 'apply:a']);
  const { receipt } = readMaintenanceReceipt(root, result.receiptId);
  assert.equal(receipt.actions[0].state, 'outcome-unknown');
});

test('guarded undo verifies current postimage and refuses drift without calling provider undo', async (t) => {
  const root = fixture(t);
  const events = [];
  const p = provider(events);
  const selectedPlan = plan();
  const applied = await applyMaintenancePlan({
    plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
    providers: registry(p), transactionsRoot: root,
    refreshPlan: async () => selectedPlan, now: () => NOW, nonce: () => 'undoable',
  });
  events.length = 0;
  const drifted = await undoMaintenanceReceipt({
    transactionsRoot: root, receiptId: applied.receiptId, providers: registry(p),
    inspectCurrent: async () => ({ postFingerprint: 'later-user-change' }),
    refreshAffectedCatalog: async () => ({ ok: true }),
    now: () => NOW + 1,
  });
  assert.equal(drifted.status, 'drift-refused');
  assert.deepEqual(events, []);

  const undone = await undoMaintenanceReceipt({
    transactionsRoot: root, receiptId: applied.receiptId, providers: registry(p),
    inspectCurrent: async (entry) => ({ postFingerprint: entry.outcome.postFingerprint }),
    refreshAffectedCatalog: async () => ({ ok: true }),
    now: () => NOW + 2,
  });
  assert.equal(undone.status, 'rolled-back');
  assert.deepEqual(events, ['undo:a', 'verify-undo:a']);
});

test('receipt seal tampering and an active mutation lock fail closed', async (t) => {
  const root = fixture(t);
  const events = [];
  const p = provider(events);
  const selectedPlan = plan();
  const applied = await applyMaintenancePlan({
    plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
    providers: registry(p), transactionsRoot: root,
    refreshPlan: async () => selectedPlan, now: () => NOW, nonce: () => 'sealed',
  });
  const loaded = readMaintenanceReceipt(root, applied.receiptId);
  fs.writeFileSync(loaded.file, fs.readFileSync(loaded.file, 'utf8').replace('committed', 'tampered'));
  assert.throws(() => readMaintenanceReceipt(root, applied.receiptId), /integrity/i);

  const lockedRoot = path.join(root, 'locked');
  fs.mkdirSync(path.join(lockedRoot, '.mutation-lock'), { recursive: true, mode: 0o700 });
  const locked = await applyMaintenancePlan({
    plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
    providers: registry(provider([])), transactionsRoot: lockedRoot,
    refreshPlan: async () => selectedPlan, now: () => NOW, nonce: () => 'locked',
  });
  assert.equal(locked.status, 'busy');

  const relative = await applyMaintenancePlan({
    plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
    providers: registry(provider([])), transactionsRoot: 'relative-transactions',
    refreshPlan: async () => selectedPlan, now: () => NOW,
  });
  assert.equal(relative.status, 'preflight-refused');
});

test('provider availability and fresh-state checks fail before transaction creation', async (t) => {
  const root = fixture(t);
  const selectedPlan = plan();
  const cases = [
    {
      providers: new Map(),
      expected: /provider is unavailable/,
    },
    {
      providers: registry(provider([], { version: '2' })),
      expected: /provider is unavailable/,
    },
    {
      providers: registry(provider([], { preflight: undefined })),
      expected: /cannot preflight/,
    },
    {
      providers: registry(provider([], { async preflight() { return { ok: false }; } })),
      expected: /source state changed/,
    },
  ];
  for (const [index, row] of cases.entries()) {
    const result = await applyMaintenancePlan({
      plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
      providers: row.providers, transactionsRoot: path.join(root, String(index)),
      refreshPlan: async () => selectedPlan, now: () => NOW, nonce: () => String(index),
    });
    assert.equal(result.status, 'preflight-refused');
    assert.match(result.error, row.expected);
  }
});

test('verification failure rolls back, while irreversible and failed compensation stay recovery-required', async (t) => {
  const root = fixture(t);
  for (const [name, rollback, overrides, expectedState] of [
    ['reversible', 'reversible', { async verify() { return { ok: false }; } }, 'rolled-back'],
    ['irreversible', 'irreversible', { async verify() { return { ok: false }; } }, 'recovery-unavailable'],
    ['rollback-fails', 'reversible', {
      async verify() { return { ok: false }; },
      async undo() { throw new Error('compensation failed'); },
    }, 'rollback-failed'],
  ]) {
    const events = [];
    const selectedPlan = plan([action('a', { rollback })], { planDigest: `digest-${name}` });
    const result = await applyMaintenancePlan({
      plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
      providers: registry(provider(events, overrides)), transactionsRoot: path.join(root, name),
      refreshPlan: async () => selectedPlan, now: () => NOW, nonce: () => name,
    });
    assert.equal(result.status, name === 'reversible' ? 'rolled-back' : 'partial-recovery-required');
    const { receipt } = readMaintenanceReceipt(path.join(root, name), result.receiptId);
    assert.equal(receipt.actions[0].state, expectedState);
  }
});

test('undo rejects ineligible receipts, busy state, providers, outcomes, and verification', async (t) => {
  const root = fixture(t);
  const makeApplied = async (name) => {
    const selectedPlan = plan([], { planId: name, planDigest: `digest-${name}`, actions: [action('a')] });
    return applyMaintenancePlan({
      plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
      providers: registry(provider([])), transactionsRoot: path.join(root, name),
      refreshPlan: async () => selectedPlan, now: () => NOW, nonce: () => name,
    });
  };

  const missing = await undoMaintenanceReceipt({ transactionsRoot: path.join(root, 'none'), receiptId: 'bad' });
  assert.equal(missing.status, 'receipt-refused');

  const noInspectorApplied = await makeApplied('no-inspector');
  const noInspector = await undoMaintenanceReceipt({
    transactionsRoot: path.join(root, 'no-inspector'), receiptId: noInspectorApplied.receiptId,
    providers: registry(provider([])),
  });
  assert.equal(noInspector.status, 'preflight-refused');

  const unavailableApplied = await makeApplied('unavailable');
  const unavailable = await undoMaintenanceReceipt({
    transactionsRoot: path.join(root, 'unavailable'), receiptId: unavailableApplied.receiptId,
    providers: new Map(), inspectCurrent: async (entry) => ({ postFingerprint: entry.outcome.postFingerprint }),
    refreshAffectedCatalog: async () => ({ ok: true }),
  });
  assert.equal(unavailable.status, 'preflight-refused');

  const busyApplied = await makeApplied('undo-busy');
  fs.mkdirSync(path.join(root, 'undo-busy', '.mutation-lock'));
  const busy = await undoMaintenanceReceipt({
    transactionsRoot: path.join(root, 'undo-busy'), receiptId: busyApplied.receiptId,
    providers: registry(provider([])), inspectCurrent: async (entry) => ({ postFingerprint: entry.outcome.postFingerprint }),
  });
  assert.equal(busy.status, 'busy');

  for (const [name, overrides, expected] of [
    ['bad-undo-outcome', { async undo() { return { status: 'unknown' }; } }, /undo outcome unknown/],
    ['bad-undo-verify', { async verifyUndo() { return { ok: false }; } }, /undo verification failed/],
  ]) {
    const applied = await makeApplied(name);
    const result = await undoMaintenanceReceipt({
      transactionsRoot: path.join(root, name), receiptId: applied.receiptId,
      providers: registry(provider([], overrides)),
      inspectCurrent: async (entry) => ({ postFingerprint: entry.outcome.postFingerprint }),
      refreshAffectedCatalog: async () => ({ ok: true }),
      now: () => NOW + 1,
    });
    assert.equal(result.status, 'partial-recovery-required');
    assert.match(result.error, expected);
  }
});

test('transaction store rejects broad roots, unsafe identities, oversized data, and exposes corrupt recovery state', (t) => {
  const root = fixture(t);
  const defaults = createMaintenanceTransaction(path.join(root, 'defaults'));
  assert.match(defaults.id, /^mnt-/);
  assert.throws(() => createMaintenanceTransaction(path.parse(root).root), /dedicated/);
  assert.throws(() => createMaintenanceTransaction('relative'), /absolute/);
  assert.throws(() => readMaintenanceReceipt(root, '../escape'), /invalid.*id/);

  const transaction = createMaintenanceTransaction(root, { now: () => new Date(NOW), nonce: () => 'store' });
  assert.throws(() => writeMaintenanceReceipt(transaction.file, { id: transaction.id }), /schema/);
  const base = {
    schemaVersion: MAINTENANCE_RECEIPT_SCHEMA, id: transaction.id, status: 'prepared',
    actions: [], detail: 'x'.repeat(1024 * 1024),
  };
  assert.throws(() => writeMaintenanceReceipt(transaction.file, base), /size limit/);

  writeMaintenanceReceipt(transaction.file, { ...base, detail: 'bounded' });
  const source = fs.readFileSync(transaction.file, 'utf8');
  fs.writeFileSync(transaction.file, source.replace(transaction.id, `${transaction.id}-different`));
  assert.throws(() => readMaintenanceReceipt(root, transaction.id), /identity mismatch/);
  assert.equal(listUnfinishedMaintenanceReceipts(root)[0].status, 'unknown-recovery-required');

  assert.throws(() => acquireMaintenanceLock('relative'), /absolute/);
  assert.throws(() => acquireMaintenanceLock(path.parse(root).root), /dedicated/);
  const lockRoot = path.join(root, 'release');
  const lock = acquireMaintenanceLock(lockRoot);
  lock.release();
  lock.release();
});

test('journal and lock I/O failures remain explicit and do not masquerade as success', async (t) => {
  const root = fixture(t);
  const selectedPlan = plan();
  let renames = 0;
  const journalFs = new Proxy(fs, {
    get(target, key) {
      if (key === 'renameSync') return (...args) => {
        renames += 1;
        if (renames === 4) throw Object.assign(new Error('journal disk failure'), { code: 'EIO' });
        return target.renameSync(...args);
      };
      return target[key];
    },
  });
  const result = await applyMaintenancePlan({
    plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
    providers: registry(provider([], { async apply() { return { status: 'refused' }; } })),
    transactionsRoot: path.join(root, 'journal'), refreshPlan: async () => selectedPlan,
    fsImpl: journalFs, now: () => NOW, nonce: () => 'journal',
  });
  assert.equal(result.status, 'partial-recovery-required');
  assert.match(result.error, /recovery journal failed/);

  const transaction = createMaintenanceTransaction(path.join(root, 'write-failure'), {
    now: () => new Date(NOW), nonce: () => 'write-failure',
  });
  const writeFailureFs = new Proxy(fs, {
    get(target, key) {
      if (key === 'writeFileSync') return () => { throw new Error('write failed'); };
      return target[key];
    },
  });
  assert.throws(() => writeMaintenanceReceipt(transaction.file, {
    schemaVersion: MAINTENANCE_RECEIPT_SCHEMA, id: transaction.id, status: 'prepared', actions: [],
  }, { fsImpl: writeFailureFs }), /write failed/);

  const lockFailureFs = new Proxy(fs, {
    get(target, key) {
      if (key === 'mkdirSync') return (targetPath, options) => {
        if (String(targetPath).endsWith('.mutation-lock')) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return target.mkdirSync(targetPath, options);
      };
      return target[key];
    },
  });
  assert.throws(() => acquireMaintenanceLock(path.join(root, 'lock-failure'), { fsImpl: lockFailureFs }), /permission denied/);
});

test('undo refuses an unfinished receipt and recognizes an already rolled-back receipt', async (t) => {
  const root = fixture(t);
  const selectedPlan = plan();
  const uncertain = await applyMaintenancePlan({
    plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
    providers: registry(provider([], { async apply() { return { status: 'unknown' }; } })),
    transactionsRoot: path.join(root, 'unfinished'), refreshPlan: async () => selectedPlan,
    now: () => NOW, nonce: () => 'unfinished',
  });
  const refused = await undoMaintenanceReceipt({
    transactionsRoot: path.join(root, 'unfinished'), receiptId: uncertain.receiptId,
    providers: registry(provider([])), inspectCurrent: async () => ({}),
  });
  assert.equal(refused.status, 'receipt-refused');

  const doneRoot = path.join(root, 'done');
  const applied = await applyMaintenancePlan({
    plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
    providers: registry(provider([])), transactionsRoot: doneRoot,
    refreshPlan: async () => selectedPlan, now: () => NOW, nonce: () => 'done',
  });
  const undone = await undoMaintenanceReceipt({
    transactionsRoot: doneRoot, receiptId: applied.receiptId,
    providers: registry(provider([])),
    inspectCurrent: async (entry) => ({ postFingerprint: entry.outcome.postFingerprint }),
    refreshAffectedCatalog: async () => ({ ok: true }),
  });
  assert.equal(undone.status, 'rolled-back');
  const repeated = await undoMaintenanceReceipt({ transactionsRoot: doneRoot, receiptId: applied.receiptId });
  assert.equal(repeated.status, 'already-rolled-back');
});

function receiptDuringLock(root, makeReceipt) {
  let injected = false;
  return new Proxy(fs, {
    get(target, key) {
      if (key === 'mkdirSync') return (targetPath, options) => {
        const result = target.mkdirSync(targetPath, options);
        if (!injected && String(targetPath).endsWith('.mutation-lock')) {
          injected = true;
          makeReceipt();
        }
        return result;
      };
      return target[key];
    },
  });
}

function injectedReceipt(root, selectedPlan, status, nonce) {
  const transaction = createMaintenanceTransaction(root, {
    now: () => new Date(NOW), nonce: () => nonce,
  });
  const timestamp = new Date(NOW).toISOString();
  return writeMaintenanceReceipt(transaction.file, {
    schemaVersion: MAINTENANCE_RECEIPT_SCHEMA,
    id: transaction.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    status,
    planId: selectedPlan.planId,
    planDigest: selectedPlan.planDigest,
    sourceFingerprint: selectedPlan.sourceFingerprint,
    authorization: { mechanism: 'exact-plan-selection', actionIds: ['a'] },
    actions: [],
    verification: null,
  });
}

test('apply repeats unfinished and replay authorization reads under the acquired lock', async (t) => {
  const root = fixture(t);
  for (const [name, status, expected] of [
    ['unfinished', 'prepared', /requires recovery/i],
    ['replay', 'committed', /already consumed/i],
  ]) {
    const selectedPlan = plan([], {
      planId: `plan-${name}`, planDigest: `digest-${name}`, actions: [action('a')],
    });
    const events = [];
    const transactionsRoot = path.join(root, name);
    const fsImpl = receiptDuringLock(transactionsRoot, () => {
      injectedReceipt(transactionsRoot, selectedPlan, status, name);
    });
    const result = await applyMaintenancePlan({
      plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
      providers: registry(provider(events)), transactionsRoot,
      refreshPlan: async () => selectedPlan, fsImpl, now: () => NOW, nonce: () => `new-${name}`,
    });
    assert.equal(result.status, 'preflight-refused');
    assert.match(result.error, expected);
    assert.deepEqual(events, []);
  }
});

test('undo rereads receipt eligibility under lock before any current-state inspection', async (t) => {
  const root = fixture(t);
  const selectedPlan = plan();
  const applied = await applyMaintenancePlan({
    plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
    providers: registry(provider([])), transactionsRoot: root,
    refreshPlan: async () => selectedPlan, now: () => NOW, nonce: () => 'undo-race',
  });
  const loaded = readMaintenanceReceipt(root, applied.receiptId);
  const fsImpl = receiptDuringLock(root, () => {
    writeMaintenanceReceipt(loaded.file, {
      ...loaded.receipt, status: 'partial-recovery-required',
      error: 'another mutation changed eligibility',
    });
  });
  const events = [];
  const result = await undoMaintenanceReceipt({
    transactionsRoot: root, receiptId: applied.receiptId,
    providers: registry(provider(events)),
    inspectCurrent: async () => { events.push('inspect'); return { postFingerprint: 'post-a' }; },
    refreshAffectedCatalog: async () => { events.push('refresh'); return { ok: true }; },
    fsImpl,
  });
  assert.equal(result.status, 'receipt-refused');
  assert.deepEqual(events, []);
});

test('undo catalog refresh false or throw seals recovery-required without repeating provider undo', async (t) => {
  const root = fixture(t);
  for (const [name, refresh] of [
    ['false-object', async () => ({ ok: false })],
    ['false-primitive', async () => false],
    ['throw', async () => { throw new Error('catalog unavailable'); }],
  ]) {
    const transactionsRoot = path.join(root, name);
    const selectedPlan = plan([], {
      planId: `plan-${name}`, planDigest: `digest-${name}`, actions: [action('a')],
    });
    const applied = await applyMaintenancePlan({
      plan: selectedPlan, actionIds: ['a'], expectedPlanDigest: selectedPlan.planDigest,
      providers: registry(provider([])), transactionsRoot,
      refreshPlan: async () => selectedPlan, now: () => NOW, nonce: () => name,
    });
    const events = [];
    const result = await undoMaintenanceReceipt({
      transactionsRoot, receiptId: applied.receiptId, providers: registry(provider(events)),
      inspectCurrent: async (entry) => ({ postFingerprint: entry.outcome.postFingerprint }),
      refreshAffectedCatalog: refresh, now: () => NOW + 1,
    });
    assert.equal(result.status, 'partial-recovery-required');
    assert.deepEqual(events, ['undo:a', 'verify-undo:a']);
    const after = readMaintenanceReceipt(transactionsRoot, applied.receiptId).receipt;
    assert.equal(after.status, 'partial-recovery-required');
    assert.equal(after.actions[0].state, 'rolled-back');
    assert.equal(after.recovery.interruptedStatus, 'undoing');
    assert.match(after.error, /catalog/i);
  }
});
