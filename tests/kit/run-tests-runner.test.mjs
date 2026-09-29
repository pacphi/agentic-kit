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
  // Nested CLI fixtures must run as independent test processes.
  delete env.NODE_TEST_CONTEXT;
  return { home, repo, env };
}

const stub = (dir, name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };

async function pidGone(pid, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test('focus runs a literal clean test file through the guarded root', (t) => {
  const { home, env } = sandbox(t);
  const file = stub(home, 'clean.test.mjs', "import { test } from 'node:test'; test('clean', () => {});");
  const before = fs.readdirSync(env.TMPDIR);
  const r = spawnSync(process.execPath, [RUNNER, 'focus', file], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /real-state tripwire: watching/);
  assert.match(r.stderr, /removed own run root /);
  assert.deepEqual(fs.readdirSync(env.TMPDIR), before);
});

test('focus reports a leaked temp folder with hygiene exit code', (t) => {
  const { home, env } = sandbox(t);
  const file = stub(home, 'leaky.test.mjs', `import { test } from 'node:test';
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    test('leak', () => { fs.mkdtempSync(path.join(os.tmpdir(), 'focus-leak-')); });`);
  const r = spawnSync(process.execPath, [RUNNER, 'focus', file], { env, encoding: 'utf8' });
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stderr, /temp folders left behind.*focus-leak-/s);
});

test('an unresolved prelaunch hold retains the guarded root and sentinel after test failure', async (t) => {
  const { home, repo, env } = sandbox(t);
  const pidFile = path.join(home, 'held-child-pid');
  const child = stub(home, 'held-child.cjs', `const fs = require('node:fs');
    const release = process.argv[2];
    fs.writeFileSync(require('node:path').join(process.cwd(), 'held-child-ready'), 'ready');
    const timer = setInterval(() => { if (fs.existsSync(release)) { clearInterval(timer); process.exit(0); } }, 20);
    setTimeout(() => process.exit(2), 10000);`);
  const script = stub(home, 'unresolved-hold.mjs', `import fs from 'node:fs';
    import path from 'node:path'; import { spawn } from 'node:child_process';
    import { acquireRunRootHold } from ${JSON.stringify(new URL('../../scripts/run-roots.mjs', import.meta.url).href)};
    acquireRunRootHold();
    const root = process.env.AK_SUITE_ROOT;
    fs.writeFileSync(path.join(root, 'held-sentinel'), 'keep');
    const child = spawn(process.execPath, [${JSON.stringify(child)}, path.join(root, 'release-child')],
      { cwd: root, stdio: 'ignore', detached: true });
    child.once('error', (error) => { throw error; });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    child.unref();
    const ready = path.join(root, 'held-child-ready');
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!fs.existsSync(ready)) throw Error('fixture child did not become ready');
    process.exit(7);`);
  let root;
  let pid;
  try {
    const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', script], { env, encoding: 'utf8' });
    const roots = fs.readdirSync(env.TMPDIR).filter((name) => /^ak-suite-[A-Za-z0-9]{6}$/.test(name));
    if (roots.length === 1) root = path.join(env.TMPDIR, roots[0]);
    if (fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(r.status, 7, r.stdout + r.stderr);
    assert.match(r.stderr, /kept own run root .*unresolved child hold/);
    assert.equal(roots.length, 1, r.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'held-sentinel'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(root, 'held-child-ready'), 'utf8'), 'ready');
    assert.doesNotThrow(() => process.kill(pid, 0), 'the held child should still own the retained cwd');
  } finally {
    if (root) fs.writeFileSync(path.join(root, 'release-child'), 'release');
    if (Number.isInteger(pid) && pid > 0) {
      if (!root) { try { process.kill(pid); } catch { /* already exited */ } }
      if (!await pidGone(pid)) { try { process.kill(pid); } catch { /* already exited */ } }
      assert.ok(await pidGone(pid), `fixture child ${pid} did not exit`);
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unresolved holds preserve command, tripwire, then hygiene exit priority', (t) => {
  for (const [mode, expected] of [['command', 7], ['tripwire', 3], ['hygiene', 4]]) {
    const { home, repo, env } = sandbox(t);
    const script = stub(home, `${mode}-hold.mjs`, `import fs from 'node:fs'; import path from 'node:path';
      import { acquireRunRootHold } from ${JSON.stringify(new URL('../../scripts/run-roots.mjs', import.meta.url).href)};
      acquireRunRootHold();
      if (process.env.HOLD_MODE === 'tripwire') {
        const file = path.join(process.env.XDG_CONFIG_HOME, 'agentic-kit', 'kit.json');
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}');
      }
      if (process.env.HOLD_MODE === 'command') process.exit(7);`);
    let root;
    try {
      const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', script], {
        env: { ...env, HOLD_MODE: mode }, encoding: 'utf8',
      });
      const roots = fs.readdirSync(env.TMPDIR).filter((name) => /^ak-suite-[A-Za-z0-9]{6}$/.test(name));
      if (roots.length === 1) root = path.join(env.TMPDIR, roots[0]);
      assert.equal(r.status, expected, r.stdout + r.stderr);
      assert.match(r.stderr, /kept own run root .*unresolved child hold/);
      assert.equal(roots.length, 1);
    } finally { if (root) fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('focus rejects missing files and option-shaped filenames before creating roots', (t) => {
  const { env } = sandbox(t);
  const before = fs.readdirSync(env.TMPDIR);
  for (const args of [[], ['--test-reporter=dot'], ['does-not-exist.test.mjs']]) {
    const r = spawnSync(process.execPath, [RUNNER, 'focus', ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /usage: run-tests\.mjs focus/);
    assert.deepEqual(fs.readdirSync(env.TMPDIR), before);
  }
});

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

test('guarded runner preserves tool selectors while scrubbing FORCE_COLOR', (t) => {
  const { home, repo, env } = sandbox(t);
  const probe = stub(home, 'selectors.mjs', `
    import assert from 'node:assert/strict';
    assert.equal(process.env.AQE_EMBEDDER_PROVIDER, 'sentinel-provider');
    assert.equal(process.env.AQE_EMBEDDER_MODEL, 'sentinel-model');
    assert.equal(process.env.FORCE_COLOR, undefined);
  `);
  const r = spawnSync(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', probe], {
    env: { ...env, AQE_EMBEDDER_PROVIDER: 'sentinel-provider', AQE_EMBEDDER_MODEL: 'sentinel-model', FORCE_COLOR: '3' },
    encoding: 'utf8',
  });
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
