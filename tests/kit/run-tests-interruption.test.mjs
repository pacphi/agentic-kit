import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { interruptionScope, childGone } from './helpers/interruption-scope.mjs';
import { spawnEnv } from './helpers/home-sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-tests.mjs');
const ownerFile = '.ak-suite-owner.json';

function roots(parent) {
  return fs.readdirSync(parent).filter((name) => /^ak-suite-[A-Za-z0-9]{6}$/.test(name)).sort();
}

function runnerFor(repo, script, handshake, stop, done, env, log) {
  const fd = fs.openSync(log, 'w');
  try {
    return spawn(process.execPath, [RUNNER, 'exec', '--repo', repo, '--', script, handshake, stop, done], {
      env, stdio: ['ignore', fd, fd],
    });
  } finally { fs.closeSync(fd); }
}

test('interrupted and live sibling roots stay listed, including after the orphan exits', {
  skip: process.platform === 'win32' && 'POSIX runner termination probe; Windows retains siblings by list-only policy',
  timeout: 20000,
}, async (t) => {
  const scope = interruptionScope(t);
  const { home, wait: until } = scope;
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const env = spawnEnv(home, { APPDATA: path.join(home, 'AppData', 'Roaming'), CI: 'true' });
  delete env.NODE_TEST_CONTEXT;
  const parent = env.TMPDIR;
  const baseline = fs.readdirSync(parent);
  const script = path.join(home, 'hold.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
    const [handshake, stop, done] = process.argv.slice(2);
    fs.writeFileSync(handshake + '.tmp', JSON.stringify({ pid: process.pid, cwd: process.cwd(), tmpdir: process.env.TMPDIR }));
    fs.renameSync(handshake + '.tmp', handshake);
    const timer = setInterval(() => {
      if (!fs.existsSync(stop)) return;
      const request = fs.readFileSync(stop, 'utf8');
      if (!fs.existsSync(done)) fs.writeFileSync(done, 'stopped');
      if (request === 'exit') { clearInterval(timer); process.exit(0); }
    }, 25);
    setTimeout(() => process.exit(8), 12000);`);
  const clean = path.join(home, 'clean.test.mjs');
  fs.writeFileSync(clean, "import { test } from 'node:test'; test('clean', () => {});");
  const first = ['first-handshake', 'first-stop', 'first-done'].map((name) => path.join(home, name));
  const live = ['live-handshake', 'live-stop', 'live-done'].map((name) => path.join(home, name));
  let runner1;
  let runner4;
  let interruptedRoot;
  try {
    runner1 = scope.launch(() => runnerFor(repo, script, ...first, env, path.join(home, 'run1.log')),
      { handshake: first[0], stop: first[1] });
    const firstData = await until(() => fs.existsSync(first[0]) && JSON.parse(fs.readFileSync(first[0], 'utf8')), 'first child handshake');
    const root1 = await until(() => roots(parent).map((name) => path.join(parent, name)).find((root) => {
      try { return JSON.parse(fs.readFileSync(path.join(root, ownerFile), 'utf8')).pid === runner1.pid; }
      catch { return false; }
    }), 'first owner record');
    interruptedRoot = root1;
    assert.equal(firstData.cwd, repo);
    assert.equal(firstData.tmpdir, root1);
    assert.ok(firstData.pid > 0);
    assert.equal(runner1.kill('SIGTERM'), true);
    await until(() => runner1.exitCode !== null || runner1.signalCode !== null, 'owned runner termination');
    assert.ok(fs.existsSync(root1));
    assert.equal(fs.existsSync(first[2]), false, 'orphan has not stopped');

    const runFocus = () => {
      scope.active();
      return spawnSync(process.execPath, [RUNNER, 'focus', clean], { env, encoding: 'utf8' });
    };
    const second = runFocus();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stderr, /kept run root.*cannot prove complete descendant exit \(list-only\)/);
    assert.deepEqual(roots(parent), [path.basename(root1)]);

    runner4 = scope.launch(() => runnerFor(repo, script, ...live, env, path.join(home, 'run4.log')),
      { handshake: live[0], stop: live[1] });
    const liveData = await until(() => fs.existsSync(live[0]) && JSON.parse(fs.readFileSync(live[0], 'utf8')), 'live child handshake');
    const root4 = await until(() => roots(parent).map((name) => path.join(parent, name)).find((root) => {
      try { return JSON.parse(fs.readFileSync(path.join(root, ownerFile), 'utf8')).pid === runner4.pid; }
      catch { return false; }
    }), 'live owner record');
    assert.equal(liveData.tmpdir, root4);
    fs.writeFileSync(first[1], 'stop');
    await until(() => fs.existsSync(first[2]), 'orphan private stop acknowledgement');
    assert.equal(childGone(firstData.pid), false, 'acknowledgement precedes child exit');
    fs.writeFileSync(first[1], 'exit');
    await until(() => childGone(firstData.pid), 'orphan PID absent after private exit request');
    assert.equal(childGone(liveData.pid), false, 'concurrent child remains alive');
    const third = runFocus();
    assert.equal(third.status, 0, third.stdout + third.stderr);
    assert.match(third.stderr, /kept run root.*cannot prove complete descendant exit \(list-only\)/);
    assert.deepEqual(roots(parent), [path.basename(root1), path.basename(root4)].sort());
    assert.ok(fs.existsSync(root1), 'known stopped child does not authorize sibling removal');
    assert.ok(fs.existsSync(root4), 'concurrently live sibling remains');
  } finally {
    await scope.cleanup();
  }
  if (t.signal.aborted) return;
  // Only this test's disposable fixture root is removed after its child stops.
  assert.deepEqual(roots(parent), [path.basename(interruptedRoot)]);
  fs.rmSync(interruptedRoot, { recursive: true });
  assert.deepEqual(fs.readdirSync(parent), baseline);
});
