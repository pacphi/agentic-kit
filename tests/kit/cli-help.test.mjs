// CLI help + dispatch — spawns the real bin. The load-bearing guarantee here
// is that `--help` is intercepted BEFORE run(), so mutating commands
// (setup, sync, uninstall) never fire on `ak <cmd> --help`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnEnv, sandboxProject, rmrf } from './helpers/home-sandbox.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');
// A throwaway home: `--help` must never reach the developer's real config or state.
const HOME = sandboxProject('ak-cli-help');
after(() => rmrf(HOME));
const ak = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: spawnEnv(HOME, { NO_COLOR: '1' }) });

test('setup --help shows help and does NOT run setup', () => {
  const r = ak('setup', '--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ak setup — /);
  assert.match(r.stdout, /Options:/);
  assert.match(r.stdout, /ruflo init --full --force/);
  assert.match(r.stdout, /docs\/SETUP\.md/);
  assert.match(r.stdout, /--with-deja-vu/);
  assert.match(r.stdout, /--deja-vu-mode <m>/);
  // A real setup run would emit ✓/⚠ progress lines, never the help header.
  assert.doesNotMatch(r.stdout, /installing|✓ /);
});

test('mutating commands intercept both --help and -h before running', () => {
  for (const cmd of ['setup', 'sync', 'uninstall']) {
    for (const flag of ['--help', '-h']) {
      const r = ak(cmd, flag);
      assert.equal(r.status, 0, `${cmd} ${flag} exit`);
      assert.match(r.stdout, new RegExp(`^ak ${cmd} — `), `${cmd} ${flag} header`);
    }
  }
});

test('every command exposes an Examples section in its help', () => {
  for (const cmd of [['setup'], ['status'], ['sync'], ['usage'], ['run'], ['dashboard'], ['uninstall'],
    ['host'], ['x', 'mcp'], ['x', 'host'],
    ['x', 'reference'], ['x', 'daemon-gc'], ['x', 'aqe-store']]) {
    const r = ak(...cmd, '--help');
    assert.equal(r.status, 0, `${cmd.join(' ')} exit`);
    assert.match(r.stdout, /Examples:/, `${cmd.join(' ')} examples`);
  }
});

test('ak x / ak x --help print the plumbing index', () => {
  for (const args of [['x'], ['x', '--help'], ['x', '-h']]) {
    const r = ak(...args);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Plumbing \(power users\)/);
  }
});

test('--version prints a semver-ish string', () => {
  const r = ak('--version');
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('unknown command exits 2 and prints top-level help', () => {
  const r = ak('bogus');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /unknown command: bogus/);
});

test('unknown plumbing command exits 2 and prints the plumbing index', () => {
  const r = ak('x', 'bogus');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /unknown plumbing command: bogus/);
});

test('ak x verify is gone: the generic unknown plumbing command error, and no help line', () => {
  const generic = ak('x', 'bogus').stdout;
  for (const args of [['x', 'verify'], ['x', 'verify', 'security'], ['x', 'verify', '--help']]) {
    const r = ak(...args);
    assert.equal(r.status, 2, `${args.join(' ')} exit`);
    assert.match(r.stdout, /^✗ unknown plumbing command: verify$/m);
    assert.equal(r.stdout.replace('command: verify', 'command: bogus'), generic,
      'exactly the error any unknown name gets: no alias, no hint');
  }
  assert.doesNotMatch(ak('--help', '--all').stdout, /\bx verify\b/);
});

test('removed dual/provider commands exit 2 and are omitted from help', () => {
  for (const args of [['dual'], ['provider'], ['x', 'provider']]) {
    const r = ak(...args);
    assert.equal(r.status, 2, `${args.join(' ')} exit`);
    assert.match(r.stdout, args[0] === 'x' ? /unknown plumbing command: provider/ : /unknown command:/);
  }
  const top = ak('--help');
  assert.doesNotMatch(top.stdout, /^\s+ak (?:dual|provider)\s+/m);
  const all = ak('--help', '--all');
  assert.doesNotMatch(all.stdout, /^\s+ak x provider\s+/m);
});

// docs-10: the main help lists the same status and sync flags as README's
// command block.
test('ak --help lists status --refresh[=live|machine] and sync --skip/--json', () => {
  const top = ak('--help').stdout;
  const line = (cmd) => top.split('\n').find((l) => new RegExp(`^\\s+ak ${cmd}\\s`).test(l)) ?? '';
  assert.match(line('status'), /\[--json\] \[--refresh\[=live\|machine\]\]/);
  assert.doesNotMatch(line('status'), /--live|--deep/);
  assert.match(line('sync'), /--skip SUBSYSTEM/);
  assert.match(line('sync'), /--json/);
});

test('ak status --help documents the three refresh strengths, their stages and the exit rule', () => {
  const r = ak('status', '--help');
  assert.equal(r.status, 0);
  for (const text of ['--refresh[=live|machine]', '--refresh=live', '--refresh=machine', '--project-trees',
    'Measuring the machine', 'Refreshing Maintenance evidence', 'Rebuilding the inventory', 'Running live checks',
    'Re-checking local evidence and versions']) {
    assert.ok(r.stdout.includes(text), `status help names ${text}`);
  }
  assert.match(r.stdout, /exit code (?:is )?1/);
  assert.match(r.stdout.replace(/\s+/g, ' '), /with --refresh the JSON also lists each stage under "refresh", no stage lines print/,
    'the --json help says what a refresh prints under --json');
  assert.doesNotMatch(r.stdout, /--live\b|--deep\b|\bx verify\b/, 'only the current spellings');
});

test('ak status --help documents --only: every check and slow proof, and its exit rule', () => {
  const r = ak('status', '--help');
  assert.equal(r.status, 0);
  const flat = r.stdout.replace(/\s+/g, ' ');
  assert.match(flat, /--only CHECK/);
  for (const id of ['aqe-embedding', 'mcp', 'providers', 'security', 'deja-vu', 'memory', 'learning', 'harvest', 'aqe', 'memory-routes']) {
    assert.match(r.stdout, new RegExp(`^\\s+${id}\\s{2,}\\S`, 'm'), `status help describes the ${id} check`);
  }
  assert.match(flat, /deja-vu content-free structural proof/);
  assert.match(flat, /slow proofs run only when named/i);
  assert.match(flat, /with --only, only the named checks decide the exit code: 1 when one failed, was inconclusive or did not run/i);
  assert.match(flat, /rows and stage failures still print and appear in --json/i);
});
