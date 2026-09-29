import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  findMemoryEntry, findStrayMemoryStores, memoryEntryExists, projectMemoryStatus, removeMemoryProbe,
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

// Ruflo's own memory_entries shape (memory-initializer.js, 3.45.0): namespace,
// status and expires_at are real columns there.
function seedRuflo(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE memory_entries (id TEXT PRIMARY KEY, key TEXT, namespace TEXT, content TEXT, status TEXT, expires_at INTEGER)');
  const put = db.prepare('INSERT INTO memory_entries VALUES (?, ?, ?, ?, ?, ?)');
  rows.forEach(([namespace, status = 'active', expiresAt = null], i) => put.run(String(i), `k${i}`, namespace, 'v', status, expiresAt));
  db.close();
}

test('a store reports its file and WAL size, its largest namespace, and how much of it expires', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-size-'));
  // One hook that closes the test's own databases before removing the folder:
  // after-hooks run in the order they were added, and Windows will not remove
  // a folder while a connection still holds its files open. The removal has no retries, so on Windows it also proves that
  // projectMemoryStatus closed its own read-only connection.
  const open = [];
  t.after(() => {
    for (const db of open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, '.swarm', 'agentdb-memory.db');
  seedRuflo(file, [['commands'], ['commands'], ['commands', 'active', Date.now() + 60_000], ['commands', 'deleted'], ['decisions'], [null]]);
  // Hold a writer open with checkpoints off, so a live -wal exists as it does
  // beside a running MCP server.
  const writer = new DatabaseSync(file);
  open.push(writer);
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  writer.prepare("INSERT INTO memory_entries VALUES ('w', 'kw', 'commands', 'v', 'active', NULL)").run();

  const native = projectMemoryStatus(root).stores.find((store) => store.kind === 'native-agentdb');
  assert.equal(native.readable, true);
  assert.equal(native.table, true);
  assert.equal(native.entries, 6, 'the tombstoned row is not counted');
  assert.equal(native.sizeBytes, fs.statSync(file).size);
  assert.ok(native.walBytes > 0, 'the live WAL is measured, not ignored');
  assert.equal(native.walBytes, fs.statSync(`${file}-wal`).size);
  assert.deepEqual(native.top, { namespace: 'commands', entries: 4, expiring: 1 });
});

test('a store without expires_at reports its top namespace with expiry unknown, and a missing WAL as 0', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seed(path.join(root, '.swarm', 'memory.db'), [['1', 'a', 'ns-a', 'v'], ['2', 'b', 'ns-b', 'v'], ['3', 'c', 'ns-b', 'v']]);
  const compat = projectMemoryStatus(root).stores.find((store) => store.kind === 'sqljs');
  assert.deepEqual(compat.top, { namespace: 'ns-b', entries: 2, expiring: null });
  assert.equal(compat.walBytes, 0);
});

test('a store with no memory table yet is empty, not unreadable', (t) => {
  // `ruflo memory init` creates agentdb-memory.db before any bridge write adds
  // memory_entries (observed on 3.45.0); status must not call that unreadable.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.swarm'));
  const db = new DatabaseSync(path.join(root, '.swarm', 'agentdb-memory.db'));
  db.exec('CREATE TABLE episodes (id INTEGER PRIMARY KEY)');
  db.close();
  const native = projectMemoryStatus(root).stores.find((store) => store.kind === 'native-agentdb');
  assert.equal(native.readable, true);
  assert.equal(native.table, false);
  assert.equal(native.entries, 0);
  assert.equal(native.top, null);
  assert.equal(findMemoryEntry(root, '_setup', 'anything'), null);
});

function touch(root, relative, content = 'x') {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('stray stores are found outside the canonical .swarm pair, and backups, worktrees and dependencies are not', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-stray-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The canonical pair and this project's own AQE store are not strays.
  touch(root, '.swarm/memory.db');
  touch(root, '.swarm/agentdb-memory.db');
  fs.mkdirSync(path.join(root, '.agentic-qe'));
  // Strays, traced to owners in the 2026-09-26 audit.
  touch(root, '.swarm/.swarm/agentdb-memory.db', 'nested');
  touch(root, '.swarm/.swarm/agentdb-memory.db-wal', 'wal');
  touch(root, '.swarm/deep/er/memory.db');
  touch(root, 'agentdb.db');
  touch(root, 'agentdb.rvf');
  touch(root, 'ruvector.db');
  touch(root, 'packages/app/.swarm/agentdb-memory.db');
  for (const dir of ['docs/.agentic-qe', 'docs/archive/.agentic-qe', '.claude/.agentic-qe', '.agentic-qe/.agentic-qe']) {
    fs.mkdirSync(path.join(root, ...dir.split('/')), { recursive: true });
  }
  // Not strays: Ruflo's rotated backups (and a copy kept in a subfolder there),
  // another checkout under .claude/worktrees, dependencies, git internals.
  touch(root, '.swarm/backups/memory-2026-09-10T18-27-26-543Z.db');
  touch(root, '.swarm/backups/pre-cleanup/agentdb-memory.db');
  fs.mkdirSync(path.join(root, '.claude', 'worktrees', 'w1', '.agentic-qe'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg', '.agentic-qe'), { recursive: true });
  touch(root, 'node_modules/pkg/.swarm/memory.db');
  fs.mkdirSync(path.join(root, '.git', '.agentic-qe'), { recursive: true });

  const { strays, complete } = findStrayMemoryStores(root);
  assert.equal(complete, true);
  const found = strays.map((stray) => `${stray.kind} ${stray.path}`).sort();
  assert.deepEqual(found, [
    'agentdb-cli agentdb.db',
    'agentdb-rvf agentdb.rvf',
    'aqe .agentic-qe/.agentic-qe',
    'aqe .claude/.agentic-qe',
    'aqe docs/.agentic-qe',
    'aqe docs/archive/.agentic-qe',
    'ruflo .swarm/.swarm/agentdb-memory.db',
    'ruflo .swarm/deep/er/memory.db',
    'ruflo packages/app/.swarm/agentdb-memory.db',
    'ruvector ruvector.db',
  ]);
  const nested = strays.find((stray) => stray.path === '.swarm/.swarm/agentdb-memory.db');
  assert.equal(nested.sizeBytes, 'nested'.length + 'wal'.length, 'a store is sized with its WAL');
  assert.equal(strays.find((stray) => stray.kind === 'aqe').sizeBytes, null, 'a folder is not sized');
});

test('the stray search is bounded and says when it stopped early', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-stray-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 6; i++) fs.mkdirSync(path.join(root, `dir${i}`));
  fs.mkdirSync(path.join(root, 'a', 'b', 'c', 'd', 'e', '.agentic-qe'), { recursive: true });
  const capped = findStrayMemoryStores(root, { maxDirs: 3 });
  assert.equal(capped.complete, false);
  assert.equal(capped.visited, 3);
  const deep = findStrayMemoryStores(root);
  assert.equal(deep.complete, false, 'a depth cutoff leaves descendants unchecked');
  assert.deepEqual(deep.strays, [], 'folders deeper than the depth bound are not searched');
  assert.deepEqual(findStrayMemoryStores(path.join(root, 'missing')), { strays: [], complete: true, visited: 0, nestedRepositories: [] });
});

test('the stray search stops at a nested repository or an in-checkout worktree: their stores are their own', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-stray-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.agentic-qe'));
  fs.mkdirSync(path.join(root, 'docs', '.agentic-qe'), { recursive: true });
  // A nested repository (or submodule checkout): .git is a folder.
  fs.mkdirSync(path.join(root, 'packages', 'api', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'api', '.agentic-qe'));
  fs.mkdirSync(path.join(root, 'packages', 'api', 'sub', '.agentic-qe'), { recursive: true });
  touch(root, 'packages/api/.swarm/agentdb-memory.db');
  // A worktree created inside the checkout: .git is a file.
  fs.mkdirSync(path.join(root, 'wt', 'feature', '.agentic-qe'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wt', 'feature', '.git'), 'gitdir: ../../.git/worktrees/feature\n');
  // A root dot folder that is its own repository.
  fs.mkdirSync(path.join(root, '.tools', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.tools', '.agentic-qe'));
  const { strays, nestedRepositories } = findStrayMemoryStores(root);
  assert.deepEqual(strays.map((stray) => `${stray.kind} ${stray.path}`), ['aqe docs/.agentic-qe']);
  assert.deepEqual(nestedRepositories, ['.tools', 'packages/api', 'wt/feature']);
});

test('the stray search finds AQE below ordinary dot folders without entering tool homes or linked folders', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-stray-dot-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-stray-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, '.superpowers', 'sdd', 'program', 'reports', '.agentic-qe'), { recursive: true });
  fs.mkdirSync(path.join(root, '.notes', 'drafts', '.agentic-qe'), { recursive: true });
  for (const dir of ['.git', '.claude', '.codex', '.agentic-qe', '.swarm', 'node_modules']) {
    fs.mkdirSync(path.join(root, dir, 'nested', '.agentic-qe'), { recursive: true });
  }
  fs.mkdirSync(path.join(outside, '.agentic-qe'));
  fs.symlinkSync(outside, path.join(root, '.notes', 'linked'));
  fs.symlinkSync(root, path.join(root, '.notes', 'loop'));
  fs.mkdirSync(path.join(root, '.other-repo', '.agentic-qe'), { recursive: true });
  fs.writeFileSync(path.join(root, '.other-repo', '.git'), 'gitdir: elsewhere\n');

  const result = findStrayMemoryStores(root);
  assert.equal(result.complete, true);
  assert.deepEqual(result.strays.map((stray) => stray.path), [
    '.notes/drafts/.agentic-qe',
    '.superpowers/sdd/program/reports/.agentic-qe',
  ]);
  assert.deepEqual(result.nestedRepositories, ['.other-repo']);
});

test('unreadable or depth-limited dot subtrees do not claim complete stray coverage', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-stray-limit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.notes', 'a', 'b', 'c', 'd', '.agentic-qe'), { recursive: true });
  const result = findStrayMemoryStores(root);
  assert.equal(result.complete, false);
  assert.deepEqual(result.strays, []);
});
