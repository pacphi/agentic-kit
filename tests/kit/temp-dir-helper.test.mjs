// tests/kit/temp-dir-helper.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { tempDir } from './helpers/temp-dir.mjs';

let fromTest;
test('a per-test temp folder exists during the test', (t) => {
  fromTest = tempDir('ak-tempdir-probe', t);
  assert.ok(fs.statSync(fromTest).isDirectory());
  assert.ok(fromTest.startsWith(fs.realpathSync(os.tmpdir())));
});
test('and is gone after it', () => {
  assert.equal(fs.existsSync(fromTest), false);
});
