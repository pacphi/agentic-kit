import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import section from '../../src/commands/status/sections/project-memory.mjs';
import * as paths from '../../src/lib/paths.mjs';

test('memory status never treats file presence as a proven writer and checks both stores', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-status-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.equal((await section.collect({ cwd }))[0].level, 'info');
  fs.mkdirSync(path.join(cwd, '.swarm'));
  const native = path.join(cwd, '.swarm/agentdb-memory.db');
  const db = new DatabaseSync(native);
  db.exec('CREATE TABLE memory_entries (status TEXT); INSERT INTO memory_entries VALUES (NULL)');
  db.close();
  const single = await section.collect({ cwd });
  // The canonical-store row leads; the store's own row follows it.
  const store = single.find((r) => /^agentdb-memory\.db:/.test(r.message));
  assert.ok(single.every((r) => r.level === 'info'));
  assert.match(store.message, /agentdb-memory\.db: 1 active entry observed.*backend.*routing unverified/);
  assert.doesNotMatch(store.message, /native-agentdb:/);
  fs.writeFileSync(path.join(cwd, '.swarm/memory.db'), 'corrupt');
  const dual = await section.collect({ cwd });
  assert.ok(dual.some((r) => r.level === 'warn' && /memory\.db store is unreadable/.test(r.message)));
  assert.ok(dual.some((r) => /two project memory stores/.test(r.message)));
  assert.ok(dual.some((r) => /--path/.test(r.message)));
  assert.ok(dual.some((r) => /preserve both/.test(r.message)));
  assert.ok(dual.every((r) => r.level !== 'ok' && r.fix === null));
});

function dualStoreProject(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-routing-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, '.swarm'));
  for (const file of ['memory.db', 'agentdb-memory.db']) {
    const db = new DatabaseSync(path.join(cwd, '.swarm', file));
    db.exec('CREATE TABLE memory_entries (status TEXT); INSERT INTO memory_entries VALUES (NULL)');
    db.close();
  }
  return cwd;
}

const coexist = (rows) => rows.find((r) => /two project memory stores/.test(r.message));
const UNVERIFIED = /MCP routing needs separate verification/;

test('on an observed release and platform the two-store row states which interface reads which file', async (t) => {
  const cwd = dualStoreProject(t);
  for (const rufloVersion of ['3.42.4', '3.45.0']) {
    const { message, level, fix } = coexist(await section.collect({ cwd, rufloVersion, platform: 'darwin' }));
    assert.equal(level, 'warn', 'the split stays a warning');
    assert.equal(fix, null, 'nothing for sync to repair: both stores are preserved');
    assert.match(message, /CLI[^.]*memory\.db/);
    assert.match(message, /MCP[^.]*agentdb-memory\.db/);
    assert.match(message, /native bridge/, 'the claim is conditional on the native bridge');
    assert.match(message, /preserve both/);
    assert.match(message, /--path/);
    assert.match(message, /ak x verify memory/, 'points at the live check instead of asserting it');
    assert.doesNotMatch(message, UNVERIFIED, rufloVersion);
  }
});

test('any other release, platform, or non-release version keeps routing unverified', async (t) => {
  const cwd = dualStoreProject(t);
  const cases = [
    ['3.41.2', 'darwin'], ['3.42.3', 'darwin'], ['3.42.5', 'darwin'], ['3.43.0', 'darwin'], ['3.44.0', 'darwin'],
    ['3.45.1', 'darwin'], ['4.0.0', 'darwin'],
    ['3.42.4-alpha.1', 'darwin'], ['3.45.0+build.7', 'darwin'], ['v3.45.0', 'darwin'], [null, 'darwin'], ['', 'darwin'],
    ['3.42.4', 'linux'], ['3.45.0', 'linux'], ['3.45.0', 'win32'],
  ];
  for (const [rufloVersion, platform] of cases) {
    const { message } = coexist(await section.collect({ cwd, rufloVersion, platform }));
    assert.match(message, UNVERIFIED, `${rufloVersion} on ${platform}: no claim beyond the evidence`);
    assert.match(message, /preserve both/);
  }
});

function withGlobalRoot(t, { ruflo, cli, hoisted }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-global-root-'));
  const put = (dir, version) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ version }));
  };
  if (ruflo) put('ruflo', ruflo);
  if (cli) put('ruflo/node_modules/@claude-flow/cli', cli);
  if (hoisted) put('@claude-flow/cli', hoisted);
  paths._setGlobalRootForTest(root);
  t.after(() => { paths._setGlobalRootForTest(null); fs.rmSync(root, { recursive: true, force: true }); });
}

test('routing is gated on the resolved @claude-flow/cli, not the ruflo wrapper version', async (t) => {
  const cwd = dualStoreProject(t);
  withGlobalRoot(t, { ruflo: '3.45.0', cli: '3.45.1' });
  assert.match(coexist(await section.collect({ cwd, platform: 'darwin' })).message, UNVERIFIED,
    'the wrapper is in range but the CLI that decides routing is not');
});

test('the resolved CLI version is what enables the observed wording', async (t) => {
  const cwd = dualStoreProject(t);
  withGlobalRoot(t, { ruflo: '3.45.9', cli: '3.45.0' });
  assert.doesNotMatch(coexist(await section.collect({ cwd, platform: 'darwin' })).message, UNVERIFIED);
});

function rufloStore(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE memory_entries (id TEXT PRIMARY KEY, namespace TEXT, status TEXT, expires_at INTEGER)');
  const put = db.prepare('INSERT INTO memory_entries VALUES (?, ?, ?, ?)');
  rows.forEach(([namespace, expiresAt = null], i) => put.run(String(i), namespace, 'active', expiresAt));
  db.close();
}

test('memory status names the canonical store and gives each file its size, WAL, top namespace and expiry', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-canonical-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const root = fs.realpathSync(cwd);
  rufloStore(path.join(cwd, '.swarm', 'agentdb-memory.db'), [['commands'], ['commands'], ['commands'], ['decisions', 1]]);
  fs.writeFileSync(path.join(cwd, '.swarm', 'agentdb-memory.db-wal'), Buffer.alloc(2_500_000));
  const rows = await section.collect({ cwd });
  assert.ok(rows.every((r) => r.subsystem === 'memory' && r.fix === null));
  const canonical = rows.find((r) => /canonical project store/.test(r.message));
  assert.ok(canonical, 'a row names the canonical store');
  assert.equal(canonical.level, 'info');
  assert.ok(canonical.message.includes(path.join(root, '.swarm')), canonical.message);
  const store = rows.find((r) => /^agentdb-memory\.db:/.test(r.message));
  assert.equal(store.level, 'info');
  assert.match(store.message, /agentdb-memory\.db: 4 active entries observed.*backend.*routing unverified/);
  assert.match(store.message, /\d+(\.\d)? KB/, 'the file size is shown');
  assert.match(store.message, /WAL 2\.5 MB/, 'the live WAL is shown');
  assert.match(store.message, /top namespace "commands" 75%/);
  assert.match(store.message, /no expiry/, 'rows that never expire are called out');
});

test('memory status resolves the canonical store at the repository root from a subfolder', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, '.git'));
  rufloStore(path.join(repo, '.swarm', 'memory.db'), [['default']]);
  const sub = path.join(repo, 'packages', 'app');
  rufloStore(path.join(sub, '.swarm', 'agentdb-memory.db'), [['default']]);
  const rows = await section.collect({ cwd: sub });
  const canonical = rows.find((r) => /canonical project store/.test(r.message));
  assert.ok(canonical.message.includes(path.join(fs.realpathSync(repo), '.swarm')), canonical.message);
  assert.ok(rows.some((r) => /^memory\.db: 1 active entry observed/.test(r.message)), 'the root store is the one reported');
  assert.ok(!rows.some((r) => /two project memory stores/.test(r.message)), 'a subfolder store is not the canonical sibling');
  const stray = rows.find((r) => /packages\/app\/\.swarm\/agentdb-memory\.db/.test(r.message));
  assert.ok(stray, 'the subfolder store is reported as stray');
  assert.equal(stray.level, 'info');
});

test('an empty agentdb-memory.db from memory init is reported as empty, never as unreadable', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-init-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  rufloStore(path.join(cwd, '.swarm', 'memory.db'), [['default']]);
  const db = new DatabaseSync(path.join(cwd, '.swarm', 'agentdb-memory.db'));
  db.exec('CREATE TABLE episodes (id INTEGER PRIMARY KEY)');
  db.close();
  const rows = await section.collect({ cwd });
  assert.ok(!rows.some((r) => /unreadable/.test(r.message)), JSON.stringify(rows));
  const empty = rows.find((r) => /^agentdb-memory\.db:/.test(r.message));
  assert.equal(empty.level, 'info');
  assert.match(empty.message, /no memory table yet/);
});

test('stray stores are reported for information only, grouped by owner, with no repair offered', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-owners-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  rufloStore(path.join(cwd, '.swarm', 'memory.db'), [['default']]);
  rufloStore(path.join(cwd, '.swarm', '.swarm', 'agentdb-memory.db'), [['project-progression']]);
  for (const file of ['agentdb.db', 'agentdb.rvf', 'ruvector.db']) fs.writeFileSync(path.join(cwd, file), 'x');
  for (const dir of ['docs', 'docker', 'claude']) fs.mkdirSync(path.join(cwd, dir, '.agentic-qe'), { recursive: true });
  const rows = await section.collect({ cwd });
  const strays = rows.filter((r) => /stray/.test(r.message));
  assert.equal(strays.length, 5, JSON.stringify(strays.map((r) => r.message)));
  assert.ok(strays.every((r) => r.level === 'info' && r.fix === null), 'report only: never a warning, never a sync fix');
  const expectations = [
    /\.swarm\/\.swarm\/agentdb-memory\.db/,
    /agentdb\.db[^-]/,
    /agentdb\.rvf/,
    /ruvector\.db/,
    /3 stray AQE stores.*claude\/\.agentic-qe.*docker\/\.agentic-qe.*docs\/\.agentic-qe/,
  ];
  for (const pattern of expectations) assert.ok(strays.some((r) => pattern.test(r.message)), `${pattern}`);
  assert.ok(strays.every((r) => /leaves|report/.test(r.message)), 'each row says ak does not touch it');
});

test('a project with no memory store still reports stray stores and keeps the single setup hint otherwise', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-none-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const clean = await section.collect({ cwd });
  assert.equal(clean.length, 1, 'no store and no strays: exactly the one hint row');
  assert.match(clean[0].message, /no project memory store yet/);
  fs.writeFileSync(path.join(cwd, 'ruvector.db'), 'x');
  const withStray = await section.collect({ cwd });
  assert.equal(withStray.length, 2);
  assert.match(withStray[1].message, /ruvector\.db/);
});

test('a hoisted @claude-flow/cli is used only when ruflo has no nested copy, and no CLI means unverified', async (t) => {
  const cwd = dualStoreProject(t);
  withGlobalRoot(t, { ruflo: '3.45.0', hoisted: '3.45.0' });
  assert.doesNotMatch(coexist(await section.collect({ cwd, platform: 'darwin' })).message, UNVERIFIED);
  withGlobalRoot(t, { ruflo: '3.45.0' });
  assert.match(coexist(await section.collect({ cwd, platform: 'darwin' })).message, UNVERIFIED);
});
