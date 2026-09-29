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
