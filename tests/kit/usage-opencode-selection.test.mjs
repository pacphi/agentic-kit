import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import * as source from '../../src/lib/usage-opencode.mjs';
import { scanOpencodeDirectories } from '../../src/lib/footprint/project-sources.mjs';

test('OpenCode selection honors explicit authority, detects ambiguity, and rejects unsafe paths', () => {
  const dir = tempDir('ak-oc-selection-');
  try {
    const root = path.join(dir, 'opencode'); fs.mkdirSync(root);
    const channel = path.join(root, 'opencode-review_42.db'); fs.writeFileSync(channel, '');
    const env = { HOME: dir, XDG_DATA_HOME: dir };
    const select = (extra = {}) => source.selectOpencodeSource({ env, ...extra });
    assert.equal(typeof source.selectOpencodeSource, 'function');
    assert.equal(select().dbFile, fs.realpathSync(channel));
    fs.writeFileSync(path.join(root, 'opencode.db'), '');
    assert.equal(select().health.reason, 'database-selection-ambiguous');
    assert.equal(select().dbFile, null);
    assert.equal(select({ env: { ...env, OPENCODE_DISABLE_CHANNEL_DB: 'true' } }).dbFile, path.join(root, 'opencode.db'));
    assert.equal(select({ env: { ...env, OPENCODE_DB: 'opencode-review_42.db' } }).dbFile, fs.realpathSync(channel));
    assert.equal(select({ env: { ...env, OPENCODE_DB: channel } }).dbFile, fs.realpathSync(channel));
    assert.equal(select({ roots: {} }).dbFile, null);
    assert.equal(select({ roots: { opencode: channel }, env: { OPENCODE_DB: ':memory:' } }).dbFile, fs.realpathSync(channel));
    assert.equal(select({ env: { ...env, OPENCODE_DB: ':memory:' } }).health.reason, 'database-in-memory');
    for (const value of ['../outside.db', 'bad\0.db', 'bad\n.db']) {
      assert.equal(select({ env: { ...env, OPENCODE_DB: value } }).health.status, 'degraded');
    }
    assert.equal(select({ roots: { opencode: 'relative.db' } }).health.status, 'degraded');
    const project = scanOpencodeDirectories({ selection: select(), withDb: () => { throw Error('must not open ambiguous source'); } });
    assert.equal(project.reason, 'database-selection-ambiguous');
    assert.equal(project.complete, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('source discovery is bounded and unreadable candidates never trigger a fallback', () => {
  const dir = tempDir('ak-oc-bound-');
  try {
    const root = path.join(dir, 'opencode'); fs.mkdirSync(root);
    const env = { HOME: dir, XDG_DATA_HOME: dir };
    for (let i = 0; i < 257; i++) fs.writeFileSync(path.join(root, `other-${i}`), '');
    assert.equal(source.selectOpencodeSource({ env }).health.reason, 'database-discovery-limit');
    const denied = { ...fs, opendirSync: () => { throw Object.assign(Error('private path'), { code: 'EACCES' }); } };
    assert.equal(source.selectOpencodeSource({ env, fsImpl: denied }).health.reason, 'database-discovery-unreadable');
    const loop = { ...fs, realpathSync: () => { throw Object.assign(Error('private path'), { code: 'ELOOP' }); } };
    const result = source.selectOpencodeSource({ roots: { opencode: path.join(root, 'chosen.db') }, fsImpl: loop });
    assert.equal(result.dbFile, null);
    assert.equal(result.health.reason, 'database-path-unreadable');
    assert.ok(!JSON.stringify(result.health).includes(dir));
    assert.equal(source.selectOpencodeSource({ env: { HOME: dir, XDG_DATA_HOME: 'relative', OPENCODE_DB: 'selected.db' } }).dbFile,
      path.join(dir, '.local', 'share', 'opencode', 'selected.db'));
    const missing = source.selectOpencodeSource({ roots: { opencode: path.join(root, 'missing.db') } });
    assert.equal(scanOpencodeDirectories({ selection: missing }).status, 'absent');
    assert.equal(fs.existsSync(missing.dbFile), false, 'read-only discovery does not create missing stores');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('project source health reports unreadable database categories without private error text', () => {
  const result = scanOpencodeDirectories({ dbFile: path.resolve('unreadable.db'),
    withDb: () => ({ ok: false, error: { kind: 'permission', message: 'private database location' } }) });
  assert.equal(result.status, 'degraded');
  assert.equal(result.reason, 'permission');
});

// The deterministic iterator orders an actual dangling link between two actual
// stores. Production must not treat a candidate's ENOENT as a missing root.
test('a dangling eligible candidate cannot hide a second real database', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir('ak-oc-dangling-');
  try {
    const root = path.join(dir, 'opencode'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'opencode-a.db'), '');
    fs.symlinkSync(path.join(root, 'missing.db'), path.join(root, 'opencode-b.db'));
    fs.writeFileSync(path.join(root, 'opencode-c.db'), '');
    const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    let closed = false;
    const fsImpl = { ...fs, opendirSync: () => ({ readSync: () => entries.shift() ?? null, closeSync: () => { closed = true; } }) };
    const selection = source.selectOpencodeSource({ env: { HOME: dir, XDG_DATA_HOME: dir }, fsImpl });
    assert.equal(selection.dbFile, null);
    assert.equal(selection.health.status, 'degraded');
    assert.equal(closed, true);
    const projects = scanOpencodeDirectories({ selection, withDb: () => { throw Error('uncertain source must not be opened'); } });
    assert.equal(projects.complete, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const failure of ['stat-ENOENT', 'stat-EACCES', 'read-ENOENT', 'read-EIO', 'close-EIO', 'limit']) {
  test(`partial discovery never establishes uniqueness after ${failure}`, () => {
    const dir = tempDir('ak-oc-partial-');
    try {
      const root = path.join(dir, 'opencode'); fs.mkdirSync(root);
      const first = path.join(root, 'opencode-a.db'); fs.writeFileSync(first, '');
      const second = path.join(root, 'opencode-b.db'); fs.writeFileSync(second, '');
      let count = 0;
      const [operation, code] = failure.split('-');
      const fail = () => { throw Object.assign(Error('private path'), { code }); };
      const fsImpl = { ...fs,
        opendirSync: () => ({
          readSync: () => {
            count++;
            if (count === 1) return { name: 'opencode-a.db' };
            if (operation === 'read') return fail();
            if (operation === 'limit') return { name: `unrelated-${count}` };
            return count === 2 ? { name: 'opencode-b.db' } : null;
          },
          closeSync: () => { if (operation === 'close') fail(); },
        }),
        statSync: (file) => file === second && operation === 'stat' ? fail() : fs.statSync(file),
      };
      const result = source.selectOpencodeSource({ env: { HOME: dir, XDG_DATA_HOME: dir }, fsImpl });
      assert.equal(result.dbFile, null);
      assert.equal(result.health.status, 'degraded');
      assert.ok(!JSON.stringify(result.health).includes(dir));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('absolute OpenCode authority survives invalid ambient home when legacy root cannot be resolved', () => {
  const dir = tempDir('ak-oc-absolute');
  const dbFile = path.join(dir, 'explicit.db');
  const selected = source.selectOpencodeSource({ env: { HOME: 'relative', OPENCODE_DB: dbFile } });
  assert.equal(selected.dbFile, dbFile);
  assert.equal(selected.legacyRoot, null);
  assert.equal(source.selectOpencodeSource({ env: { HOME: 'relative', OPENCODE_DB: ':memory:' } }).health.reason, 'database-in-memory');
});
