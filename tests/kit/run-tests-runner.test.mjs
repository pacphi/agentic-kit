// tests/kit/run-tests-runner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnEnv } from './helpers/home-sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-tests.mjs');

function sandbox(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-runner-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
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
