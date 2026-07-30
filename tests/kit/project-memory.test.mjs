import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  findMemoryEntry, memoryEntryExists, projectMemoryStatus,
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
