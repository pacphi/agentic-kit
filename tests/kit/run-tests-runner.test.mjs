// tests/kit/run-tests-runner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-tests.mjs');

function sandbox(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-runner-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), CI: 'true' };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'AK_TRIPWIRE_STRICT']) delete env[key];
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
  assert.match(r.stderr, /latest-scan\.json/);
  assert.match(r.stderr, /maintenance\//);
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
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs unit');
  assert.equal(pkg.scripts['test:ui'], 'node scripts/run-tests.mjs ui');
});
