import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyMaintenancePlan, recoverMaintenanceReceipt,
} from '../../src/lib/maintenance/coordinator.mjs';
import { acquireMaintenanceLock } from '../../src/lib/maintenance/mutation-lock.mjs';
import {
  MAINTENANCE_RECEIPT_SCHEMA, createMaintenanceTransaction, readMaintenanceReceipt,
  writeMaintenanceReceipt,
} from '../../src/lib/maintenance/transaction-store.mjs';
import { createMaintenanceService } from '../../src/lib/maintenance/service.mjs';

const NOW = Date.parse('2026-09-03T20:00:00.000Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function receipt(root, status, entries, name = status) {
  const transaction = createMaintenanceTransaction(root, {
    now: () => new Date(NOW), nonce: () => name,
  });
  const timestamp = new Date(NOW).toISOString();
  writeMaintenanceReceipt(transaction.file, {
    schemaVersion: MAINTENANCE_RECEIPT_SCHEMA,
    id: transaction.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    status,
    planId: `plan-${name}`,
    planDigest: `digest-${name}`,
    sourceFingerprint: `inventory-${name}`,
    authorization: { mechanism: 'exact-plan-selection', actionIds: entries.map((entry) => entry.actionId) },
    actions: entries,
    verification: null,
  });
  return transaction;
}

function entry(id = 'a', overrides = {}) {
  return {
    actionId: id,
    providerId: 'fixture-provider',
    providerVersion: '1',
    operation: 'disable',
    resourceIdentity: { kind: 'plugin', id: `plugin-${id}`, host: 'claude' },
    classification: 'approval-required',
    rollback: 'reversible',
    restart: 'required',
    sourceFingerprint: `action-${id}`,
    preimageFingerprint: `pre-${id}`,
    state: 'applying',
    outcome: null,
    verification: null,
    ...overrides,
  };
}

function provider(current, events = [], overrides = {}) {
  return {
    id: 'fixture-provider', version: '1', status: 'available',
    resourceKinds: ['plugin'], operations: ['disable'], rollback: ['reversible'],
    async detect() { return { status: 'available', complete: true, authority: 'native-inventory' }; },
    actionFor() { return null; },
    async preflight() { return { ok: false }; },
    async apply() { assert.fail('recovery must not replay a provider action'); },
    async verify() { return { ok: false }; },
    async undo() { assert.fail('recovery must not invoke provider undo'); },
    async verifyUndo() { return { ok: false }; },
    async inspectCurrent(item) {
      events.push(`inspect:${item.actionId}`);
      return { complete: true, postFingerprint: current[item.actionId] };
    },
    ...overrides,
  };
}

const registry = (implementation) => new Map([[implementation.id, implementation]]);

test('mutation lock handles a crash before any receipt and only reclaims a proven dead same-machine owner', (t) => {
  const root = fixture(t);
  const first = acquireMaintenanceLock(root, {
    machineId: 'machine-a', pid: 424242, nonce: () => 'owner-a',
  });
  assert.ok(first);
  const lockDir = path.join(root, '.mutation-lock');
  const ownerFile = path.join(lockDir, 'owner.json');
  assert.equal(fs.statSync(lockDir).mode & 0o077, 0);
  assert.equal(fs.statSync(ownerFile).mode & 0o077, 0);
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).pid, 424242);

  const reclaimed = acquireMaintenanceLock(root, {
    machineId: 'machine-a', pid: 525252, nonce: () => 'owner-b',
    pidStatus: (pid) => (pid === 424242 ? 'absent' : 'live'),
  });
  assert.ok(reclaimed);
  first.release();
  assert.equal(fs.existsSync(lockDir), true, 'a stale handle must not release a replacement lock');
  reclaimed.release();
  assert.equal(fs.existsSync(lockDir), false);
});

test('mutation lock never steals live, foreign-machine, malformed, symlinked, or wrong-owner state', (t) => {
  const root = fixture(t);
  for (const name of ['live', 'foreign', 'unknown']) {
    const target = path.join(root, name);
    acquireMaintenanceLock(target, {
      machineId: name === 'foreign' ? 'machine-b' : 'machine-a',
      pid: 424242, nonce: () => name,
    });
    const contender = acquireMaintenanceLock(target, {
      machineId: 'machine-a', pid: 525252, nonce: () => 'contender',
      pidStatus: () => (name === 'unknown' ? 'unknown' : 'live'),
    });
    assert.equal(contender, null);
  }

  const malformed = path.join(root, 'malformed');
  fs.mkdirSync(path.join(malformed, '.mutation-lock'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(malformed, '.mutation-lock', 'owner.json'), '{}', { mode: 0o600 });
  assert.equal(acquireMaintenanceLock(malformed, {
    machineId: 'machine-a', currentUid: process.getuid?.(), pidStatus: () => 'absent',
  }), null);

  const unknownUid = path.join(root, 'unknown-uid');
  acquireMaintenanceLock(unknownUid, {
    machineId: 'machine-a', pid: 424242, currentUid: null, nonce: () => 'unknown-uid',
  });
  assert.equal(acquireMaintenanceLock(unknownUid, {
    machineId: 'machine-a', pid: 525252, currentUid: null,
    pidStatus: () => 'absent', nonce: () => 'contender',
  }), null);

  const linked = path.join(root, 'linked');
  fs.mkdirSync(linked, { mode: 0o700 });
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(linked, '.mutation-lock'));
  assert.equal(acquireMaintenanceLock(linked), null);

  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    const owned = path.join(root, 'wrong-owner');
    acquireMaintenanceLock(owned, { machineId: 'machine-a', pid: 424242, nonce: () => 'owned' });
    assert.throws(() => acquireMaintenanceLock(owned, {
      machineId: 'machine-a', currentUid: process.getuid() + 1, pidStatus: () => 'absent',
    }), /owner.*unsafe/i);
  }
});

test('prepared receipt with no dispatched entry is sealed as aborted without provider inspection', async (t) => {
  const root = fixture(t);
  const tx = receipt(root, 'prepared', [entry('a', { state: 'prepared' })]);
  const events = [];
  const result = await recoverMaintenanceReceipt({
    transactionsRoot: root, receiptId: tx.id,
    providers: registry(provider({ a: 'pre-a' }, events)), now: () => NOW + 1,
  });
  assert.equal(result.status, 'aborted-no-change');
  assert.deepEqual(events, []);
  assert.equal(readMaintenanceReceipt(root, tx.id).receipt.recovery.outcome, 'journal-proved-no-dispatch');
});

test('apply-side recovery commits only an exact recorded postimage and refreshes catalog', async (t) => {
  const root = fixture(t);
  for (const status of ['verifying', 'refreshing-catalog']) {
    const tx = receipt(root, status, [entry('a', {
      state: 'verified',
      outcome: { status: 'applied', postFingerprint: 'post-a' },
      verification: { verified: true, postFingerprint: 'post-a' },
    })], status);
    const events = [];
    const result = await recoverMaintenanceReceipt({
      transactionsRoot: root, receiptId: tx.id,
      providers: registry(provider({ a: 'post-a' }, events)),
      refreshAffectedCatalog: async () => { events.push('refresh'); return { ok: true }; },
      now: () => NOW + 1,
    });
    assert.equal(result.status, 'committed');
    assert.deepEqual(events, ['inspect:a', 'refresh']);
    assert.equal(result.receipt.recovery.outcome, 'recorded-postimage-confirmed');
  }
});

test('catalog refresh failure preserves a verified postimage as recovery-required', async (t) => {
  const root = fixture(t);
  const tx = receipt(root, 'refreshing-catalog', [entry('a', {
    state: 'verified', outcome: { status: 'applied', postFingerprint: 'post-a' },
    verification: { verified: true, postFingerprint: 'post-a' },
  })], 'refresh-failed');
  const result = await recoverMaintenanceReceipt({
    transactionsRoot: root, receiptId: tx.id,
    providers: registry(provider({ a: 'post-a' })),
    refreshAffectedCatalog: async () => ({ ok: false }), now: () => NOW + 1,
  });
  assert.equal(result.status, 'partial-recovery-required');
  assert.equal(result.receipt.recovery.reason, 'catalog-refresh-incomplete');
});

test('recovery records no-change only against an explicit observed preimage', async (t) => {
  const root = fixture(t);
  const proven = receipt(root, 'applying', [entry('a')], 'proven-pre');
  const recovered = await recoverMaintenanceReceipt({
    transactionsRoot: root, receiptId: proven.id,
    providers: registry(provider({ a: 'pre-a' })), now: () => NOW + 1,
  });
  assert.equal(recovered.status, 'recovered-no-change');

  const legacy = receipt(root, 'applying', [entry('a', { preimageFingerprint: undefined })], 'legacy');
  const inconclusive = await recoverMaintenanceReceipt({
    transactionsRoot: root, receiptId: legacy.id,
    providers: registry(provider({ a: 'action-a' })), now: () => NOW + 1,
  });
  assert.equal(inconclusive.status, 'partial-recovery-required');
  assert.match(inconclusive.error, /inconclusive/i);
});

test('undo recovery restores terminal state only when every current image is uniform and proven', async (t) => {
  const root = fixture(t);
  const restoredTx = receipt(root, 'undoing', [entry('a', {
    state: 'rolled-back', outcome: { status: 'applied', postFingerprint: 'post-a' },
    verification: { verified: true, postFingerprint: 'post-a' },
  })], 'restored');
  const restored = await recoverMaintenanceReceipt({
    transactionsRoot: root, receiptId: restoredTx.id,
    providers: registry(provider({ a: 'pre-a' })),
    refreshAffectedCatalog: async () => ({ ok: true }), now: () => NOW + 1,
  });
  assert.equal(restored.status, 'rolled-back');
  assert.equal(restored.receipt.recovery.outcome, 'restored-preimage-confirmed');

  const unchangedTx = receipt(root, 'undoing', [entry('a', {
    state: 'verified', outcome: { status: 'applied', postFingerprint: 'post-a' },
    verification: { verified: true, postFingerprint: 'post-a' },
  })], 'undo-no-effect');
  const unchanged = await recoverMaintenanceReceipt({
    transactionsRoot: root, receiptId: unchangedTx.id,
    providers: registry(provider({ a: 'post-a' })),
    refreshAffectedCatalog: async () => ({ ok: true }), now: () => NOW + 1,
  });
  assert.equal(unchanged.status, 'committed');
});

test('provider drift, mixed images, and inspection ambiguity remain recovery-required without mutation', async (t) => {
  const root = fixture(t);
  const cases = [
    { name: 'missing', providers: new Map(), current: null },
    { name: 'version', providers: registry(provider({}, [], { version: '2' })), current: null },
    { name: 'unknown', providers: registry(provider({ a: 'neither' })), current: null },
    { name: 'partial', providers: registry(provider({ a: 'pre-a' }, [], {
      async inspectCurrent() { return { complete: false, postFingerprint: 'pre-a' }; },
    })), current: null },
    { name: 'mixed', providers: registry(provider({ a: 'pre-a', b: 'post-b' })), current: 'mixed' },
  ];
  for (const row of cases) {
    const entries = row.name === 'mixed'
      ? [entry('a'), entry('b', { outcome: { status: 'applied', postFingerprint: 'post-b' } })]
      : [entry('a')];
    const tx = receipt(root, 'applying', entries, row.name);
    const result = await recoverMaintenanceReceipt({
      transactionsRoot: root, receiptId: tx.id, providers: row.providers,
      refreshAffectedCatalog: async () => assert.fail('inconclusive state must not refresh'),
      now: () => NOW + 1,
    });
    assert.equal(result.status, 'partial-recovery-required');
    assert.equal(readMaintenanceReceipt(root, tx.id).receipt.status, 'partial-recovery-required');
  }
});

test('receipt integrity and receipt-directory path safety are required before reconciliation', async (t) => {
  const root = fixture(t);
  const tx = receipt(root, 'prepared', [entry('a', { state: 'prepared' })], 'tampered');
  fs.writeFileSync(tx.file, fs.readFileSync(tx.file, 'utf8').replace('prepared', 'applying'));
  const tampered = await recoverMaintenanceReceipt({
    transactionsRoot: root, receiptId: tx.id, providers: new Map(),
  });
  assert.equal(tampered.status, 'receipt-refused');

  const linkedId = 'mnt-20260903T200000000Z-linked';
  const outside = path.join(root, 'outside-receipt');
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(root, linkedId));
  const linked = await recoverMaintenanceReceipt({
    transactionsRoot: root, receiptId: linkedId, providers: new Map(),
  });
  assert.equal(linked.status, 'receipt-refused');
});

test('recovery is serialized, idempotent, and leaves original plan selection consumed', async (t) => {
  const root = fixture(t);
  const tx = receipt(root, 'prepared', [entry('a', { state: 'prepared' })], 'idempotent');
  const active = acquireMaintenanceLock(root);
  const busy = await recoverMaintenanceReceipt({ transactionsRoot: root, receiptId: tx.id, providers: new Map() });
  assert.equal(busy.status, 'busy');
  active.release();

  const first = await recoverMaintenanceReceipt({ transactionsRoot: root, receiptId: tx.id, providers: new Map() });
  const second = await recoverMaintenanceReceipt({ transactionsRoot: root, receiptId: tx.id, providers: new Map() });
  assert.equal(first.status, 'aborted-no-change');
  assert.equal(second.status, 'already-reconciled');

  const action = {
    id: 'a', providerId: 'fixture-provider', providerVersion: '1', operation: 'disable',
    resource: { kind: 'plugin', id: 'plugin-a', host: 'claude' }, classification: 'approval-required',
    rollback: 'reversible', restart: 'required', executable: true, sourceFingerprint: 'action-a',
  };
  const plan = {
    schemaVersion: 1, planId: 'plan-idempotent', planDigest: 'digest-idempotent',
    sourceFingerprint: 'inventory-idempotent', generatedAt: new Date(NOW - 1).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(), safetyClass: 'approval-required', actions: [action],
  };
  const replay = await applyMaintenancePlan({
    plan, actionIds: ['a'], expectedPlanDigest: plan.planDigest,
    providers: registry(provider({ a: 'pre-a' })), transactionsRoot: root,
    refreshPlan: async () => plan, now: () => NOW,
  });
  assert.equal(replay.status, 'preflight-refused');
  assert.match(replay.error, /consumed/i);
});

test('service persists explicit preimages, exposes recovery history, and requires confirmation', async (t) => {
  const controlRoot = fixture(t);
  const transactionsRoot = path.join(controlRoot, 'transactions');
  const tx = receipt(transactionsRoot, 'applying', [entry('a')], 'service');
  const state = { a: 'pre-a' };
  const implementation = provider(state);
  const collector = {
    async read() {
      return {
        generatedAt: new Date(NOW).toISOString(), snapshot: { present: true, asOf: NOW, stale: false, ageMs: 0 },
        catalog: { asOf: NOW, complete: true, degraded: [], truncated: [], partial: [], sourceStamps: [], items: [] },
        storage: { asOf: NOW, reclaimables: [] },
      };
    },
    async refreshDeep() { return { ok: true }; },
  };
  const service = createMaintenanceService({
    collector, providers: registry(implementation), controlRoot, now: () => NOW + 1,
  });
  const before = await service.scan();
  assert.equal(before.receipts[0].recoveryRequired, true);
  assert.deepEqual({
    status: before.receipts[0].status,
    statusLabel: before.receipts[0].statusLabel,
    statusTone: before.receipts[0].statusTone,
    timestampLabel: before.receipts[0].timestampLabel,
    updatedAt: before.receipts[0].updatedAt,
  }, {
    status: 'applying', statusLabel: 'Apply interrupted', statusTone: 'blocked',
    timestampLabel: 'Updated', updatedAt: new Date(NOW).toISOString(),
  });
  await assert.rejects(() => service.recover({ receiptId: tx.id }), /confirmation/i);
  const result = await service.recover({ receiptId: tx.id, confirmed: true });
  assert.equal(result.status, 'recovered-no-change');
  const after = await service.scan();
  assert.equal(after.receipts[0].status, 'recovered-no-change');
  assert.equal(after.receipts[0].recoveryRequired, false);
  assert.equal(after.receipts[0].statusLabel, 'No change observed');
  assert.equal(after.receipts[0].statusTone, 'ready');
  assert.equal(after.receipts[0].timestampLabel, 'Recorded');
  assert.equal(after.receipts[0].updatedAt, new Date(NOW + 1).toISOString());
  assert.match(after.receipts[0].summary, /confirmed the recorded pre-change state/i);
});
