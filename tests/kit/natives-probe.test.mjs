// The native load probe run for real: the actual `node -e` probe script (through
// run()) against fixture better-sqlite3 packages in a temp dir. The other natives
// tests inject the runner around this script, so this file is what proves the
// child reports its load error (AK_NATIVE_FAILURE + exit 2) and that the parent
// reads it. Hermetic: temp dirs only, no npm, no network, no global tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeBsq3Runtime } from '../../src/lib/natives.mjs';

/** <tmp>/ctx dir/node_modules/better-sqlite3 with the given index.js (a space
 *  in the context path, as in a user home with a space in it). */
function fixture(indexJs, { binding = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-probe-'));
  const dir = path.join(root, 'ctx dir');
  const pkg = path.join(dir, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"ctx"}');
  if (indexJs !== null) {
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"better-sqlite3","main":"index.js"}');
    fs.writeFileSync(path.join(pkg, 'index.js'), indexJs);
  } else {
    fs.rmSync(pkg, { recursive: true });
  }
  if (binding !== null) {
    fs.mkdirSync(path.join(pkg, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'build', 'Release', 'better_sqlite3.node'), binding);
  }
  return { root, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const WORKS = 'module.exports=class{prepare(){return{get:()=>({ok:1})}}close(){}}';

test('real probe: a loadable better-sqlite3 is native', async () => {
  const f = fixture(WORKS);
  try {
    assert.deepEqual(await probeBsq3Runtime(f.dir), { ok: true, state: 'native', attempts: 1 });
  } finally { f.cleanup(); }
});

test('real probe: a binding that will not load is unavailable with its cause, not the Node version line', async () => {
  const f = fixture("require('./build/Release/better_sqlite3.node')", { binding: 'not a native module' });
  try {
    const r = await probeBsq3Runtime(f.dir);
    assert.equal(r.state, 'unavailable');
    assert.equal(r.attempts, 1);
    assert.doesNotMatch(r.reason, /^Node\.js v\d/, 'the old reason was stderr\'s last line');
    assert.ok(!r.reason.includes(f.root), `the fixture path is stripped: ${r.reason}`);
    assert.match(r.reason, /better_sqlite3\.node/);
  } finally { f.cleanup(); }
});

test('real probe: an absent package is unavailable', async () => {
  const f = fixture(null);
  try {
    const r = await probeBsq3Runtime(f.dir);
    assert.equal(r.state, 'unavailable');
    assert.equal(r.reason, "Cannot find module 'better-sqlite3'");
  } finally { f.cleanup(); }
});

test('real probe: a wrong SELECT 1 row is unavailable', async () => {
  const f = fixture('module.exports=class{prepare(){return{get:()=>({ok:2})}}close(){}}');
  try {
    const r = await probeBsq3Runtime(f.dir);
    assert.equal(r.state, 'unavailable');
    assert.match(r.reason, /SELECT 1/);
  } finally { f.cleanup(); }
});

// contracts-6: a binding that crashes the probe is still inconclusive (by
// design: an abort can be ruvnet/ruflo#2885's exit-time crash), but the reason
// names the signal instead of claiming the probe "exited 1".
test('real probe: a binding that crashes the probe names the signal', {
  skip: process.platform === 'win32' ? 'POSIX signals' : false,
}, async () => {
  const f = fixture("process.kill(process.pid, 'SIGSEGV')");
  try {
    const r = await probeBsq3Runtime(f.dir);
    assert.equal(r.state, 'inconclusive');
    assert.match(r.reason, /SIGSEGV/);
    assert.doesNotMatch(r.reason, /exited 1/);
  } finally { f.cleanup(); }
});
