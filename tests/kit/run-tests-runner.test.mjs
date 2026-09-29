// tests/kit/run-tests-runner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.mjs';
import { spawnEnv } from './helpers/home-sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-tests.mjs');

function sandbox(t) {
  const home = tempDir('ak-runner', t);
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const env = spawnEnv(home, { APPDATA: path.join(home, 'AppData', 'Roaming'), CI: 'true' });
  delete env.AK_TRIPWIRE_STRICT;
  return { home, repo, env };
}

const stub = (dir, name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };

test('a command that writes real state fails the run and the path is named', (t) => {
  const { home, repo, env } = sandbox(t);
  const leak = stub(home, 'leak.mjs', `import fs from 'node:fs'; import path from 'node:path';
    const d = path.join(process.env.XDG_STATE_HOME, 'agentic-kit', 'maintenance');
    fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'latest-scan.json'), '{}');`);
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', leak], { env, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /real-state tripwire: watching \d+ roots \(strict\)/);
  // The report prints native absolute paths: backslashes on Windows.
  assert.match(r.stderr, /[\\/]maintenance[\\/]latest-scan\.json/);
});

test('a write into the repository .claude fails the run', (t) => {
  const { home, repo, env } = sandbox(t);
  const leak = stub(home, 'leak-repo.mjs', `import fs from 'node:fs'; import path from 'node:path';
    fs.mkdirSync(path.join(process.argv[2], '.claude', 'helpers'), { recursive: true });
    fs.writeFileSync(path.join(process.argv[2], '.claude', 'helpers', 'statusline.cjs'), '9.9.9');`);
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', leak, repo], { env, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /statusline\.cjs/);
});

test('a failing test command keeps its exit code and the tripwire still reports', (t) => {
  const { home, repo, env } = sandbox(t);
  const both = stub(home, 'both.mjs', `import fs from 'node:fs'; import path from 'node:path';
    fs.mkdirSync(path.join(process.env.XDG_CONFIG_HOME, 'agentic-kit'), { recursive: true });
    fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME, 'agentic-kit', 'kit.json'), '{}');
    process.exit(7);`);
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', both], { env, encoding: 'utf8' });
  assert.equal(r.status, 7);
  assert.match(r.stderr, /kit\.json/);
});

test('a clean command passes; concurrent-writer churn does not fail a developer run', (t) => {
  const { home, repo, env } = sandbox(t);
  delete env.CI;
  // The folder exists on any machine with a live statusline; creating it would be a real leak.
  fs.mkdirSync(path.join(home, '.config', 'agentic-kit'), { recursive: true });
  const tee = stub(home, 'tee.mjs', `import fs from 'node:fs'; import path from 'node:path';
    const d = path.join(process.env.XDG_CONFIG_HOME, 'agentic-kit');
    fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'claude-rate-limits.json'), '{}');`);
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', tee], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /concurrent writers \(not failing\)/);
});

test('SUITES keeps the exact commands package.json ran before', async () => {
  const { SUITES } = await import('../../scripts/run-tests.mjs');
  assert.deepEqual(SUITES.unit[0], ['--test', '--experimental-test-coverage', '--test-coverage-lines=70',
    '--test-coverage-branches=70', '--test-coverage-functions=70', 'tests/kit/*.test.mjs']);
  assert.deepEqual(SUITES.unit.slice(1).map((a) => a[0]), ['statusline-segments', 'statusline-window-ledger',
    'statusline-brain', 'health-history', 'dashboard', 'admin-model', 'admin'].map((f) => `tests/${f}.test.cjs`));
  assert.equal(SUITES.ui[0][0], 'tests/ui/dashboard-ui.mjs');
  assert.deepEqual(SUITES.ui[1], ['--test', 'tests/ui/dashboard-project-context.mjs', 'tests/ui/maintenance-projects.mjs',
    'tests/ui/maintenance-host-alignment.mjs', 'tests/ui/intelligence-picker.mjs', 'tests/ui/usage-project-groups.mjs',
    'tests/ui/context-coverage.mjs', 'tests/ui/host-readiness.mjs', 'tests/ui/maintenance-focus.mjs',
    'tests/ui/maintenance-guidance.mjs']);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs unit');
  assert.equal(pkg.scripts['test:ui'], 'node scripts/run-tests.mjs ui');
});

test('coverage is enabled by default for the complete unit suite', async () => {
  const { commandsFor, SUITES } = await import('../../scripts/run-tests.mjs');
  assert.deepEqual(commandsFor('unit', {}), SUITES.unit);
});

test('the explicit CI opt-out removes coverage flags but keeps every test command', async () => {
  const { commandsFor, SUITES } = await import('../../scripts/run-tests.mjs');
  const commands = commandsFor('unit', { AK_TEST_COVERAGE: '0' });
  assert.deepEqual(commands[0], ['--test', 'tests/kit/*.test.mjs']);
  assert.deepEqual(commands.slice(1), SUITES.unit.slice(1));
});

test('an unrecognized coverage value retains the coverage gate', async () => {
  const { commandsFor, SUITES } = await import('../../scripts/run-tests.mjs');
  assert.deepEqual(commandsFor('unit', { AK_TEST_COVERAGE: 'false' }), SUITES.unit);
});

test('a leftover temp folder fails the run and is named', (t) => {
  const { home, repo, env } = sandbox(t);
  const leaky = stub(home, 'leaky.mjs', `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    fs.mkdtempSync(path.join(os.tmpdir(), 'ak-leaky-'));`);
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', leaky], { env, encoding: 'utf8' });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /ak-leaky-/);
});

test('the runner refuses a temp root inside a git repository', (t) => {
  const { home, repo, env } = sandbox(t);
  const inside = path.join(repo, 'tmp');
  fs.mkdirSync(inside);
  const ok = stub(home, 'ok.mjs', '');
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', ok], { env: { ...env, TMPDIR: inside, TEMP: inside, TMP: inside }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /inside the git repository/);
});

// Tests assert on plain text. A developer shell's FORCE_COLOR (Claude Code sets
// FORCE_COLOR=3) colours console.log even into a pipe and, with NO_COLOR, makes
// Node print a warning into captured output; the suite runs without it.
test('the suite runs without the shell FORCE_COLOR', (t) => {
  const { home, repo, env } = sandbox(t);
  const probe = stub(home, 'colour.mjs', `process.exit(process.env.FORCE_COLOR === undefined ? 0 : 7);`);
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', probe], { env: { ...env, FORCE_COLOR: '3' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('home temp base is refused before creating a run root', (t) => {
  const { home, repo, env } = sandbox(t);
  const before = fs.readdirSync(home);
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', '-e', ''], {
    env: { ...env, TMPDIR: home, TMP: home, TEMP: home }, encoding: 'utf8',
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unsafe temp base/);
  assert.deepEqual(fs.readdirSync(home), before);
});

test('completed runners retain sibling roots and ignore their own owner metadata', async (t) => {
  const { ownerRecord, writeOwner } = await import('../../scripts/run-roots.mjs');
  const { home, repo, env } = sandbox(t);
  const parent = env.TMPDIR;
  const sibling = fs.mkdtempSync(path.join(parent, 'ak-suite-'));
  writeOwner(sibling, ownerRecord({ pid: process.pid }));
  fs.writeFileSync(path.join(sibling, 'sentinel'), 'preserve');
  for (const exit of [0, 7]) {
    const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', '-e', `process.exit(${exit})`], { env, encoding: 'utf8' });
    assert.equal(r.status, exit, r.stderr);
    assert.match(r.stderr, /kept run root.*cannot prove complete descendant exit/);
    assert.doesNotMatch(r.stderr, /temp folders left behind/);
    assert.equal(fs.readFileSync(path.join(sibling, 'sentinel'), 'utf8'), 'preserve');
    assert.deepEqual(fs.readdirSync(parent), [path.basename(sibling)]);
  }
  assert.ok(home);
});

test('a reaped owner does not authorize sibling deletion after a completed run', async (t) => {
  const { ownerRecord, writeOwner } = await import('../../scripts/run-roots.mjs');
  const { repo, env } = sandbox(t);
  const startedAt = Date.now();
  const child = spawnSync(process.execPath, ['-e', ''], { env });
  assert.equal(child.status, 0);
  const sibling = fs.mkdtempSync(path.join(env.TMPDIR, 'ak-suite-'));
  writeOwner(sibling, ownerRecord({ pid: child.pid, now: startedAt }));
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', '-e', ''], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /cannot prove complete descendant exit/);
  assert.ok(fs.existsSync(sibling));
});

test('a signalled command retains its run root and performs no sibling collection', (t) => {
  const { repo, env } = sandbox(t);
  const sibling = fs.mkdtempSync(path.join(env.TMPDIR, 'ak-suite-'));
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', '-e',
    "process.kill(process.pid, 'SIGTERM')"], { env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /interrupted run/);
  assert.doesNotMatch(r.stderr, /^kept run root/m);
  assert.equal(fs.readdirSync(env.TMPDIR).length, 2);
  assert.ok(fs.existsSync(sibling));
});

// Inject failures only at this subprocess's disposable temp boundary.
function cleanupProbe(home) {
  return stub(home, 'cleanup-errors.mjs', `import fs from 'node:fs';
    import os from 'node:os'; import path from 'node:path';
    import { runGuarded } from ${JSON.stringify(new URL('../../scripts/run-tests.mjs', import.meta.url).href)};
    const [repo, mode, code, tripwire] = process.argv.slice(2);
    const parent = fs.realpathSync(os.tmpdir());
    const own = (p) => path.dirname(String(p)) === parent && /^ak-suite-[A-Za-z0-9]{6}$/.test(path.basename(String(p)));
    const readdir = fs.readdirSync, remove = fs.rmSync, lstat = fs.lstatSync;
    fs.readdirSync = (p, ...args) => {
      if ((mode === 'inspection' && own(p)) || (mode === 'sibling' && p === parent)) throw Error('EACCES');
      return readdir(p, ...args);
    };
    fs.rmSync = (p, ...args) => {
      if (mode === 'removal' && own(p)) throw Error('EBUSY');
      return remove(p, ...args);
    };
    let ownStats = 0;
    fs.lstatSync = (p, ...args) => {
      const stat = lstat(p, ...args);
      if (own(p)) {
        ownStats++;
        if (mode === 'refusal' && ownStats >= 3) stat.isDirectory = () => false;
        if (mode === 'identity' && ownStats >= 4) stat.birthtimeMs += 1;
      }
      return stat;
    };
    const child = "const fs=require('fs'),path=require('path'),os=require('os');"
      + (mode === 'inspection' ? "fs.writeFileSync(path.join(os.tmpdir(),'leftover'),'retain me');" : '')
      + (tripwire === 'yes' ? "fs.mkdirSync(path.join(process.env.XDG_CONFIG_HOME,'agentic-kit'),{recursive:true});fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME,'agentic-kit','kit.json'),'{}');" : '')
      + 'process.exit(' + code + ')';
    process.exitCode = runGuarded([['-e', child]], { repoRoot: repo });`);
}

for (const mode of ['inspection', 'removal', 'refusal', 'identity']) {
  test(`own-root ${mode} failure fails hygiene and retains command/tripwire precedence`, (t) => {
    for (const [commandCode, tripwire, expected] of [[0, 'no', 4], [7, 'no', 7], [0, 'yes', 3]]) {
      const { home, repo, env } = sandbox(t);
      const r = spawnSync(process.execPath, [cleanupProbe(home), repo, mode, String(commandCode), tripwire], { env, encoding: 'utf8' });
      assert.equal(r.status, expected, r.stderr);
      const roots = fs.readdirSync(env.TMPDIR).filter((name) => /^ak-suite-[A-Za-z0-9]{6}$/.test(name));
      assert.equal(roots.length, 1, r.stderr);
      if (mode === 'inspection') {
        assert.match(r.stderr, /could not list own run root/);
        assert.equal(fs.readFileSync(path.join(env.TMPDIR, roots[0], 'leftover'), 'utf8'), 'retain me');
      } else if (mode === 'removal') assert.match(r.stderr, /may be partially removed/);
      else assert.match(r.stderr, /kept own run root/);
    }
  });
}

test('sibling listing failure stays nonfatal and does not mask command failure', (t) => {
  for (const code of [0, 7]) {
    const { home, repo, env } = sandbox(t);
    const r = spawnSync(process.execPath, [cleanupProbe(home), repo, 'sibling', String(code), 'no'], { env, encoding: 'utf8' });
    assert.equal(r.status, code, r.stderr);
    assert.match(r.stderr, /could not list run roots/);
    assert.deepEqual(fs.readdirSync(env.TMPDIR), []);
  }
});
