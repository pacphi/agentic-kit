import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_MODEL_SNAPSHOTS, appendModelSnapshot, baselineFor, latestSnapshot, readModelStore,
  readOrCreateModelScopeKey,
} from '../../src/lib/model-inventory/store.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-25T12:00:00.000Z');

function snapshot(id, at, { scope = 'scope-a', status = 'complete' } = {}) {
  return {
    schemaVersion: 1, snapshotId: id, capturedAt: new Date(at).toISOString(),
    scope: { fingerprint: scope, hosts: ['codex'] },
    sources: [{
      id: 'codex-cache', status, capturedAt: new Date(at).toISOString(),
      scopeFingerprint: scope,
    }],
    models: [], bindings: [], changes: [], opportunities: [], diagnostics: [],
  };
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-model-store-'));
  return { dir, file: path.join(dir, 'model-inventory.json') };
}

test('append writes atomically with private permissions and advances a complete stable baseline', () => {
  const sb = sandbox();
  const store = appendModelSnapshot(snapshot('complete-a', NOW), { file: sb.file, now: NOW });
  assert.equal(baselineFor(store, 'scope-a').snapshotId, 'complete-a');
  assert.equal(latestSnapshot(store).snapshotId, 'complete-a');
  assert.equal(fs.readdirSync(sb.dir).some((name) => name.endsWith('.tmp')), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(sb.file).mode & 0o777, 0o600);
  fs.rmSync(sb.dir, { recursive: true, force: true });
});

test('partial snapshot is retained but cannot replace the complete baseline', () => {
  const sb = sandbox();
  appendModelSnapshot(snapshot('complete-a', NOW - DAY), { file: sb.file, now: NOW });
  const store = appendModelSnapshot(snapshot('partial-a', NOW, { status: 'partial' }), {
    file: sb.file, now: NOW,
  });
  assert.equal(latestSnapshot(store).snapshotId, 'partial-a');
  assert.equal(baselineFor(store, 'scope-a').snapshotId, 'complete-a');
  fs.rmSync(sb.dir, { recursive: true, force: true });
});

test('history is bounded to 32 snapshots and 90 days', () => {
  const sb = sandbox();
  appendModelSnapshot(snapshot('expired', NOW - 91 * DAY), { file: sb.file, now: NOW });
  for (let i = 0; i < MAX_MODEL_SNAPSHOTS + 3; i++) {
    appendModelSnapshot(snapshot(`recent-${i}`, NOW - (MAX_MODEL_SNAPSHOTS + 3 - i) * 1_000), {
      file: sb.file, now: NOW,
    });
  }
  const store = readModelStore({ file: sb.file });
  assert.equal(store.snapshots.length, MAX_MODEL_SNAPSHOTS);
  assert.equal(store.snapshots.some(({ snapshotId }) => snapshotId === 'expired'), false);
  assert.equal(store.snapshots.at(-1).snapshotId, `recent-${MAX_MODEL_SNAPSHOTS + 2}`);
  fs.rmSync(sb.dir, { recursive: true, force: true });
});

test('the 32-snapshot retention bound applies independently per scope', () => {
  const sb = sandbox();
  for (const scope of ['scope-a', 'scope-b']) {
    for (let i = 0; i < MAX_MODEL_SNAPSHOTS + 1; i++) {
      appendModelSnapshot(snapshot(`${scope}-${i}`, NOW - (MAX_MODEL_SNAPSHOTS - i) * 1_000, { scope }), {
        file: sb.file, now: NOW,
      });
    }
  }
  const store = readModelStore({ file: sb.file });
  assert.equal(store.snapshots.filter(({ scope }) => scope.fingerprint === 'scope-a').length,
    MAX_MODEL_SNAPSHOTS);
  assert.equal(store.snapshots.filter(({ scope }) => scope.fingerprint === 'scope-b').length,
    MAX_MODEL_SNAPSHOTS);
  fs.rmSync(sb.dir, { recursive: true, force: true });
});

test('missing or corrupt store degrades to an empty readable store', () => {
  const sb = sandbox();
  assert.deepEqual(readModelStore({ file: sb.file }).snapshots, []);
  fs.writeFileSync(sb.file, '{broken');
  assert.deepEqual(readModelStore({ file: sb.file }).baselineByScope, {});
  fs.rmSync(sb.dir, { recursive: true, force: true });
});

test('scope fingerprints use a stable private per-install key', () => {
  const sb = sandbox();
  const file = path.join(sb.dir, 'model-scope.key');
  const key = readOrCreateModelScopeKey({ file, randomBytesFn: () => Buffer.alloc(32, 0xab) });
  assert.equal(key, 'ab'.repeat(32));
  assert.equal(readOrCreateModelScopeKey({ file, randomBytesFn: () => Buffer.alloc(32) }), key);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(sb.dir, { recursive: true, force: true });
});
