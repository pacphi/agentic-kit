import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import { spawnEnv } from './helpers/home-sandbox.mjs';
import { ownerRecord, writeOwner, readOwner, collectAbandonedRoots, OWNER_FILE } from '../../scripts/run-roots.mjs';
import { runGuarded } from '../../scripts/run-tests.mjs';

const first = 2n ** 53n;
const second = first + 1n;
assert.equal(Number(first), Number(second), 'fixture must collide through Number');

// Model the OS exposing exact BigInt fields or lossy legacy Number fields.
function identity(stat, options, field, value) {
  const exact = options?.bigint === true;
  const key = !exact && field.endsWith('Ns') ? field.replace(/Ns$/, 'Ms') : field;
  stat[key] = exact ? value : Number(value) / (field.endsWith('Ns') ? 1e6 : 1);
  return stat;
}
function fixture(t) {
  const parent = fs.realpathSync(tempDir('ak-exact-root', t));
  const root = fs.mkdtempSync(path.join(parent, 'ak-suite-'));
  const home = path.join(parent, 'home');
  fs.mkdirSync(home);
  writeOwner(root, ownerRecord());
  return { parent, root, home };
}

for (const field of ['dev', 'ino', 'ctimeNs']) {
  for (const phase of ['open', 'read']) {
    test(`owner ${field} collision at ${phase} refuses swapped file`, (t) => {
      const { root } = fixture(t);
      const file = path.join(root, OWNER_FILE);
      const originalLstat = fs.lstatSync;
      const originalFstat = fs.fstatSync;
      let reads = 0;
      t.mock.method(fs, 'lstatSync', (target, options) => {
        const stat = originalLstat(target, options);
        return target === file ? identity(stat, options, field, ++reads === 1 ? first : second) : stat;
      });
      t.mock.method(fs, 'fstatSync', (fd, options) =>
        identity(originalFstat(fd, options), options, field, phase === 'open' ? second : first));
      assert.equal(readOwner(root), null);
    });
  }

  test(`sibling ${field} collision during injected proof retains root`, (t) => {
    const { parent, root, home } = fixture(t);
    const original = fs.lstatSync;
    let swapped = false;
    t.mock.method(fs, 'lstatSync', (target, options) => {
      const stat = original(target, options);
      return target === root ? identity(stat, options, field, swapped ? second : first) : stat;
    });
    let removals = 0;
    const result = collectAbandonedRoots({ tmpdir: parent, homedir: home, log: () => {},
      probes: { alive: () => false, startedAfter: () => false, completeExit: () => { swapped = true; return true; } },
      remove: () => { removals++; },
    });
    assert.equal(removals, 0);
    assert.deepEqual(result.removed, []);
    assert.match(result.kept[0].reason, /changed/);
    assert.ok(fs.existsSync(root));
  });
}

for (const field of ['dev', 'ino', 'birthtimeNs']) {
  test(`call-owned ${field} collision retains replacement untouched`, (t) => {
    const { parent, home } = fixture(t);
    const tmpdir = path.join(parent, 'tmp');
    const repoRoot = path.join(home, 'repo');
    fs.mkdirSync(tmpdir);
    fs.mkdirSync(repoRoot);
    const env = spawnEnv(home);
    t.mock.method(os, 'tmpdir', () => tmpdir);
    const original = fs.lstatSync;
    let swapped = false;
    let ownRoot;
    t.mock.method(fs, 'lstatSync', (target, options) => {
      const stat = original(target, options);
      if (!stat || path.dirname(String(target)) !== tmpdir || !/^ak-suite-[A-Za-z0-9]{6}$/.test(path.basename(String(target)))) return stat;
      ownRoot = target;
      for (const key of ['dev', 'ino', 'birthtimeNs']) identity(stat, options, key, first);
      return identity(stat, options, field, swapped ? second : first);
    });
    const messages = [];
    const code = runGuarded([], { env, homedir: home, repoRoot, log: (message) => {
      messages.push(message);
      if (message.startsWith('real-state tripwire:')) {
        // Preserve metadata so the ownership/hold checks alone cannot catch this swap.
        fs.cpSync(ownRoot, `${ownRoot}-saved`, { recursive: true });
        fs.rmSync(ownRoot, { recursive: true });
        fs.renameSync(`${ownRoot}-saved`, ownRoot);
        swapped = true;
      }
    } });
    assert.equal(code, 4);
    assert.match(messages.join('\n'), /directory identity changed/);
    assert.ok(fs.existsSync(path.join(ownRoot, OWNER_FILE)));
    assert.ok(fs.existsSync(path.join(ownRoot, '.ak-suite-holds')));
  });
}

test('unchanged exact owner identity accepts large IDs and preserves numeric attribution', (t) => {
  const { root } = fixture(t);
  const file = path.join(root, OWNER_FILE);
  const lstat = fs.lstatSync;
  const fstat = fs.fstatSync;
  const patch = (stat, options) => {
    for (const field of ['dev', 'ino', 'ctimeNs']) identity(stat, options, field, second);
    return stat;
  };
  t.mock.method(fs, 'lstatSync', (target, options) => {
    const stat = lstat(target, options);
    return target === file ? patch(stat, options) : stat;
  });
  t.mock.method(fs, 'fstatSync', (fd, options) => patch(fstat(fd, options), options));
  const owner = readOwner(root);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.uid, process.getuid?.() ?? null);
  assert.equal(typeof owner.startedAt, 'number');
});

test('exact owner stats reject foreign filesystem UID before opening', (t) => {
  if (!process.getuid) return; // Windows has no UID boundary to validate.
  const { root } = fixture(t);
  const file = path.join(root, OWNER_FILE);
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, options) => {
    const stat = lstat(target, options);
    if (target === file) stat.uid = options?.bigint ? BigInt(process.getuid()) + 1n : process.getuid() + 1;
    return stat;
  });
  const open = t.mock.method(fs, 'openSync', () => { throw Error('must not open foreign owner'); });
  assert.equal(readOwner(root), null);
  assert.equal(open.mock.callCount(), 0);
});
