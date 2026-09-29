import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import { ownerRecord, writeOwner, readOwner, unsafeTempBase, removableRunRoot,
  proveAbandoned, collectAbandonedRoots, defaultProbes, OWNER_FILE,
  prepareRunRootHolds, acquireRunRootHold, releaseRunRootHold, inspectRunRootHolds } from '../../scripts/run-roots.mjs';

const uid = process.getuid?.() ?? null;
const complete = { alive: () => false, startedAfter: () => false, completeExit: () => true };
function fixture(t) {
  const tmpdir = tempDir('ak-root-fixture', t);
  const root = fs.mkdtempSync(path.join(tmpdir, 'ak-suite-'));
  const homedir = path.join(tmpdir, 'home');
  fs.mkdirSync(homedir);
  writeOwner(root, ownerRecord());
  return { root, tmpdir, homedir, uid };
}
function collect(f, probes = complete, extra = {}) {
  return collectAbandonedRoots({ ...f, probes, log: () => {}, ...extra });
}

test('private atomic owner metadata round trips and does not leave staging data', (t) => {
  const f = fixture(t);
  const record = readOwner(f.root);
  assert.equal(record.pid, process.pid);
  assert.equal(record.root, f.root);
  assert.equal(record.tmpdir, f.tmpdir);
  assert.equal(record.proofMode, 'list-only');
  assert.deepEqual(fs.readdirSync(f.root), [OWNER_FILE]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.root, OWNER_FILE)).mode & 0o777, 0o600);
});

test('parallel prelaunch holds release only their own marker; uncertain inspection retains', (t) => {
  const f = fixture(t);
  const owner = readOwner(f.root);
  prepareRunRootHolds(f.root, owner.runId);
  const env = { AK_SUITE_ROOT: f.root, AK_SUITE_RUN_ID: owner.runId };
  const first = acquireRunRootHold({ env });
  const second = acquireRunRootHold({ env });
  assert.equal(inspectRunRootHolds(f.root, owner.runId).unresolved, true);
  assert.throws(() => releaseRunRootHold({ ...first, pid: 0 }));
  const dir = path.join(f.root, '.ak-suite-holds');
  const saved = path.join(f.root, 'saved-holds');
  fs.renameSync(dir, saved);
  try {
    fs.symlinkSync(saved, dir, 'junction');
    assert.throws(() => releaseRunRootHold(first));
  } finally {
    if (fs.existsSync(dir)) fs.unlinkSync(dir);
    fs.renameSync(saved, dir);
  }
  releaseRunRootHold(first);
  assert.equal(inspectRunRootHolds(f.root, owner.runId).unresolved, true);
  releaseRunRootHold(second);
  assert.equal(inspectRunRootHolds(f.root, owner.runId).unresolved, false);
  assert.throws(() => acquireRunRootHold({ env: { ...env, AK_SUITE_RUN_ID: 'foreign' } }));
  assert.equal(acquireRunRootHold({ env: {} }), null);
  fs.rmSync(path.join(f.root, '.ak-suite-holds'), { recursive: true });
  assert.equal(inspectRunRootHolds(f.root, owner.runId).unresolved, true);
  assert.throws(() => acquireRunRootHold({ env }));
});

test('native defaults never prove abandonment, including dead owners and reused PIDs', (t) => {
  const f = fixture(t);
  for (const platform of ['darwin', 'linux', 'win32', 'other']) {
    assert.equal(proveAbandoned(f.root, readOwner(f.root), defaultProbes(platform)).abandoned, false);
    assert.deepEqual(collect(f, defaultProbes(platform)).removed, []);
  }
  for (const probes of [ { ...complete, alive: () => true }, { ...complete, alive: () => null },
    { ...complete, completeExit: () => null }, { ...complete, completeExit: () => false },
    { ...complete, alive: () => true, startedAfter: () => null },
    { ...complete, alive: () => { throw Error('uncertain'); } } ]) {
    assert.equal(collect(f, probes).kept.length, 1);
    assert.ok(fs.existsSync(f.root));
  }
});

test('only explicit complete fixture proof permits deletion; reused PID needs independent descendant proof', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'payload'), 'fixture');
  assert.deepEqual(collect(f, { ...complete, alive: () => true, startedAfter: () => true }).removed, [f.root]);
  assert.equal(fs.existsSync(f.root), false);
});

test('missing, malformed, oversized, foreign and path-mismatched owners stay listed', (t) => {
  const f = fixture(t);
  const record = readOwner(f.root);
  const file = path.join(f.root, OWNER_FILE);
  const values = ['{', 'x'.repeat(8193), 'null', '[]', JSON.stringify({ ...record, schema: 2 }),
    ...[{ pid: 0 }, { startedAt: -1 }, { hostname: 'foreign' }, { uid: 123456789 },
      { platform: 'foreign' }, { root: f.tmpdir }, { tmpdir: f.root }, { proofMode: 'delete' },
      { runId: '' }].map((patch) => JSON.stringify({ ...record, ...patch }))];
  fs.unlinkSync(file);
  assert.equal(collect(f).kept.length, 1);
  for (const value of values) {
    fs.writeFileSync(file, value);
    assert.equal(readOwner(f.root), null, value.slice(0, 100));
    assert.equal(collect(f).kept.length, 1);
    assert.ok(fs.existsSync(f.root));
  }
});

test('symlink owner files and directory owners are never read', (t) => {
  const f = fixture(t);
  const file = path.join(f.root, OWNER_FILE);
  fs.renameSync(file, path.join(f.tmpdir, 'record'));
  fs.symlinkSync(path.join(f.tmpdir, 'record'), file);
  assert.equal(readOwner(f.root), null);
  assert.equal(collect(f).kept.length, 1);
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.equal(readOwner(f.root), null);
});

test('unsafe home and filesystem-root temp parents are refused for POSIX and Windows', () => {
  for (const [tmp, home] of [['/', '/home/me'], ['/home/me', '/home/me'], ['C:\\', 'C:\\Users\\me'],
    ['C:\\Users\\ME', 'c:\\users\\me'], ['\\\\server\\share\\', 'C:\\Users\\me']]) {
    assert.ok(unsafeTempBase(tmp, home));
  }
  assert.equal(unsafeTempBase('/tmp', '/home/me'), null);
  assert.equal(unsafeTempBase('C:\\Temp', 'C:\\Users\\me'), null);
});

test('root guards reject path escapes, aliases, non-direct children, wrong owners and symlinks', (t) => {
  const f = fixture(t);
  assert.equal(removableRunRoot(f.root, { ...f, requireOwner: true }).ok, true);
  for (const dir of ['relative', f.tmpdir, path.join(f.root, 'ak-suite-AAAAAA'),
    `${f.tmpdir}/x/../${path.basename(f.root)}`]) {
    assert.equal(removableRunRoot(dir, f).ok, false);
  }
  assert.equal(removableRunRoot(f.root, { ...f, tmpdir: f.homedir }).ok, false);
  assert.equal(removableRunRoot(f.root, { ...f, homedir: f.tmpdir }).ok, false);
  if (uid !== null) assert.equal(removableRunRoot(f.root, { ...f, uid: uid + 1 }).ok, false);
  const alias = path.join(f.tmpdir, 'ak-suite-AAAAAA');
  fs.symlinkSync(f.root, alias, 'junction');
  fs.mkdirSync(path.join(f.tmpdir, 'ak-suite-not-exact'));
  assert.equal(removableRunRoot(alias, f).ok, false);
  const r = collect(f, complete, { selfRoot: f.root });
  assert.deepEqual(r.removed, []);
  assert.equal(r.kept.length, 1);
  assert.ok(fs.existsSync(f.root));
});

test('revalidation refuses root replacement during the proof', (t) => {
  const f = fixture(t);
  const r = collect(f, { ...complete, completeExit: () => {
    fs.renameSync(f.root, `${f.root}-saved`);
    fs.mkdirSync(f.root); writeOwner(f.root, ownerRecord());
    return true;
  } });
  assert.deepEqual(r.removed, []);
  assert.match(r.kept[0].reason, /changed/);
  assert.ok(fs.existsSync(f.root));
});

test('removal errors disclose possible partial deletion and listing errors are reported', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'payload'), 'fixture');
  const r = collect(f, complete, { remove: (root) => {
    fs.unlinkSync(path.join(root, 'payload')); throw Error('EBUSY');
  } });
  assert.deepEqual(r.removed, []);
  assert.match(r.kept[0].reason, /partially removed.*EBUSY/);
  assert.equal(fs.existsSync(path.join(f.root, 'payload')), false);
  assert.equal(collect({ ...f, tmpdir: path.join(f.tmpdir, 'absent') }).kept.length, 1);
});

test('default probe functions explicitly report unknown without supplying authority', () => {
  const probes = defaultProbes();
  assert.equal(probes.alive(process.pid), null);
  assert.equal(probes.startedAfter(process.pid, Date.now()), null);
  assert.equal(probes.completeExit('/unused', {}), null);
});

test('owner publication rejects invalid attribution and refuses existing staging links', (t) => {
  const f = fixture(t);
  assert.throws(() => writeOwner(`${f.root}/.`, ownerRecord()), /noncanonical/);
  assert.throws(() => writeOwner(f.root, ownerRecord({ pid: 0 })), /invalid/);
  const target = path.join(f.tmpdir, 'target');
  fs.writeFileSync(target, 'untouched');
  fs.symlinkSync(target, path.join(f.root, `${OWNER_FILE}.tmp`));
  assert.throws(() => writeOwner(f.root, ownerRecord()), /EEXIST/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
});

test('owner reader refuses oversized or replaced files at its descriptor boundary', (t) => {
  const f = fixture(t);
  const realFstat = fs.fstatSync;
  const realRead = fs.readSync;
  for (const patch of [{ size: 8193 }, { ino: -1 }, { isFile: () => false }]) {
    const mock = t.mock.method(fs, 'fstatSync', (...args) => Object.assign(realFstat(...args), patch));
    assert.equal(readOwner(f.root), null);
    mock.mock.restore();
  }
  const mock = t.mock.method(fs, 'readSync', (...args) => { realRead(...args); return 8193; });
  assert.equal(readOwner(f.root), null);
  mock.mock.restore();
  const file = path.join(f.root, OWNER_FILE);
  const hardlink = path.join(f.tmpdir, 'hardlink');
  fs.linkSync(file, hardlink);
  assert.equal(readOwner(f.root), null);
});

test('inspection races retain roots before any removal attempt', (t) => {
  const f = fixture(t);
  const original = fs.lstatSync;
  let calls = 0;
  const mock = t.mock.method(fs, 'lstatSync', (...args) => {
    if (args[0] === f.root && ++calls === 2) throw Error('inspection denied');
    return original(...args);
  });
  const r = collect(f);
  assert.deepEqual(r.removed, []);
  assert.match(r.kept[0].reason, /inspection.*failed/);
  mock.mock.restore();
  const ownerFile = path.join(f.root, OWNER_FILE);
  let reads = 0;
  const mock2 = t.mock.method(fs, 'lstatSync', (...args) => {
    if (args[0] === ownerFile && ++reads === 3) throw Error('owner vanished');
    return original(...args);
  });
  assert.match(collect(f).kept[0].reason, /owner changed/);
  mock2.mock.restore();
  assert.ok(fs.existsSync(f.root));
});

test('default collection keeps valid roots without injected probes', (t) => {
  const f = fixture(t);
  const messages = [];
  const r = collectAbandonedRoots({ ...f, log: (s) => messages.push(s) });
  assert.deepEqual(r.removed, []);
  assert.match(messages[0], /list-only/);
});

test('missing roots and noncanonical parents fail closed', (t) => {
  const f = fixture(t);
  fs.rmSync(f.root, { recursive: true });
  assert.equal(removableRunRoot(f.root, f).ok, false);
  assert.equal(removableRunRoot(f.root, { ...f, tmpdir: 'relative' }).ok, false);
});

test('platforms without numeric uid retain attributable roots by default', (t) => {
  const original = Object.getOwnPropertyDescriptor(process, 'getuid');
  Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
  t.after(() => { if (original) Object.defineProperty(process, 'getuid', original); });
  const f = fixture(t);
  assert.equal(readOwner(f.root).uid, null);
  assert.deepEqual(collectAbandonedRoots({ ...f, uid: null, log: () => {} }).removed, []);
});

test('logging failure cannot turn a completed removal into an intact-preservation claim', (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() => {
    const result = collectAbandonedRoots({ ...f, probes: complete, log: () => { throw Error('closed pipe'); } });
    assert.deepEqual(result.removed, [f.root]);
    assert.deepEqual(result.kept, []);
  });
});

test('direct abandonment proof refuses malformed metadata even with complete injected probes', (t) => {
  const f = fixture(t);
  for (const record of [null, {}, { ...readOwner(f.root), pid: -1 }]) {
    assert.equal(proveAbandoned(f.root, record, complete).abandoned, false);
  }
});
