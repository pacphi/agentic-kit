// One-time cleanup of ak's old setup probe rows (B3-D2). Every store here is
// a fixture in a temporary folder, built with the memory_entries columns
// Ruflo 3.46.1 writes (id key namespace content type … status) plus AgentDB
// tables in agentdb-memory.db; the backup and receipt folders are temporary
// too, so no real store, state folder or kit.json is touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sandboxHome, assertSandboxed, rmrf } from './helpers/home-sandbox.mjs';

// The sync step writes its backup and receipt under the state folder and
// records the cleanup in kit.json: both resolve inside this sandbox.
const HOME = sandboxHome('ak-probe-cleanup');
after(() => rmrf(HOME));
const paths = await import('../../src/lib/paths.mjs');
assertSandboxed(paths, HOME);
const { findProbeRows, cleanupProbeRows, PROBE } = await import('../../src/lib/memory-probe-cleanup.mjs');
const projectMemory = (await import('../../src/commands/status/sections/project-memory.mjs')).default;
const userMemory = (await import('../../src/commands/status/sections/user-memory.mjs')).default;
const { SYNC_STEPS } = await import('../../src/commands/sync.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');

const MEMORY_ENTRIES = `CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, namespace TEXT DEFAULT 'default', content TEXT NOT NULL,
  type TEXT DEFAULT 'semantic', embedding TEXT, metadata TEXT,
  created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
  status TEXT DEFAULT 'active', UNIQUE(namespace, key))`;
const AGENTDB_TABLES = `
  CREATE TABLE episodes (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT);
  CREATE TABLE episode_embeddings (episode_id INTEGER PRIMARY KEY, embedding BLOB NOT NULL,
    FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE);
  INSERT INTO episodes (task) VALUES ('kept');
  INSERT INTO episode_embeddings VALUES (1, x'00');`;

const PROBE_KEY = '_setup/verify-12-1700000000000';
const ROWS = [
  ['p1', PROBE_KEY, '_setup', 'setup-verify', 'active'],
  ['d1', '_setup/verify-x', '_setup', 'setup-verify', 'active'],
  ['d2', '_setup/verify-1-2', '_setup', 'other', 'active'],
  ['d3', '_setup/verify-3-4', 'mine', 'setup-verify', 'active'],
  ['u1', 'notes/today', 'default', 'user data', 'active'],
];

function store(file, { agentdb = false, rows = ROWS, idPrefix = '' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(MEMORY_ENTRIES);
  if (agentdb) db.exec(AGENTDB_TABLES);
  const insert = db.prepare('INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, ?)');
  for (const [id, ...rest] of rows) insert.run(`${idPrefix}${id}`, ...rest);
  db.close();
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-probe-cleanup-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'repo', '.swarm');
  store(path.join(dir, 'memory.db'));
  store(path.join(dir, 'agentdb-memory.db'), { agentdb: true, idPrefix: 'm-' });
  return { base, dir, backupRoot: path.join(base, 'state', 'backups'), receiptDir: path.join(base, 'state', 'receipts') };
}

const keysIn = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT key, namespace, content FROM memory_entries ORDER BY id').all().map((r) => `${r.namespace}:${r.key}:${r.content}`); }
  finally { db.close(); }
};
const NOW = Date.parse('2026-09-27T12:00:00.000Z');

test('the probe definition is exactly ak\'s setup probe', () => {
  assert.equal(PROBE.namespace, '_setup');
  assert.equal(PROBE.content, 'setup-verify');
  assert.ok(PROBE.key.test(PROBE_KEY));
  for (const decoy of ['_setup/verify-x', '_setup/verify-1-2x', 'x_setup/verify-1-2', '_setup/verify-1']) assert.equal(PROBE.key.test(decoy), false, decoy);
});

test('only the exact probe rows are found, in both stores, whatever their status', (t) => {
  const { dir } = fixture(t);
  const found = findProbeRows(dir);
  assert.deepEqual(found.map((s) => path.basename(s.file)), ['memory.db', 'agentdb-memory.db']);
  assert.deepEqual(found[0].rows, [{ id: 'p1', key: PROBE_KEY, status: 'active' }]);
  assert.deepEqual(found[1].rows, [{ id: 'm-p1', key: PROBE_KEY, status: 'active' }]);
  assert.deepEqual(findProbeRows(path.join(dir, 'missing')), []);
});

test('a dry run deletes nothing and returns the same plan', (t) => {
  const { dir, backupRoot, receiptDir } = fixture(t);
  const before = keysIn(path.join(dir, 'memory.db'));
  const cleaned = {};
  const { receipt } = cleanupProbeRows([dir], { dryRun: true, backupRoot, receiptDir, now: NOW, cleaned });
  assert.equal(receipt.dryRun, true);
  assert.deepEqual(receipt.stores.map((s) => [path.basename(s.file), s.deleted]), [['memory.db', [PROBE_KEY]], ['agentdb-memory.db', [PROBE_KEY]]]);
  assert.deepEqual(keysIn(path.join(dir, 'memory.db')), before);
  assert.equal(fs.existsSync(backupRoot), false);
  assert.equal(fs.existsSync(receiptDir), false);
  assert.deepEqual(cleaned, {});
});

test('cleanup backs up each store, deletes only the probe rows and writes one receipt; a second run does nothing', (t) => {
  const { dir, backupRoot, receiptDir } = fixture(t);
  const cleaned = {};
  const { receipt } = cleanupProbeRows([dir, dir], { backupRoot, receiptDir, now: NOW, cleaned });
  for (const name of ['memory.db', 'agentdb-memory.db']) {
    const file = path.join(dir, name);
    const keys = keysIn(file);
    assert.ok(!keys.some((k) => k === `_setup:${PROBE_KEY}:setup-verify`), `${name}: probe row gone`);
    for (const decoy of ['_setup:_setup/verify-x:setup-verify', '_setup:_setup/verify-1-2:other', 'mine:_setup/verify-3-4:setup-verify', 'default:notes/today:user data']) {
      assert.ok(keys.includes(decoy), `${name}: ${decoy} kept`);
    }
    const entry = receipt.stores.find((s) => s.file === file);
    assert.deepEqual(entry.deleted, [PROBE_KEY]);
    assert.equal(entry.backup, path.join(backupRoot, '2026-09-27T12-00-00-000Z', `swarm-${name}`), 'a visible file name');
    assert.ok(keysIn(entry.backup).includes(`_setup:${PROBE_KEY}:setup-verify`), `${name}: the backup still holds the row`);
    assert.equal(cleaned[file], '2026-09-27T12:00:00.000Z');
  }
  assert.equal(receipt.stores.length, 2, 'a folder named twice is cleaned once');
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt.file, 'utf8')).stores, receipt.stores);
  assert.equal(path.dirname(receipt.file), receiptDir);

  const again = cleanupProbeRows([dir], { backupRoot, receiptDir, now: NOW + 1000, cleaned: {} });
  assert.equal(again.receipt, null, 'nothing left to clean');
  assert.equal(fs.readdirSync(receiptDir).length, 1, 'no second receipt');
  assert.deepEqual(findProbeRows(dir), []);
});

test('a store already recorded as cleaned is never cleaned again', (t) => {
  const { dir, backupRoot, receiptDir } = fixture(t);
  const memory = path.join(dir, 'memory.db');
  const { receipt } = cleanupProbeRows([dir], { backupRoot, receiptDir, now: NOW, cleaned: { [memory]: '2026-09-01T00:00:00.000Z' } });
  assert.deepEqual(receipt.stores.map((s) => path.basename(s.file)), ['agentdb-memory.db']);
  assert.ok(keysIn(memory).includes(`_setup:${PROBE_KEY}:setup-verify`));
});

test('the delete succeeds while another connection holds the store open in WAL mode', (t) => {
  const { dir, backupRoot, receiptDir } = fixture(t);
  // Closed in the test body: after-hooks run in registration order, so the fixture's
  // folder removal would otherwise run first, which Windows refuses for an open file.
  const holder = new DatabaseSync(path.join(dir, 'memory.db'));
  try {
    holder.prepare('SELECT count(*) AS n FROM memory_entries').get();
    const { receipt } = cleanupProbeRows([dir], { backupRoot, receiptDir, now: NOW });
    assert.ok(receipt.stores.every((s) => !s.error), JSON.stringify(receipt.stores));
    assert.equal(holder.prepare('SELECT count(*) AS n FROM memory_entries WHERE key = ?').get(PROBE_KEY).n, 0);
  } finally { holder.close(); }
});

test('the AgentDB store stays consistent after the delete', (t) => {
  const { dir, backupRoot, receiptDir } = fixture(t);
  cleanupProbeRows([dir], { backupRoot, receiptDir, now: NOW });
  const db = new DatabaseSync(path.join(dir, 'agentdb-memory.db'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(db.prepare('SELECT count(*) AS n FROM episode_embeddings').get().n, 1);
  } finally { db.close(); }
});

test('status asks sync to clean a project store\'s probe rows, then stops once the store is recorded', async (t) => {
  const { base, dir } = fixture(t);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, '.git'));
  const real = fs.realpathSync(dir);
  const probeRow = (rows) => rows.find((r) => /old ak setup probe row/.test(r.message));
  const rows = await projectMemory.collect({ cwd: repo, home: HOME, cfg: loadKitConfig() });
  const row = probeRow(rows);
  assert.ok(row, JSON.stringify(rows.map((r) => r.message)));
  assert.equal(row.level, 'warn');
  assert.equal(row.repair, 'sync');
  assert.equal(row.fix, 'sync backs up the store and removes exactly those rows');
  assert.match(row.message, /^2 old ak setup probe rows in /);
  assert.ok(row.message.includes(real), row.message);
  assert.match(row.message, /ruvnet\/ruflo#3450/);
  const cfg = loadKitConfig();
  cfg.cleanups.setupProbeRows = {
    [path.join(real, 'memory.db')]: '2026-09-27T00:00:00.000Z', [path.join(real, 'agentdb-memory.db')]: '2026-09-27T00:00:00.000Z',
  };
  assert.equal(probeRow(await projectMemory.collect({ cwd: repo, home: HOME, cfg })), undefined);
});

test('status reports probe rows in the user-level store too', async (t) => {
  const store = paths.userMemoryDir(HOME);
  t.after(() => fs.rmSync(path.join(HOME, '.claude-flow'), { recursive: true, force: true }));
  fs.mkdirSync(store, { recursive: true });
  const { base } = fixture(t);
  fs.copyFileSync(path.join(base, 'repo', '.swarm', 'memory.db'), path.join(store, 'memory.db'));
  const rows = await userMemory.collect({ home: HOME, env: {}, cfg: loadKitConfig() });
  const row = rows.find((r) => /old ak setup probe row/.test(r.message));
  assert.ok(row, JSON.stringify(rows.map((r) => r.message)));
  assert.match(row.message, /^1 old ak setup probe row in /);
  assert.equal(row.repair, 'sync');
});

test('the sync step cleans the project and user-level stores once and records them in kit.json', async (t) => {
  const { base, dir } = fixture(t);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, '.git'));
  const step = SYNC_STEPS.find((s) => s.id === 'memory-probe-cleanup');
  assert.ok(step, 'sync has a memory-probe-cleanup step');
  assert.equal(step.when(new Set(['memory']), {}, loadKitConfig()), true);
  assert.equal(step.when(new Set(['mcp']), {}, loadKitConfig()), false);
  const cfg = loadKitConfig();
  const reports = [];
  const ctx = { cfg, cwd: repo, flags: {}, step: async (name, thunk) => { const r = await thunk(); reports.push([name, r]); return r; } };
  await step.run(ctx);
  assert.equal(reports.length, 1);
  assert.equal(reports[0][1].ok, true, JSON.stringify(reports));
  assert.match(reports[0][1].detail, /removed 2 old ak setup probe rows \(backup and receipt in /);
  assert.deepEqual(findProbeRows(dir), []);
  const saved = loadKitConfig();
  assert.equal(Object.keys(saved.cleanups.setupProbeRows).length, 2);
  const receipts = fs.readdirSync(paths.memoryProbeCleanupDir()).filter((f) => f.endsWith('.json'));
  assert.equal(receipts.length, 1);
  assert.ok(receipts.every((f) => path.join(paths.memoryProbeCleanupDir(), f).startsWith(HOME)));
});
