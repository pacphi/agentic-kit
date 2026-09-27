// ak's edits inside another tool's install are recorded, shown and reversible
// (audit 2026-09-26 Addendum 2, problem 3, choice B). ensureNativeBsq3 rewrites
// better-sqlite3 lines in a bundled package.json (npm otherwise fails with
// EOVERRIDE) to enforce Ruflo's own native-SQLite intent (ruvnet/ruflo#2219).
// Every test uses a temporary ledger and a fixture tree; no real install and
// no real state folder is read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureNativeBsq3, healNatives } from '../../src/lib/heal.mjs';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';
import { installEditStatus, readInstallEdits, restoreInstallEdits } from '../../src/lib/install-edits.mjs';
import { installEditRows } from '../../src/commands/status/sections/natives.mjs';
import { UNINSTALL_STEPS } from '../../src/commands/uninstall.mjs';

const BINDING = path.join('build', 'Release', 'better_sqlite3.node');

function scratch(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** ruflo/node_modules/@claude-flow/cli pinning better-sqlite3 in two
 *  self-declared fields that disagree, with no better-sqlite3 resolvable. */
function conflictTree(t) {
  const root = scratch(t, 'ak-install-edits-');
  const dir = path.join(root, 'ruflo', 'node_modules', '@claude-flow', 'cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@claude-flow/cli',
    overrides: { 'better-sqlite3': '^12.10.0' },
    optionalDependencies: { 'better-sqlite3': '^12.9.0' },
  }, null, 2));
  return { root, dir, file: path.join(dir, 'package.json'), ledger: path.join(root, 'state', 'install-edits.json') };
}

const readPkg = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** npm, just enough: `pkg set a.b=v` / `pkg delete a.b` edit package.json in
 *  cwd; `install better-sqlite3@…` plants a built copy. */
function fakeNpm({ onPkg = () => {}, failPkg = false } = {}) {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts?.cwd });
    if (args[0] === 'pkg') {
      onPkg(args);
      if (failPkg) return { code: 1, stdout: '', stderr: 'npm error EACCES' };
      const file = path.join(opts.cwd, 'package.json');
      const pkg = readPkg(file);
      const [key, value] = args[1] === 'set' ? args[2].split('=') : [args[2], undefined];
      const [section, ...rest] = key.split('.');
      const name = rest.join('.');
      if (args[1] === 'set') { pkg[section] ??= {}; pkg[section][name] = value; } else delete pkg[section]?.[name];
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
    }
    if (args[0] === 'install' && String(args[1]).startsWith('better-sqlite3')) {
      const pkg = path.join(opts.cwd, 'node_modules', 'better-sqlite3');
      fs.mkdirSync(path.join(pkg, 'build', 'Release'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '12.10.0' }));
      fs.writeFileSync(path.join(pkg, BINDING), '');
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

test('the heal records a receipt for each manifest field before it edits it', async (t) => {
  const { dir, file, ledger } = conflictTree(t);
  const seen = [];
  const { runner } = fakeNpm({ onPkg: () => seen.push(readInstallEdits({ ledger }).edits.length) });
  const result = await ensureNativeBsq3(dir, { runner, ledger, now: () => 1_000 });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [1], 'the receipt exists before `npm pkg set` runs');
  assert.deepEqual(readInstallEdits({ ledger }).edits, [{
    file, section: 'optionalDependencies', name: 'better-sqlite3', from: '^12.9.0', to: '^12.10.0', at: 1_000,
  }]);
  assert.equal(readPkg(file).optionalDependencies['better-sqlite3'], '^12.10.0');
});

test('a later edit of a field ak already changed keeps the original value to restore', async (t) => {
  const { dir, file, ledger } = conflictTree(t);
  await ensureNativeBsq3(dir, { runner: fakeNpm().runner, ledger, now: () => 1_000 });
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  const pkg = readPkg(file);
  pkg.overrides['better-sqlite3'] = '^12.11.0';
  fs.writeFileSync(file, JSON.stringify(pkg));
  await ensureNativeBsq3(dir, { runner: fakeNpm().runner, ledger, now: () => 2_000 });
  const [edit] = readInstallEdits({ ledger }).edits;
  assert.equal(edit.from, '^12.9.0', 'the pre-ak value survives a second edit');
  assert.equal(edit.to, '^12.11.0');
  assert.equal(edit.at, 2_000);
});

test('an edit is applied only while the manifest still holds ak\'s value', async (t) => {
  const { dir, file, ledger } = conflictTree(t);
  await ensureNativeBsq3(dir, { runner: fakeNpm().runner, ledger, now: () => 1_000 });
  assert.deepEqual(installEditStatus({ ledger }).map((e) => e.state), ['applied']);
  fs.writeFileSync(file, JSON.stringify({ name: '@claude-flow/cli', optionalDependencies: { 'better-sqlite3': '^12.9.0' } }));
  assert.deepEqual(installEditStatus({ ledger }).map((e) => e.state), ['superseded'], 'a Ruflo reinstall replaced the file');
  fs.rmSync(file);
  assert.deepEqual(installEditStatus({ ledger }).map((e) => e.state), ['superseded'], 'a removed package is superseded too');
});

test('status names the edit, cites ruvnet/ruflo#2219 and says uninstall restores it', async (t) => {
  const { root, dir, ledger } = conflictTree(t);
  await ensureNativeBsq3(dir, { runner: fakeNpm().runner, ledger, now: () => 1_000 });
  const rows = installEditRows(installEditStatus({ ledger }), { rufloRoot: path.join(root, 'ruflo') });
  assert.equal(rows.length, 1);
  const [applied] = rows;
  assert.equal(applied.subsystem, 'natives');
  assert.equal(applied.level, 'info');
  assert.equal(applied.fix, null);
  assert.match(applied.message, /^ak applied Ruflo's native SQLite pin \(ruvnet\/ruflo#2219\)/);
  assert.match(applied.message, /@claude-flow\/cli package\.json optionalDependencies better-sqlite3 \^12\.9\.0 → \^12\.10\.0/);
  assert.match(applied.message, /ak uninstall/);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const [gone] = installEditRows(installEditStatus({ ledger }), { rufloRoot: path.join(root, 'ruflo') });
  assert.equal(gone.level, 'info');
  assert.match(gone.message, /no longer/);
  assert.match(gone.message, /nothing to restore/);
});

test('uninstall restores only values that still equal ak\'s, and forgets the rest', async (t) => {
  const { dir, file, ledger } = conflictTree(t);
  await ensureNativeBsq3(dir, { runner: fakeNpm().runner, ledger, now: () => 1_000 });
  const other = path.join(path.dirname(dir), 'memory');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ optionalDependencies: { 'better-sqlite3': '^12.11.1' } }));
  const edits = readInstallEdits({ ledger }).edits;
  edits.push({ file: path.join(other, 'package.json'), section: 'optionalDependencies', name: 'better-sqlite3', from: '^11.8.1', to: '^12.10.0', at: 1_000 });
  fs.writeFileSync(ledger, JSON.stringify({ version: 1, edits }));
  const { runner, calls } = fakeNpm();
  const result = await restoreInstallEdits({ ledger, runner });
  assert.equal(result.ok, true);
  assert.equal(readPkg(file).optionalDependencies['better-sqlite3'], '^12.9.0', 'ak\'s value put back to the original');
  assert.equal(readPkg(path.join(other, 'package.json')).optionalDependencies['better-sqlite3'], '^12.11.1', 'a changed value is left alone');
  assert.deepEqual(calls.filter((c) => c.args[0] === 'pkg').map((c) => [c.cwd, c.args.join(' ')]),
    [[dir, 'pkg set optionalDependencies.better-sqlite3=^12.9.0']]);
  assert.equal(fs.existsSync(ledger), false, 'nothing left to remember');
  assert.ok(result.lines.some((l) => l.level === 'ok' && /restored/.test(l.text)));
  assert.ok(result.lines.some((l) => l.level === 'info' && /left as it is/.test(l.text)));
});

test('a restore that does not take keeps its receipt and fails the uninstall', async (t) => {
  const { dir, ledger } = conflictTree(t);
  await ensureNativeBsq3(dir, { runner: fakeNpm().runner, ledger, now: () => 1_000 });
  const result = await restoreInstallEdits({ ledger, runner: fakeNpm({ failPkg: true }).runner });
  assert.equal(result.ok, false);
  assert.equal(readInstallEdits({ ledger }).edits.length, 1, 'the receipt is kept for the next attempt');
  assert.ok(result.lines.some((l) => l.level === 'warn' && /could not restore/.test(l.text)));
});

test('the uninstall step runs before global packages, and a dry run changes nothing', async (t) => {
  const ids = UNINSTALL_STEPS.map((step) => step.id);
  assert.ok(ids.includes('install-edits'));
  assert.ok(ids.indexOf('install-edits') < ids.indexOf('global-packages'), 'restore before ruflo may be removed');
  const { dir, file, ledger } = conflictTree(t);
  await ensureNativeBsq3(dir, { runner: fakeNpm().runner, ledger, now: () => 1_000 });
  const before = fs.readFileSync(file, 'utf8');
  const { runner, calls } = fakeNpm();
  const step = UNINSTALL_STEPS.find((candidate) => candidate.id === 'install-edits');
  const ctx = { dry: true, flags: {}, deps: { installEdits: { ledger, runner } }, state: { ownershipTeardownOk: true } };
  await step.run(ctx);
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(readInstallEdits({ ledger }).edits.length, 1);
  await step.run({ ...ctx, dry: false });
  assert.equal(readPkg(file).optionalDependencies['better-sqlite3'], '^12.9.0');
  assert.equal(ctx.state.ownershipTeardownOk, true);
});

test('every heal re-checks receipts first and forgets the ones a Ruflo upgrade superseded', async (t) => {
  const { root, dir, file, ledger } = conflictTree(t);
  await ensureNativeBsq3(dir, { runner: fakeNpm().runner, ledger, now: () => 1_000 });
  fs.writeFileSync(file, JSON.stringify({ name: '@claude-flow/cli', optionalDependencies: { 'better-sqlite3': '^12.11.0' } }));
  const bare = path.join(root, 'global');
  fs.mkdirSync(path.join(bare, 'ruflo', 'node_modules'), { recursive: true });
  _setGlobalRootForTest(bare);
  t.after(() => _setGlobalRootForTest(null));
  await healNatives({ runner: async () => ({ code: 0, stdout: '', stderr: '' }), ledger });
  assert.deepEqual(readInstallEdits({ ledger }).edits, [], 'a superseded receipt is dropped');
  assert.equal(fs.existsSync(ledger), false);
});
