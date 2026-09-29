import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.mjs';
import { spawnEnv } from './helpers/home-sandbox.mjs';

const runner = fileURLToPath(new URL('../../scripts/run-tests.mjs', import.meta.url));
const sandbox = new URL('./helpers/home-sandbox.mjs', import.meta.url).href;
const helper = new URL('./helpers/interruption-scope.mjs', import.meta.url).href;

test('real test timeout closes owned runner and orphan before cwd removal and releases the outer hold', t => {
  const home = tempDir('ak-cancel-check', t);
  const evidence = path.join(home, 'evidence.json');
  const fixture = path.join(home, 'cancel.test.mjs');
  fs.writeFileSync(fixture, `
    import { test, after } from 'node:test';
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    import { spawnEnv } from ${JSON.stringify(sandbox)};
    import { interruptionScope, childGone, until } from ${JSON.stringify(helper)};
    let scope, child, closed = false, removed = false;
    test('intentional cancellation', { timeout: 500 }, async t => {
      scope = interruptionScope(t, { beforeRemove(home) {
        assert.equal(closed, true, 'close must precede cwd removal');
        assert.equal(childGone(child.pid), true, 'OS must report ESRCH before removal');
        assert.equal(fs.existsSync(home), true);
        const orphan = JSON.parse(fs.readFileSync(home + '/ready', 'utf8'));
        assert.equal(childGone(orphan.pid), true, 'orphan must also have native ESRCH before removal');
        fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ pid: child.pid, orphanPid: orphan.pid, closed, gone: childGone(child.pid), home }));
        removed = true;
      }});
      fs.writeFileSync(scope.home + '/hold.mjs', \`
        import fs from 'node:fs';
        fs.writeFileSync(process.argv[2] + '.tmp', JSON.stringify({ pid: process.pid }));
        fs.renameSync(process.argv[2] + '.tmp', process.argv[2]);
        setInterval(() => { if (fs.existsSync(process.argv[3])) process.exit(0); }, 25);
        setTimeout(() => process.exit(8), 10000);
      \`);
      const env = spawnEnv(scope.home);
      delete env.NODE_TEST_CONTEXT;
      child = scope.launch(() => spawn(process.execPath, [${JSON.stringify(runner)}, 'exec', '--repo', scope.home, '--', scope.home + '/hold.mjs', scope.home + '/ready', scope.home + '/stop'], { env, stdio: 'ignore' }),
        { handshake: scope.home + '/ready', stop: scope.home + '/stop' });
      child.once('close', () => { closed = true; });
      try {
        await until(() => fs.existsSync(scope.home + '/ready'), 'orphan readiness', 5000, t.signal);
        child.kill('SIGTERM');
        await until(() => closed, 'runner close', 5000, t.signal);
        await new Promise(resolve => t.signal.addEventListener('abort', resolve, { once: true }));
      }
      finally {
        await scope.cleanup();
        let attempted = false;
        assert.throws(() => scope.launch(() => { attempted = true; return child; }));
        assert.equal(attempted, false, 'cancellation must block the launch callback');
      }
    });
    after(() => {
      assert.equal(removed, true);
      assert.equal(fs.existsSync(scope.home), false);
    });
  `);
  const env = spawnEnv(home, { CI: 'true' });
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [runner, 'exec', '--repo', home, '--', '--test', fixture], {
    env, encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /test timed out after 500ms/);
  const proof = JSON.parse(fs.readFileSync(evidence, 'utf8'));
  assert.equal(proof.closed, true);
  assert.equal(proof.gone, true);
  assert.equal(fs.existsSync(proof.home), false);
  assert.throws(() => process.kill(proof.pid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(proof.orphanPid, 0), { code: 'ESRCH' });
  assert.deepEqual(fs.readdirSync(env.TMPDIR), [], 'guarded timeout has no unresolved hold or fixture leftovers');
});

test('uncertain fixture identity retains its local directory and enclosing guarded root', t => {
  const home = tempDir('ak-cancel-retain-check', t);
  const evidence = path.join(home, 'evidence.json');
  const fixture = path.join(home, 'uncertain.test.mjs');
  fs.writeFileSync(fixture, `
    import { test } from 'node:test';
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    import { interruptionScope } from ${JSON.stringify(helper)};
    test('intentional missing child identity', async t => {
      const scope = interruptionScope(t);
      const child = scope.launch(() => spawn(process.execPath, ['-e', 'process.exit(0)'], { cwd: scope.home, stdio: 'ignore' }),
        { handshake: scope.home + '/missing-handshake', stop: scope.home + '/stop' });
      await new Promise(resolve => child.once('close', resolve));
      fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ pid: child.pid, home: scope.home, root: process.env.AK_SUITE_ROOT }));
      await scope.cleanup();
    });
  `);
  const env = spawnEnv(home, { CI: 'true' });
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [runner, 'exec', '--repo', home, '--', '--test', fixture], { env, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /owned process exit uncertain/);
  assert.match(result.stderr, /unresolved child hold/);
  const proof = JSON.parse(fs.readFileSync(evidence, 'utf8'));
  assert.throws(() => process.kill(proof.pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(proof.home), true);
  assert.equal(fs.existsSync(proof.root), true);
  assert.equal(fs.readdirSync(path.join(proof.root, '.ak-suite-holds')).length, 1);
  // This enclosing test knows its exact fixture ran only process.exit(0), and
  // independently established ESRCH above; remove only that disposable root.
  fs.rmSync(proof.root, { recursive: true });
});
