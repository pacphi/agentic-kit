import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../../src/lib/cache-dir.mjs';
import { run } from '../../src/lib/exec.mjs';
import { writeFileWithBackup, writePrivateFileAtomic } from '../../src/lib/file-write.mjs';
import { clearViolations, violations, withWriteScope } from '../../src/lib/scope-gate.mjs';
import { rmrf, sandboxHome } from './helpers/home-sandbox.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const home = sandboxHome('scope-gate-hooks');
after(() => rmrf(home));
beforeEach(() => clearViolations());

test('writeFileWithBackup reports a write outside the root and still performs it', (t) => {
  const root = tempDir('hooks-root', t);
  const outside = tempDir('hooks-outside', t);
  const file = path.join(outside, 'settings.json');
  withWriteScope({ root }, () => writeFileWithBackup(file, '{}\n'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
  assert.equal(violations().length, 1);
  assert.equal(violations()[0].target, file);
});

test('writeFileWithBackup inside the root is not reported', (t) => {
  const root = tempDir('hooks-root', t);
  withWriteScope({ root }, () => writeFileWithBackup(path.join(root, 'CLAUDE.md'), 'x\n'));
  assert.deepEqual(violations(), []);
});

test('writePrivateFileAtomic reports outside the cache and accepts a write inside it', (t) => {
  const outside = tempDir('hooks-outside', t);
  writePrivateFileAtomic(path.join(outside, 'store.json'), '{}');
  assert.equal(violations().length, 1);
  clearViolations();
  const inCache = path.join(cacheDir(), 'store.json');
  writePrivateFileAtomic(inCache, '{}');
  assert.equal(fs.readFileSync(inCache, 'utf8'), '{}');
  assert.deepEqual(violations(), []);
});

test('run reports a user-level command and still returns the spawn failure', async () => {
  const result = await run('launchctl', ['list']);
  assert.notEqual(result.code, 0);
  assert.equal(typeof result.stderr, 'string');
  assert.equal(violations().length, 1);
  assert.equal(violations()[0].rule, 'launchctl');
});

test('run reports a global npm install made from its working folder', async (t) => {
  const root = tempDir('hooks-root', t);
  const result = await withWriteScope({ root }, () => run('npm', ['install', '-g', 'x'], { cwd: root }));
  assert.notEqual(result.code, 0);
  assert.equal(violations().length, 1);
  assert.equal(violations()[0].rule, 'npm-install-global');
  assert.equal(violations()[0].cwd, root);
});

test('run does not report an ordinary command', async () => {
  await run('git', ['--version']);
  assert.deepEqual(violations(), []);
});
