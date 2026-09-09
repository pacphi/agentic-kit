// ADR-0048 Activity, dispositions, and preferences tests
// (MNT-RCV-005..012, MNT-GUD-009..011, MNT-PRV-006/007).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isProhibitedLabel } from '../../src/lib/maintenance/management/model.mjs';
import { buildActivity, exportReceipt, receiptDetail } from '../../src/lib/maintenance/management/activity.mjs';
import { createDispositionStore } from '../../src/lib/maintenance/management/dispositions.mjs';
import { createPreferencesStore, resolveViewState } from '../../src/lib/maintenance/management/preferences.mjs';
import { INTERRUPTED_RECEIPT, FIXTURE_NOW } from '../fixtures/maintenance/management-fixtures.mjs';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-mgmt-activity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// ── buildActivity ────────────────────────────────────────────────────────────

test('J5: an unfinished receipt lands in Recovery to finish with the Audit interruption label', () => {
  const activity = buildActivity({ receipts: [INTERRUPTED_RECEIPT] });
  assert.equal(activity.recovery.length, 1);
  assert.equal(activity.recovery[0].primaryActionLabel, 'Audit interruption');
  assert.equal(activity.recovery[0].receiptId, INTERRUPTED_RECEIPT.id);
});

test('a finished (committed) receipt never appears in recovery but does appear in receipts', () => {
  const committed = { ...INTERRUPTED_RECEIPT, status: 'committed' };
  const activity = buildActivity({ receipts: [committed] });
  assert.equal(activity.recovery.length, 0);
  assert.equal(activity.receipts.length, 1);
  assert.equal(activity.receipts[0].statusLabel, 'Change recorded');
});

test('eligibleUndo is true only for a committed receipt with a reversible/compensating rollback', () => {
  const reversible = { ...INTERRUPTED_RECEIPT, id: 'mnt-reversible', status: 'committed', actions: [{ ...INTERRUPTED_RECEIPT.actions[0], rollback: 'reversible' }] };
  const irreversible = { ...INTERRUPTED_RECEIPT, id: 'mnt-irreversible', status: 'committed', actions: [{ ...INTERRUPTED_RECEIPT.actions[0], rollback: 'irreversible' }] };
  const stillOpen = { ...INTERRUPTED_RECEIPT, id: 'mnt-open', actions: [{ ...INTERRUPTED_RECEIPT.actions[0], rollback: 'reversible' }] };
  const activity = buildActivity({ receipts: [reversible, irreversible, stillOpen] });
  const byId = Object.fromEntries(activity.receipts.map((r) => [r.receiptId, r]));
  assert.equal(byId['mnt-reversible'].eligibleUndo, true);
  assert.equal(byId['mnt-irreversible'].eligibleUndo, false);
  assert.equal(byId['mnt-open'].eligibleUndo, false); // unfinished receipts are never undo-eligible
});

test('buildActivity groups dispositions, recipe events, and scan history with readable labels', () => {
  const activity = buildActivity({
    dispositions: [{ guidanceId: 'gid_1', dispositionIdentity: 'plc_1:disable', kind: 'snoozed', until: '2026-10-01T00:00:00Z', recordedAt: FIXTURE_NOW }],
    recipeEvents: [{ kind: 'accept', recipeId: 'r1', recipeVersion: '1', at: FIXTURE_NOW }],
    scanHistory: [{ sourceId: 'src_1', environmentId: 'env_1', state: 'complete', label: 'Claude user configuration', visited: 12 }],
  });
  assert.equal(activity.dispositions[0].kindLabel, 'Snoozed');
  assert.equal(activity.recipes[0].kind, 'accept');
  assert.equal(activity.scans[0].state, 'complete');
});

test('buildActivity rejects an unknown scan state rather than silently passing it through', () => {
  assert.throws(() => buildActivity({ scanHistory: [{ sourceId: 'x', environmentId: 'y', state: 'not-a-real-state' }] }), TypeError);
});

test('activity shows the latest scan per source and environment without changing history', () => {
  const scan = { sourceId: 'claude', environmentId: 'local', state: 'complete', label: 'Claude user configuration' };
  const older = { ...scan, completedAt: '2026-09-07T00:00:00Z' };
  const newer = { ...scan, completedAt: '2026-09-08T00:00:00Z', state: 'failed' };
  const otherEnvironment = { ...older, environmentId: 'remote' };
  const otherSource = { ...older, sourceId: 'codex' };
  const scanHistory = [newer, otherEnvironment, older, otherSource, { ...scan }];
  const original = structuredClone(scanHistory);
  const { scans, scanHistory: retained } = buildActivity({ scanHistory });
  assert.equal(retained.length, scanHistory.length);
  assert.ok(retained.some((entry) => entry.completedAt === older.completedAt));
  assert.ok(retained.some((entry) => entry.completedAt === newer.completedAt));
  assert.deepEqual(scans.map(({ sourceId, environmentId, completedAt, state }) => ({ sourceId, environmentId, completedAt, state })),
    [newer, otherEnvironment, otherSource].map(({ sourceId, environmentId, completedAt, state }) => ({ sourceId, environmentId, completedAt, state })));
  assert.deepEqual(scanHistory, original);
});

test('no label anywhere in buildActivity output is prohibited', () => {
  const activity = buildActivity({
    receipts: [INTERRUPTED_RECEIPT],
    dispositions: [{ guidanceId: 'gid_1', dispositionIdentity: 'plc_1:disable', kind: 'acknowledged', recordedAt: FIXTURE_NOW }],
  });
  for (const receipt of [...activity.recovery, ...activity.receipts]) {
    assert.equal(isProhibitedLabel(receipt.statusLabel), false);
  }
  for (const disposition of activity.dispositions) assert.equal(isProhibitedLabel(disposition.kindLabel), false);
});

// ── receiptDetail / exportReceipt (MNT-RCV-011/012) ─────────────────────────

test('receiptDetail exposes provider, operation, timestamps, and preserved resources', () => {
  const detail = receiptDetail(INTERRUPTED_RECEIPT);
  assert.equal(detail.provider.id, 'owned-npx-cache');
  assert.equal(detail.operation, 'clean-cache');
  assert.equal(detail.timestamps.createdAt, INTERRUPTED_RECEIPT.createdAt);
});

test('exportReceipt omits secret-shaped fields by name regardless of the path flags', () => {
  const withSecret = {
    ...INTERRUPTED_RECEIPT,
    actions: [{ ...INTERRUPTED_RECEIPT.actions[0], credential: 'shh', apiKey: 'shh-too' }],
  };
  const exported = exportReceipt(withSecret);
  assert.equal(JSON.stringify(exported).includes('shh'), false);
});

test('exportReceipt redacts an absolute path by default and never changes that default on its own', () => {
  const withPath = {
    ...INTERRUPTED_RECEIPT,
    actions: [{ ...INTERRUPTED_RECEIPT.actions[0], preserved: ['/Users/me/project/file.txt'] }],
  };
  const byDefault = exportReceipt(withPath);
  assert.equal(byDefault.preserved[0], '[path redacted]');
  assert.equal(byDefault.pathsIncluded, false);

  const onlyFlagTrue = exportReceipt(withPath, { includeLocalPaths: true }); // no acknowledgedWarning
  assert.equal(onlyFlagTrue.preserved[0], '[path redacted]');
  assert.equal(onlyFlagTrue.pathsIncluded, false);

  const onlyWarningTrue = exportReceipt(withPath, { acknowledgedWarning: true }); // no includeLocalPaths
  assert.equal(onlyWarningTrue.preserved[0], '[path redacted]');

  const bothTrue = exportReceipt(withPath, { includeLocalPaths: true, acknowledgedWarning: true });
  assert.equal(bothTrue.preserved[0], '/Users/me/project/file.txt');
  assert.equal(bothTrue.pathsIncluded, true);
});

test('a Windows-style absolute path is also redacted by default', () => {
  const withPath = { ...INTERRUPTED_RECEIPT, actions: [{ ...INTERRUPTED_RECEIPT.actions[0], preserved: ['C:\\Users\\me\\file.txt'] }] };
  assert.equal(exportReceipt(withPath).preserved[0], '[path redacted]');
});

// ── Dispositions ledger (MNT-GUD-009..011) ──────────────────────────────────

test('recordDisposition returns the confirmation explanation and persists the record', (t) => {
  const root = tempRoot(t);
  const store = createDispositionStore({ root, now: () => new Date(FIXTURE_NOW) });
  const { record, explanation } = store.recordDisposition({
    guidanceId: 'gid_1', dispositionIdentity: 'plc_1:missing-verified-dependency:decision', kind: 'acknowledged',
  });
  assert.equal(record.kind, 'acknowledged');
  assert.match(explanation, /Acknowledging/);
  assert.equal(store.listDispositions().length, 1);
});

test('snoozed requires a future ISO `until`; other kinds reject an `until`', () => {
  const store = createDispositionStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'ak-disp-')), now: () => new Date(FIXTURE_NOW) });
  assert.throws(() => store.recordDisposition({ guidanceId: 'g', dispositionIdentity: 'p:x', kind: 'snoozed' }), TypeError);
  assert.throws(() => store.recordDisposition({ guidanceId: 'g', dispositionIdentity: 'p:x', kind: 'acknowledged', until: FIXTURE_NOW }), TypeError);
  assert.throws(() => store.recordDisposition({ guidanceId: 'g', dispositionIdentity: 'p:x', kind: 'not-a-kind' }), TypeError);
});

test('activeDispositions excludes an expired snooze but keeps an unexpired one', (t) => {
  const root = tempRoot(t);
  const store = createDispositionStore({ root, now: () => new Date(FIXTURE_NOW) });
  store.recordDisposition({ guidanceId: 'g', dispositionIdentity: 'p:x', kind: 'snoozed', until: '2026-09-10T00:00:00Z' });
  assert.equal(store.activeDispositions(new Date('2026-09-06T00:00:00Z')).length, 1);
  assert.equal(store.activeDispositions(new Date('2026-09-11T00:00:00Z')).length, 0);
});

test('invalidateDispositions marks source-fingerprint drift with the correct MNT-GUD-010 reason', (t) => {
  const root = tempRoot(t);
  const store = createDispositionStore({ root, now: () => new Date(FIXTURE_NOW) });
  store.recordDisposition({
    guidanceId: 'g', dispositionIdentity: 'plc_1:x', kind: 'ignored-exact-candidate',
    invalidationInputs: { sourceFingerprint: 'fp-old' },
  });
  const invalidated = store.invalidateDispositions({
    inventory: { sourceFingerprint: 'fp-old', placements: [{ placementId: 'plc_1', versions: {} }], versionObservations: [] },
    now: new Date(FIXTURE_NOW),
  });
  assert.equal(invalidated[0].invalidatedAt, null); // no drift yet: fingerprint unchanged
  const invalidated2 = store.invalidateDispositions({
    inventory: { sourceFingerprint: 'fp-new', placements: [{ placementId: 'plc_1', versions: {} }], versionObservations: [] },
    now: new Date(FIXTURE_NOW),
  });
  assert.equal(invalidated2[0].invalidationReason, 'source-fingerprint-drift');
});

test('invalidateDispositions detects a candidate change (MNT-GUD-010)', (t) => {
  const root = tempRoot(t);
  const store = createDispositionStore({ root, now: () => new Date(FIXTURE_NOW) });
  store.recordDisposition({ guidanceId: 'g', dispositionIdentity: 'plc_1:x', kind: 'ignored-exact-candidate', invalidationInputs: { candidate: '1.0.0' } });
  const invalidated = store.invalidateDispositions({
    inventory: {
      placements: [{ placementId: 'plc_1', versions: {} }],
      versionObservations: [{ subjectId: 'plc_1', axis: 'candidate', value: '2.0.0' }],
    },
  });
  assert.equal(invalidated[0].invalidationReason, 'candidate-change');
});

test('invalidation is permanent: once marked, a record stays invalidated even if inputs drift back', (t) => {
  const root = tempRoot(t);
  const store = createDispositionStore({ root, now: () => new Date(FIXTURE_NOW) });
  store.recordDisposition({ guidanceId: 'g', dispositionIdentity: 'plc_1:x', kind: 'ignored-exact-candidate', invalidationInputs: { candidate: '1.0.0' } });
  store.invalidateDispositions({ inventory: { placements: [{ placementId: 'plc_1', versions: {} }], versionObservations: [{ subjectId: 'plc_1', axis: 'candidate', value: '2.0.0' }] } });
  assert.equal(store.activeDispositions().length, 0);
});

// ── Preferences (MNT-PRV-006/007) ───────────────────────────────────────────

test('preferences default to across/all/guidance-first with empty facets', (t) => {
  const root = tempRoot(t);
  const store = createPreferencesStore({ root });
  const prefs = store.getPreferences();
  assert.equal(prefs.lastView.scope, 'across');
  assert.equal(prefs.lastView.view, 'all');
  assert.equal(prefs.lastView.sort, 'guidance-first');
});

test('savePreferences merges rather than replaces, and persists across store instances', (t) => {
  const root = tempRoot(t);
  createPreferencesStore({ root }).savePreferences({ lastView: { scope: 'user' } });
  const second = createPreferencesStore({ root });
  second.setPreferredShell('env_1', 'zsh');
  const prefs = second.getPreferences();
  assert.equal(prefs.lastView.scope, 'user');
  assert.equal(prefs.lastView.sort, 'guidance-first'); // untouched field survives the merge
  assert.equal(prefs.preferredShellByEnvironment.env_1, 'zsh');
});

test('retention overrides are rejected below the SCAN_HISTORY_FLOORS minimum (MNT-PRV-007)', (t) => {
  const root = tempRoot(t);
  const store = createPreferencesStore({ root });
  assert.throws(() => store.savePreferences({ retention: { maxSummaries: 0 } }), TypeError);
  assert.throws(() => store.savePreferences({ retention: { maxAgeDays: 0 } }), TypeError);
  assert.doesNotThrow(() => store.savePreferences({ retention: { maxSummaries: 1, maxAgeDays: 1 } }));
});

test('setPreferredShell rejects an unknown shell', (t) => {
  const root = tempRoot(t);
  const store = createPreferencesStore({ root });
  assert.throws(() => store.setPreferredShell('env_1', 'fish'), TypeError);
});

// ── resolveViewState (MNT-PRV-006: URL overrides remembered) ────────────────

test('a valid URL state overrides the remembered view entirely for the fields it sets', () => {
  const remembered = { scope: 'user', view: 'can-apply', sort: 'name', facets: { kind: ['plugin'] }, search: 'x' };
  const resolved = resolveViewState({ url: { scope: 'project' }, remembered });
  assert.equal(resolved.scope, 'project');
});

test('an absent or empty URL state falls back to the remembered view', () => {
  const remembered = { scope: 'user', view: 'can-apply', sort: 'name', facets: {}, search: '' };
  assert.deepEqual(resolveViewState({ url: null, remembered }), remembered);
  assert.deepEqual(resolveViewState({ url: {}, remembered }), remembered);
});

test('an invalid URL scope/view/sort is not treated as valid state and falls back to remembered', () => {
  const remembered = { scope: 'user', view: 'all', sort: 'name', facets: {}, search: '' };
  const resolved = resolveViewState({ url: { scope: 'not-a-scope' }, remembered });
  assert.equal(resolved.scope, 'user');
});
