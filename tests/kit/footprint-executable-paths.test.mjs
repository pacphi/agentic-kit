import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBinPath } from '../../src/lib/footprint/install.mjs';

test('POSIX resolution skips non-executable files and resolves a symlink to a regular executable', { skip: process.platform === 'win32' && 'requires native POSIX execute permissions and paths' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-executable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['first', 'second']) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, 'first', 'tool'), '', { mode: 0o600 });
  const target = path.join(root, 'real');
  fs.writeFileSync(target, '', { mode: 0o700 });
  fs.symlinkSync(target, path.join(root, 'second', 'tool'));
  assert.equal(resolveBinPath('tool', { windows: false, env: { PATH: `${root}/first:${root}/second` } }), fs.realpathSync(target));
  assert.equal(resolveBinPath('../real', { windows: false, env: { PATH: root } }), null);
});

test('POSIX resolution checks execute permission and follows the resolved target on every host', () => {
  const checked = [];
  const fsImpl = {
    realpathSync(file) { return file === '/second/tool' ? '/real/tool' : file; },
    statSync() { return { isFile: () => true }; },
    accessSync(file, mode) {
      checked.push([file, mode]);
      if (file === '/first/tool') throw Object.assign(new Error('not executable'), { code: 'EACCES' });
    },
  };
  assert.equal(resolveBinPath('tool', { windows: false, env: { PATH: '/first:/second' }, fsImpl }), '/real/tool');
  assert.deepEqual(checked, [['/first/tool', fs.constants.X_OK], ['/real/tool', fs.constants.X_OK]]);
  assert.equal(resolveBinPath('../tool', { windows: false, env: { PATH: '/real' }, fsImpl }), null);
});

test('Windows resolution uses semicolon paths, quoted directories, mixed-case env keys, and PATHEXT', () => {
  const wanted = 'C:\\Program Files\\Tools\\tool.CMD';
  const fsImpl = {
    realpathSync(file) { if (file !== wanted) throw new Error('missing'); return file; },
    statSync() { return { isFile: () => true }; },
  };
  assert.equal(resolveBinPath('tool', { windows: true, env: { Path: 'C:\\missing;"C:\\Program Files\\Tools"', PathExt: '.EXE;.CMD' }, fsImpl }), wanted);
});
