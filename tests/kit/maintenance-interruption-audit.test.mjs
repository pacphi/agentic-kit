// MNT-RCV-001..012: the interruption audit is read-only, discloses its
// checks before inspecting, compares only against the recorded preimage or
// verified postimage, never replays/applies/undoes/refreshes, and is
// idempotent. reconcileMaintenanceReceipt is exercised for the single
// confirmed write it enables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reconcileMaintenanceReceipt } from '../../src/lib/maintenance/coordinator.mjs';
import { auditInterruptions } from '../../src/lib/maintenance/interruption-audit.mjs';
import {
  MAINTENANCE_RECEIPT_SCHEMA, createMaintenanceTransaction, readMaintenanceReceipt, writeMaintenanceReceipt,
} from '../../src/lib/maintenance/transaction-store.mjs';

const NOW = Date.parse('2026-09-05T12:00:00.000Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-maint-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function receipt(root, status, entries, name = status) {
  const transaction = createMaintenanceTransaction(root, { now: () => new Date(NOW), nonce: () => name });
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
    async preflight() { assert.fail('audit must never call preflight'); },
    async apply() { assert.fail('audit must never call apply'); },
    async verify() { assert.fail('audit must never call verify'); },
    async undo() { assert.fail('audit must never call undo'); },
    async verifyUndo() { assert.fail('audit must never call verifyUndo'); },
    async inspectCurrent(item) {
      events.push(`inspect:${item.actionId}`);
      return { complete: true, postFingerprint: current[item.actionId] };
    },
    ...overrides,
  };
}

const registry = (implementation) => new Map([[implementation.id, implementation]]);

function snapshot(root) {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry2) => {
    const full = path.join(dir, entry2.name);
    if (entry2.isDirectory()) return walk(full);
    return [[path.relative(root, full), fs.readFileSync(full, 'utf8')]];
  });
  return JSON.stringify(walk(root).sort(([a], [b]) => a.localeCompare(b)));
}

test('MNT-RCV-002: disclosure is populated before inspection and returned for every result, including a skipped one', async (t) => {
  const root = fixture(t);
  const results = await auditInterruptions({
    transactionsRoot: root, receiptIds: ['mnt-does-not-exist'], providers: new Map(), now: () => NOW,
  });
  assert.equal(results.length, 1);
  const [result] = results;
  assert.equal(result.result, 'receipt-integrity-check-failed');
  assert.ok(result.disclosure);
  assert.deepEqual(result.disclosure.checks, [
    'receipt-integrity', 'last-durable-phase', 'recorded-provider-version', 'current-state-inspection',
  ]);
  assert.equal(typeof result.disclosure.executableProbePolicy, 'string');
  assert.equal(typeof result.disclosure.networkPolicy, 'string');
});

test('MNT-RCV-003/004: audit interruption at every durable phase compares only recorded images and never replays', async (t) => {
  const root = fixture(t);
  const cases = [
    { name: 'prepared', status: 'prepared', entries: [entry('a', { state: 'prepared', outcome: null })], expected: 'no-action-started', enables: 'record-no-change' },
    { name: 'applying', status: 'applying', entries: [entry('a')], current: { a: 'pre-a' }, expected: 'matches-recorded-before-state', enables: 'record-no-change' },
    { name: 'verifying', status: 'verifying', entries: [entry('a', { state: 'verified', outcome: { status: 'applied', postFingerprint: 'post-a' }, verification: { verified: true, postFingerprint: 'post-a' } })], current: { a: 'post-a' }, expected: 'matches-verified-after-state', enables: 'record-completed' },
    { name: 'refreshing-catalog', status: 'refreshing-catalog', entries: [entry('a', { state: 'verified', outcome: { status: 'applied', postFingerprint: 'post-a' }, verification: { verified: true, postFingerprint: 'post-a' } })], current: { a: 'post-a' }, expected: 'matches-verified-after-state', enables: 'record-completed' },
    { name: 'undoing-restored', status: 'undoing', entries: [entry('a', { state: 'rolled-back', outcome: { status: 'applied', postFingerprint: 'post-a' }, verification: { verified: true, postFingerprint: 'post-a' } })], current: { a: 'pre-a' }, expected: 'matches-recorded-before-state', enables: 'record-restored' },
  ];
  for (const row of cases) {
    const tx = receipt(root, row.status, row.entries, row.name);
    const events = [];
    const [result] = await auditInterruptions({
      transactionsRoot: root, receiptIds: [tx.id],
      providers: registry(provider(row.current ?? {}, events)), now: () => NOW,
    });
    assert.equal(result.result, row.expected, row.name);
    assert.equal(result.conclusive, true, row.name);
    assert.equal(result.enables, row.enables, row.name);
    assert.equal(result.integrity, 'valid', row.name);
    assert.equal(result.lastDurablePhase, row.status, row.name);
    const { receipt: reloaded } = readMaintenanceReceipt(root, tx.id);
    assert.equal(reloaded.status, row.status, `${row.name}: audit never mutates the receipt`);
  }
});

test('MNT-RCV-002/007: provider drift is disclosed as matching-inspection-provider-not-present, non-conclusive, with no corrective action', async (t) => {
  const root = fixture(t);
  const tx = receipt(root, 'applying', [entry('a')], 'drifted');
  const [result] = await auditInterruptions({
    transactionsRoot: root, receiptIds: [tx.id], providers: new Map(), now: () => NOW,
  });
  assert.equal(result.result, 'matching-inspection-provider-not-present');
  assert.equal(result.conclusive, false);
  assert.equal(result.enables, null);
  assert.deepEqual(result.nextSteps, ['No corrective action is offered.']);
});

test('MNT-RCV-007: mixed images across entries are non-conclusive and disclose the failed comparisons', async (t) => {
  const root = fixture(t);
  const entries = [entry('a'), entry('b', { outcome: { status: 'applied', postFingerprint: 'post-b' } })];
  const tx = receipt(root, 'applying', entries, 'mixed');
  const [result] = await auditInterruptions({
    transactionsRoot: root, receiptIds: [tx.id],
    providers: registry(provider({ a: 'pre-a', b: 'post-b' })), now: () => NOW,
  });
  assert.equal(result.result, 'differs-from-both-recorded-states');
  assert.equal(result.conclusive, false);
  assert.ok(result.failedComparisons.length > 0);
});

test('MNT-RCV-002/003: receipt-integrity failure is a distinct, non-conclusive result and blocks nothing else', async (t) => {
  const root = fixture(t);
  const tx = receipt(root, 'prepared', [entry('a', { state: 'prepared' })], 'tampered');
  fs.writeFileSync(tx.file, fs.readFileSync(tx.file, 'utf8').replace('prepared', 'applying'));
  const [result] = await auditInterruptions({
    transactionsRoot: root, receiptIds: [tx.id], providers: new Map(), now: () => NOW,
  });
  assert.equal(result.result, 'receipt-integrity-check-failed');
  assert.equal(result.integrity, 'failed');
  assert.equal(result.conclusive, false);
});

test('MNT-RCV-005: audits batch across several receipts while keeping independent, receipt-scoped conclusions', async (t) => {
  const root = fixture(t);
  const noDispatch = receipt(root, 'prepared', [entry('a', { state: 'prepared' })], 'batch-a');
  const committed = receipt(root, 'verifying', [entry('b', {
    state: 'verified', outcome: { status: 'applied', postFingerprint: 'post-b' },
    verification: { verified: true, postFingerprint: 'post-b' },
  })], 'batch-b');
  const results = await auditInterruptions({
    transactionsRoot: root, receiptIds: [noDispatch.id, committed.id],
    providers: registry(provider({ b: 'post-b' })), now: () => NOW,
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].receiptId, noDispatch.id);
  assert.equal(results[0].result, 'no-action-started');
  assert.equal(results[1].receiptId, committed.id);
  assert.equal(results[1].result, 'matches-verified-after-state');
});

test('MNT-RCV-005: repeating an audit is idempotent and changes no file', async (t) => {
  const root = fixture(t);
  const tx = receipt(root, 'verifying', [entry('a', {
    state: 'verified', outcome: { status: 'applied', postFingerprint: 'post-a' },
    verification: { verified: true, postFingerprint: 'post-a' },
  })], 'idempotent');
  const before = snapshot(root);
  const first = await auditInterruptions({
    transactionsRoot: root, receiptIds: [tx.id], providers: registry(provider({ a: 'post-a' })), now: () => NOW,
  });
  const between = snapshot(root);
  const second = await auditInterruptions({
    transactionsRoot: root, receiptIds: [tx.id], providers: registry(provider({ a: 'post-a' })), now: () => NOW,
  });
  const after = snapshot(root);
  assert.equal(before, between);
  assert.equal(between, after);
  assert.deepEqual(
    first.map(({ disclosure: _d, ...rest }) => rest),
    second.map(({ disclosure: _d, ...rest }) => rest),
  );
});

test('MNT-RCV-011: exportable audit output carries no local path, secret, or rollback material', async (t) => {
  const root = fixture(t);
  const tx = receipt(root, 'verifying', [entry('a', {
    state: 'verified', outcome: { status: 'applied', postFingerprint: 'post-a' },
    verification: { verified: true, postFingerprint: 'post-a' },
  })], 'export');
  const [result] = await auditInterruptions({
    transactionsRoot: root, receiptIds: [tx.id], providers: registry(provider({ a: 'post-a' })), now: () => NOW,
  });
  const serialized = JSON.stringify(result.exportable);
  assert.doesNotMatch(serialized, /\/private|\/Users|\/home|C:\\\\/i);
  assert.equal('resourceIdentity' in result.exportable, false);
  assert.equal('rollback' in result.exportable, false);
  assert.equal(result.exportable.receiptId, tx.id);
  assert.equal(result.exportable.enables, 'record-completed');
});

test('a caller-supplied refreshAffectedCatalog is never invoked by the audit', async (t) => {
  const root = fixture(t);
  const tx = receipt(root, 'refreshing-catalog', [entry('a', {
    state: 'verified', outcome: { status: 'applied', postFingerprint: 'post-a' },
    verification: { verified: true, postFingerprint: 'post-a' },
  })], 'no-refresh');
  await auditInterruptions({
    transactionsRoot: root, receiptIds: [tx.id],
    providers: registry(provider({ a: 'post-a' })),
    refreshAffectedCatalog: async () => assert.fail('audit must never refresh the catalog'),
    now: () => NOW,
  });
});

test('reconcileMaintenanceReceipt refuses without confirmation, refuses an outcome the audit does not enable, and seals the one it does', async (t) => {
  const root = fixture(t);
  const tx = receipt(root, 'prepared', [entry('a', { state: 'prepared' })], 'reconcile');

  const unconfirmed = await reconcileMaintenanceReceipt({
    transactionsRoot: root, receiptId: tx.id, outcome: 'record-no-change', confirmed: false, providers: new Map(),
  });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.status, 'confirmation-required');

  const wrongOutcome = await reconcileMaintenanceReceipt({
    transactionsRoot: root, receiptId: tx.id, outcome: 'record-completed', confirmed: true, providers: new Map(),
  });
  assert.equal(wrongOutcome.ok, false);
  assert.equal(wrongOutcome.status, 'reconcile-refused');
  assert.equal(readMaintenanceReceipt(root, tx.id).receipt.status, 'prepared', 'a refused reconcile never mutates the receipt');

  const events = [];
  const sealed = await reconcileMaintenanceReceipt({
    transactionsRoot: root, receiptId: tx.id, outcome: 'record-no-change', confirmed: true,
    providers: registry(provider({}, events)), now: () => NOW + 1,
  });
  assert.equal(sealed.ok, true);
  assert.equal(sealed.status, 'aborted-no-change');
  assert.deepEqual(events, [], 'no dispatch means the journal alone proves no change; no provider was inspected');

  const again = await reconcileMaintenanceReceipt({
    transactionsRoot: root, receiptId: tx.id, outcome: 'record-no-change', confirmed: true, providers: new Map(),
  });
  assert.equal(again.status, 'already-reconciled');
});

test('reconcileMaintenanceReceipt records a completed apply and marks a failed catalog refresh distinctly, never replaying the provider', async (t) => {
  const root = fixture(t);
  const tx = receipt(root, 'verifying', [entry('a', {
    state: 'verified', outcome: { status: 'applied', postFingerprint: 'post-a' },
    verification: { verified: true, postFingerprint: 'post-a' },
  })], 'complete');
  const failing = await reconcileMaintenanceReceipt({
    transactionsRoot: root, receiptId: tx.id, outcome: 'record-completed', confirmed: true,
    providers: registry(provider({ a: 'post-a' })),
    refreshAffectedCatalog: async () => ({ ok: false }), now: () => NOW + 1,
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.status, 'partial-recovery-required');
  assert.equal(failing.receipt.recovery.outcome, 'affected-catalog-refresh-did-not-complete');

  const succeeding = await reconcileMaintenanceReceipt({
    transactionsRoot: root, receiptId: tx.id, outcome: 'record-completed', confirmed: true,
    providers: registry(provider({ a: 'post-a' })),
    refreshAffectedCatalog: async () => ({ ok: true }), now: () => NOW + 2,
  });
  assert.equal(succeeding.ok, true);
  assert.equal(succeeding.status, 'committed');
});
