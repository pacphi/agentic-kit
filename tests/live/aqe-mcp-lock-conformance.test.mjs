// Explicit opt-in: released AQE MCP holder + extracted packed-kit command.
// No package acquisition, real-project mutation or provider credentials here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProcessScope } from './aqe-live-lock-process.mjs';
import { createMcpSession } from './aqe-mcp-session.mjs';
import { digest, childEnv, snapshot } from './aqe-live-lock-fixtures.mjs';

const enabled = process.env.AK_AQE_MCP_LOCK_LIVE === '1';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function selectedRoot(key, name) {
  const value = process.env[key];
  assert.ok(value && path.isAbsolute(value), `${key} must name an approved absolute artifact root`);
  const root = fs.realpathSync(value);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, name);
  return { root, pkg };
}

function lockOwner(store) {
  try {
    const lock = fs.readFileSync(path.join(store, 'patterns.rvf.lock'));
    return lock.length >= 8 && lock.subarray(0, 4).toString() === 'FLVR' ? lock.readUInt32LE(4) : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function preserved(owner, store, before) {
  assert.equal(owner.closed, false, 'MCP holder closed during verification');
  assert.equal(owner.child.exitCode, null);
  assert.equal(owner.child.signalCode, null);
  assert.ifError(owner.error);
  assert.equal(lockOwner(store), owner.child.pid, 'MCP must still own the RVF lock');
  assert.deepEqual(snapshot(store), before, 'verification changed RVF/lock bytes or filenames');
  assert.ok(!fs.readdirSync(store).some((name) => name.includes('.corrupt-')), 'verification quarantined a store');
}

test('released MCP holder yields ordinary busy startup through the packed kit without changing RVF', {
  skip: !enabled && 'set AK_AQE_MCP_LOCK_LIVE=1 after approving exact artifact acquisition',
  timeout: 420_000,
}, async (t) => {
  const aqe = selectedRoot('AK_AQE_PACKAGE_ROOT', 'agentic-qe');
  const kit = selectedRoot('AK_KIT_PACKAGE_ROOT', '@pacphi/agentic-kit');
  assert.equal(aqe.pkg.version, process.env.AK_AQE_EXPECTED_VERSION, 'select an exact AQE version');
  assert.ok(!fs.existsSync(path.join(kit.root, '.git')), 'use an extracted packed kit, not its checkout');
  const prefix = process.env.AK_AQE_PREFIX;
  assert.ok(prefix && path.isAbsolute(prefix), 'AK_AQE_PREFIX must name the approved private npm prefix');
  const globalRoot = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules');
  assert.equal(fs.realpathSync(path.join(globalRoot, 'agentic-qe')), aqe.root, 'prefix must select the same AQE artifact');
  const cli = path.join(aqe.root, aqe.pkg.bin.aqe);
  const mcp = path.join(aqe.root, aqe.pkg.bin['aqe-mcp']);
  const kitBin = path.join(kit.root, 'bin', 'agentic-kit.mjs');
  const sourceHashes = { aqeCli: digest(cli), aqeMcp: digest(mcp), kitBin: digest(kitBin), kitManifest: digest(path.join(kit.root, 'package.json')) };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-mcp-lock-')));
  const scope = createProcessScope(t.signal);
  t.after(async () => {
    try { await scope.closeAll(); }
    catch (error) { throw Error(`owned child closure unverified; retained ${root}`, { cause: error }); }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"aqe-mcp-lock-proof","version":"1.0.0"}\n');
  const env = childEnv(root, project);
  env.npm_config_prefix = prefix;
  env.PATH = [process.platform === 'win32' ? prefix : path.join(prefix, 'bin'), env.PATH].join(path.delimiter);
  const configBase = process.platform === 'win32' ? env.APPDATA : env.XDG_CONFIG_HOME;
  const configDir = path.join(configBase, 'agentic-kit'); fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'kit.json'), JSON.stringify({ aqe: true, ruvnetBrain: false,
    aqeEmbedding: { mode: 'unmanaged' }, mcp: { register: false } }));
  const options = { cwd: project, env };
  const invoke = async (file, args, limit = 120_000) => scope.wait(scope.launch(process.execPath, [file, ...args], options), limit);
  const init = await invoke(cli, ['init', '--minimal', '--auto'], 150_000);
  assert.equal(init.timedOut, false);
  assert.equal(init.code, 0, 'disposable AQE init failed');
  const store = path.join(project, '.agentic-qe');
  const owner = scope.launch(process.execPath, [mcp], options, { pipeInput: true });
  const session = createMcpSession(owner);
  let discovery;
  let proofError;
  let shutdownError;
  try {
    discovery = await session.discover();
    const deadline = Date.now() + 30_000;
    while (lockOwner(store) !== owner.child.pid && !owner.closed && Date.now() < deadline) await pause(50);
    assert.equal(lockOwner(store), owner.child.pid, 'ready MCP did not acquire the RVF lock; boundary unmet');
    const before = snapshot(store);
    assert.ok(before['patterns.rvf'] && before['patterns.rvf.lock']);
    preserved(owner, store, before);
    const status = await invoke(cli, ['status']);
    t.diagnostic(JSON.stringify({ phase: 'aqe-status', exit: status.code,
      output: (status.stdout + status.stderr).slice(-1800) }));
    assert.equal(status.timedOut, false);
    assert.equal(status.outputLimitExceeded, false);
    assert.equal(status.code, 0);
    // 3.14.6's live-owner sentinel deliberately returns before the generic
    // adapter-error logger. Its warning, preserved ownership and successful
    // SQLite fallback are the contract; no literal error token is required.
    assert.match(status.stdout + status.stderr, /locked by a live process/);
    assert.match(status.stdout + status.stderr, /not breaking the lock; degrading to SQLite/);
    assert.doesNotMatch(status.stdout + status.stderr, /FsyncFailed|0x0303/);
    preserved(owner, store, before);
    const result = await invoke(kitBin, ['status', '--refresh=live', '--only', 'aqe', '--json'], 180_000);
    assert.equal(result.timedOut, false);
    assert.equal(result.outputLimitExceeded, false);
    assert.ok([0, 1].includes(result.code), 'kit usage/transport failure is not qualified startup proof');
    const receipt = JSON.parse(result.stdout);
    const checks = receipt.live?.filter((entry) => entry.id === 'aqe');
    assert.equal(checks?.length, 1);
    assert.ok(checks[0].entries.some((entry) => entry.level === 'warn'
      && /RVF is held by another live process; SQLite fallback observed/.test(entry.text)), 'ordinary busy startup missing');
    assert.ok(!checks[0].entries.some((entry) => /RVF backend failed/.test(entry.text)));
    preserved(owner, store, before);
    // Overall semantic readiness may fail on this deliberately unmanaged backend.
    // Record its result independently; it is never promoted to an embedding pass.
    console.log(JSON.stringify({ aqeVersion: aqe.pkg.version, kitVersion: kit.pkg.version,
      platform: process.platform, node: process.version, sourceHashes, discovery,
      startup: 'busy', semanticCheck: checks[0].status, kitExit: result.code,
      rvfPreserved: true, before, after: snapshot(store) }));
  } catch (error) {
    proofError = error;
  } finally {
    session.dispose();
    try {
      const closed = await scope.stop(owner, 10_000, { closeInput: true });
      if (!t.signal.aborted) {
        assert.equal(closed.stopMethod, 'stdin-eof');
        assert.equal(closed.code, 0);
        assert.equal(closed.signal, null);
        assert.equal(closed.outputLimitExceeded, false);
        assert.match(closed.stderr, /Shutting down \(stdin-(eof|close)\)/);
        assert.match(closed.stderr, /\[MCP\] Server stopped/);
        assert.doesNotMatch(closed.stderr, /Shutdown watchdog fired/);
        t.diagnostic(JSON.stringify({ phase: 'shutdown', exit: closed.code,
          remainingLockPid: lockOwner(store), ownerPid: owner.child.pid,
          stderr: closed.stderr.slice(-1800) }));
        assert.equal(fs.existsSync(path.join(store, 'patterns.rvf.lock')), false, 'closed MCP left its owned RVF lock');
        console.log(JSON.stringify({ phase: 'shutdown', sourceHashes, aqeVersion: aqe.pkg.version,
          platform: process.platform, stopMethod: closed.stopMethod, exit: closed.code,
          signal: closed.signal, watchdog: false, ownedLockReleased: true }));
      }
    } catch (error) {
      shutdownError = error;
    }
  }
  if (proofError && shutdownError) throw new AggregateError([proofError, shutdownError], 'startup proof and shutdown both failed');
  if (proofError) throw proofError;
  if (shutdownError) throw shutdownError;
});
