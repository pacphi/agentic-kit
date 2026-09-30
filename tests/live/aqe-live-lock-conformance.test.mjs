// Opt-in native contract for agentic-qe#574. No installed package is patched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProcessScope } from './aqe-live-lock-process.mjs';
import { digest, childEnv, snapshot } from './aqe-live-lock-fixtures.mjs';

const required = process.env.AK_AQE_LOCK_LIVE === '1';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function installedRoot() {
  if (process.env.AK_AQE_PACKAGE_ROOT) {
    assert.ok(path.isAbsolute(process.env.AK_AQE_PACKAGE_ROOT), 'package root must be absolute');
    return fs.realpathSync(process.env.AK_AQE_PACKAGE_ROOT);
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const bin = path.join(dir, 'aqe');
    if (dir && fs.existsSync(bin)) {
      const root = path.resolve(path.dirname(fs.realpathSync(bin)), '../..');
      if (fs.existsSync(path.join(root, 'package.json'))) return root;
    }
  }
  throw new Error('AQE missing: set AK_AQE_PACKAGE_ROOT to absolute installed package root');
}


async function bounded(scope, file, args, options, limit) {
  const run = scope.launch(process.execPath, [file, ...args], options);
  return scope.wait(run, limit);
}


function check(label, result, owner, before, store) {
  const output = result.stdout + result.stderr;
  assert.equal(result.timedOut, false, `${label} timed out`);
  assert.equal(result.code, 0, `${label} exited ${result.code}: ${output.slice(-1200)}`);
  assert.equal(owner.closed, false, `native holder closed during ${label}`);
  assert.equal(owner.child.exitCode, null, `native holder exited during ${label}`);
  assert.equal(owner.child.signalCode, null, `native holder signaled during ${label}`);
  assert.ifError(owner.error);
  assert.match(output, /is locked by a live process/, `${label} missed live-lock warning`);
  assert.match(output, /LockHeld|0x0300/, `${label} missed LockHeld fallback`);
  assert.doesNotMatch(output, /FsyncFailed|0x0303/, `${label} emitted FsyncFailed`);
  assert.deepEqual(snapshot(store), before, `${label} changed RVF bytes`);
  assert.ok(!fs.readdirSync(store).some((n) => n.includes('.corrupt-')), `${label} quarantined RVF`);
}

test('installed AQE degrades under a live native RVF lock without changing the store',
  { skip: !required && 'set AK_AQE_LOCK_LIVE=1 for native proof', timeout: 420_000 }, async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-live-lock-')));
    const scope = createProcessScope(t.signal);
    t.after(async () => {
      try {
        await scope.closeAll();
      } catch (error) {
        throw new Error(`owned child closure unverified; retained ${root}`, { cause: error });
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    });
    const project = path.join(root, 'project'); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'package.json'), '{"name":"aqe-live-lock-probe","version":"1.0.0","type":"module"}\n');
    const env = childEnv(root, project);
    const packageRoot = installedRoot();
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'agentic-qe');
    if (process.env.AK_AQE_EXPECTED_VERSION) assert.equal(pkg.version, process.env.AK_AQE_EXPECTED_VERSION);
    const entry = path.join(packageRoot, 'dist', 'cli', 'bundle.js');
    const adapter = path.join(packageRoot, 'dist', 'integrations', 'ruvector', 'shared-rvf-adapter.js');
    assert.ok(fs.existsSync(entry) && fs.existsSync(adapter), 'installed AQE CLI and adapter required');
    const sourceHashes = { entry: digest(entry), adapter: digest(adapter) };
    const options = { cwd: project, env };
    const init = await bounded(scope, entry, ['init', '--minimal', '--auto'], options, 150_000);
    assert.equal(init.timedOut, false);
    assert.equal(init.code, 0, `aqe init failed: ${(init.stdout + init.stderr).slice(-1200)}`);
    const store = path.join(project, '.agentic-qe');
    const ready = path.join(root, 'ready');
    const holderFile = path.join(root, 'holder.mjs');
    const moduleUrl = pathToFileURL(adapter).href;
    fs.writeFileSync(holderFile, `import { createRequire } from 'node:module'; import fs from 'node:fs';\nglobalThis.require=createRequire(${JSON.stringify(adapter)});\nconst {getSharedRvfAdapter}=await import(${JSON.stringify(moduleUrl)});\nglobalThis.hold=getSharedRvfAdapter(${JSON.stringify(store)},384);\nif(!globalThis.hold)process.exit(2);\nfs.writeFileSync(${JSON.stringify(ready)},String(process.pid));\nconst timer=setInterval(()=>{if(!globalThis.hold)process.exit(3)},1000);\nprocess.on('SIGTERM',()=>{clearInterval(timer);globalThis.hold.close();process.exit(0)});\n`);
    const owner = scope.launch(process.execPath, [holderFile], options);
    try {
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(ready) && !owner.closed && !owner.error && owner.child.exitCode === null
        && owner.child.signalCode === null && Date.now() < deadline) await pause(50);
      assert.ifError(owner.error);
      assert.ok(fs.existsSync(ready), 'holder did not signal ready');
      assert.equal(Number(fs.readFileSync(ready, 'utf8')), owner.child.pid, 'holder PID mismatch');
      assert.equal(owner.closed, false, 'holder closed after ready');
      assert.equal(owner.child.exitCode, null, 'holder exited after ready');
      assert.equal(owner.child.signalCode, null, 'holder signaled after ready');
      const before = snapshot(store);
      assert.ok(before['patterns.rvf'] && before['patterns.rvf.lock'], 'native RVF and lock required');
      const status = await bounded(scope, entry, ['status'], options, 150_000);
      check('aqe status', status, owner, before, store);
      const challengerFile = path.join(root, 'challenger.mjs');
      fs.writeFileSync(challengerFile, `import {createRequire} from 'node:module';\nglobalThis.require=createRequire(${JSON.stringify(adapter)});\nconst {getSharedRvfAdapter}=await import(${JSON.stringify(moduleUrl)});\nconst adapter=getSharedRvfAdapter(${JSON.stringify(store)},384);\nconsole.log(JSON.stringify({fallback:adapter===null}));\nif(adapter){adapter.close();process.exitCode=2}\n`);
      const challenger = await bounded(scope, challengerFile, [], options, 30_000);
      check('shipped adapter', challenger, owner, before, store);
      assert.match(challenger.stdout, /"fallback":true/, 'adapter did not fall back');
      console.log(JSON.stringify({ aqeVersion: pkg.version, platform: process.platform,
        node: process.version, sourceHashes, ownerPid: owner.child.pid,
        status: { exit: status.code, liveLock: true, lockHeld: true, fsyncFailed: false },
        adapter: { exit: challenger.code, fallback: true, liveLock: true, lockHeld: true, fsyncFailed: false },
        before, after: snapshot(store) }));
    } finally {
      const closed = await scope.stop(owner, 10_000);
      if (!t.signal.aborted) {
        assert.equal(closed.code, 0, `holder failed to close: ${closed.stderr.slice(-1000)}`);
      }
    }
  });
