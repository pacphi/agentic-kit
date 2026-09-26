import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  findMemoryEntry, memoryEntryExists, projectMemoryStatus, removeMemoryProbe,
} from '../../src/lib/project-memory.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-project-memory-'));

function seed(file, rows = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      namespace TEXT,
      content TEXT NOT NULL,
      status TEXT
    )
  `);
  const put = db.prepare(
    'INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, ?)',
  );
  for (const [id, key, namespace, content, status = 'active'] of rows) {
    put.run(id, key, namespace, content, status);
  }
  db.close();
}

test('no store is an honest uninitialized state', () => {
  const status = projectMemoryStatus(ROOT);
  assert.equal(status.active, null);
  assert.equal(status.stores.every((store) => !store.present), true);
});

test('memory.db alone is the compatibility writer and counts active rows', () => {
  const file = path.join(ROOT, '.swarm', 'memory.db');
  seed(file, [
    ['1', 'live', 'test', 'value', 'active'],
    ['2', 'gone', 'test', 'value', 'deleted'],
  ]);
  const status = projectMemoryStatus(ROOT);
  assert.equal(status.active.kind, 'sqljs');
  assert.equal(status.active.entries, 1);
  assert.equal(memoryEntryExists(file, 'test', 'live'), true);
  assert.equal(memoryEntryExists(file, 'test', 'missing'), false);
  fs.rmSync(path.join(ROOT, '.swarm'), { recursive: true, force: true });
});

test('the native sibling is active when both legitimate stores coexist', () => {
  const compat = path.join(ROOT, '.swarm', 'memory.db');
  const native = path.join(ROOT, '.swarm', 'agentdb-memory.db');
  seed(compat, [['1', 'compat', 'test', 'old']]);
  seed(native, [['2', 'native', 'test', 'new']]);
  const status = projectMemoryStatus(ROOT);
  assert.equal(status.active.kind, 'native-agentdb');
  assert.equal(status.active.file, native);
  assert.equal(status.secondary.kind, 'sqljs');
  assert.equal(findMemoryEntry(ROOT, 'test', 'native').file, native);
  assert.equal(findMemoryEntry(ROOT, 'test', 'compat').file, compat);
  fs.rmSync(path.join(ROOT, '.swarm'), { recursive: true, force: true });
});

test('an unreadable native sibling is surfaced instead of falling back silently', () => {
  const compat = path.join(ROOT, '.swarm', 'memory.db');
  const native = path.join(ROOT, '.swarm', 'agentdb-memory.db');
  seed(compat, [['1', 'compat', 'test', 'old']]);
  fs.writeFileSync(native, 'not sqlite');
  const status = projectMemoryStatus(ROOT);
  assert.equal(status.active.kind, 'native-agentdb');
  assert.equal(status.active.readable, false);
  assert.equal(status.secondary.readable, true);
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('removeMemoryProbe deletes the probe from every store that holds it and nothing else', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-probe-remove-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compat = path.join(root, '.swarm', 'memory.db');
  const native = path.join(root, '.swarm', 'agentdb-memory.db');
  seed(compat, [['1', 'probe', '_setup', 'v'], ['2', 'keep', '_setup', 'v']]);
  seed(native, [['3', 'probe', '_setup', 'v'], ['4', 'keep', '_setup', 'v']]);
  const result = removeMemoryProbe(root, '_setup', 'probe');
  assert.deepEqual(result.removed.sort(), ['agentdb-memory.db', 'memory.db']);
  assert.deepEqual(result.failed, []);
  for (const file of [compat, native]) {
    assert.equal(memoryEntryExists(file, '_setup', 'probe'), false, `${path.basename(file)} still holds the probe`);
    assert.equal(memoryEntryExists(file, '_setup', 'keep'), true, `${path.basename(file)} lost an unrelated row`);
  }
});

test('removeMemoryProbe removes a tombstoned probe row too, so nothing of it is left', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-probe-remove-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const native = path.join(root, '.swarm', 'agentdb-memory.db');
  seed(native, [['1', 'probe', '_setup', 'v', 'deleted']]);
  assert.deepEqual(removeMemoryProbe(root, '_setup', 'probe').removed, ['agentdb-memory.db']);
  assert.equal(memoryEntryExists(native, '_setup', 'probe'), false);
});

test('removeMemoryProbe leaves a store that never held the probe untouched', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-probe-remove-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compat = path.join(root, '.swarm', 'memory.db');
  const native = path.join(root, '.swarm', 'agentdb-memory.db');
  seed(compat, [['1', 'probe', '_setup', 'v']]);
  seed(native, [['2', 'other', '_setup', 'v']]);
  const before = fs.statSync(native).mtimeMs;
  const result = removeMemoryProbe(root, '_setup', 'probe');
  assert.deepEqual(result.removed, ['memory.db']);
  assert.equal(fs.statSync(native).mtimeMs, before, 'a store without the probe is not opened for writing');
});

test('removeMemoryProbe reports an unreadable store instead of pretending it was clean', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-probe-remove-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compat = path.join(root, '.swarm', 'memory.db');
  seed(compat, [['1', 'probe', '_setup', 'v']]);
  fs.writeFileSync(path.join(root, '.swarm', 'agentdb-memory.db'), 'not a database');
  const result = removeMemoryProbe(root, '_setup', 'probe');
  assert.deepEqual(result.removed, ['memory.db']);
  assert.deepEqual(result.failed.map((f) => path.basename(f.file)), ['agentdb-memory.db']);
});

test('a store with no memory table cannot hold the probe and is not a cleanup failure', (t) => {
  // `ruflo memory init` creates agentdb-memory.db without memory_entries; only a
  // write through the native bridge adds it (observed on 3.45.0).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-probe-remove-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seed(path.join(root, '.swarm', 'memory.db'), [['1', 'probe', '_setup', 'v']]);
  const native = new DatabaseSync(path.join(root, '.swarm', 'agentdb-memory.db'));
  native.exec('CREATE TABLE episodes (id INTEGER PRIMARY KEY)');
  native.close();
  assert.deepEqual(removeMemoryProbe(root, '_setup', 'probe'), { removed: ['memory.db'], failed: [] });
});

test('removeMemoryProbe on a project with no stores is a clean no-op', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-probe-remove-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(removeMemoryProbe(root, '_setup', 'probe'), { removed: [], failed: [] });
});
