import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBinPath } from '../../src/lib/footprint/install.mjs';

test('POSIX resolution skips non-executable files and resolves a symlink to a regular executable', (t) => {
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

test('Windows resolution uses semicolon paths, quoted directories, mixed-case env keys, and PATHEXT', () => {
  const wanted = 'C:\\Program Files\\Tools\\tool.CMD';
  const fsImpl = {
    realpathSync(file) { if (file !== wanted) throw new Error('missing'); return file; },
    statSync() { return { isFile: () => true }; },
  };
  assert.equal(resolveBinPath('tool', { windows: true, env: { Path: 'C:\\missing;"C:\\Program Files\\Tools"', PathExt: '.EXE;.CMD' }, fsImpl }), wanted);
});
