// Opt-in diagnosis only. A backend response never substitutes for public routing
// proof. Run alongside (not instead of) ruflo-memory-routing.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { spawnEnv, envValue } from '../kit/helpers/home-sandbox.mjs';
import { resolveShim, run } from '../../src/lib/exec.mjs';
import { acquireRunRootHold, releaseRunRootHold } from '../../scripts/run-roots.mjs';

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function initialize(invocation, cwd, env, endInput) {
  const child = spawn(invocation.command, invocation.args, {
    cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let closed = false;
  let error;
  let stdout = '';
  let stderr = '';
  let overflow = false;
  let bytes = 0;
  const capture = (current, chunk) => {
    bytes += chunk.length;
    const value = current + chunk.toString('utf8');
    if (bytes > 65536) overflow = true;
    return value.slice(0, 16384);
  };
  child.stdout.on('data', (chunk) => { stdout = capture(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = capture(stderr, chunk); });
  child.on('error', (e) => { error = e.message; });
  child.stdin.on('error', (e) => { error = e.message; });
  const done = new Promise((resolve) => child.once('close', (code, signal) => {
    closed = true; resolve({ code, signal });
  }));
  const response = () => stdout.split('\n').some((line) => {
    try { const r = JSON.parse(line); return r.id === 1 && Boolean(r.result?.protocolVersion); }
    catch { return false; }
  });
  const started = Date.now();
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ak-native-diagnostic', version: '1' },
    } })}\n`);
    if (endInput) child.stdin.end();
    while (!closed && !response() && !overflow && Date.now() - started < 15000) await delay(50);
    return { initialized: response(), endInput, elapsedMs: Date.now() - started,
      exitCodeBeforeCleanup: child.exitCode, signalBeforeCleanup: child.signalCode,
      overflow, error, stdout, stderr };
  } finally {
    // Never target a PID after its owned process has exited. Failure to observe
    // pipe closure retains the suite hold and disposable root for inspection.
    if (!closed && child.exitCode === null && child.signalCode === null && child.pid) {
      const killed = await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        env, timeout: 3000, maxBuffer: 65536,
      });
      assert.equal(killed.code, 0, `diagnostic tree cleanup: ${killed.stderr}`);
    }
    await Promise.race([done, delay(5000)]);
    assert.equal(closed, true, 'diagnostic process pipes closed before removing root');
  }
}

test('diagnose installed Ruflo Windows public shim versus installed bin transport', {
  skip: process.env.AK_RUFLO_WINDOWS_DIAGNOSTIC !== '1', timeout: 90000,
}, async () => {
  assert.equal(process.platform, 'win32', 'diagnostic requires native Windows');
  const packageRoot = process.env.AK_RUFLO_PACKAGE_ROOT;
  assert.ok(packageRoot && path.isAbsolute(packageRoot), 'explicit installed Ruflo package root required');
  const packageFile = path.join(packageRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  assert.equal(pkg.name, 'ruflo');
  const bin = path.resolve(packageRoot, typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.ruflo);
  assert.ok(bin.startsWith(`${fs.realpathSync(packageRoot)}${path.sep}`), 'bin belongs to installed package');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ruflo-win-diagnostic-'));
  const hold = acquireRunRootHold();
  let clean = false;
  try {
    const bootstrap = {};
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
      const value = envValue(process.env, key);
      if (value) bootstrap[key] = value;
    }
    const env = spawnEnv(root, {
      CLAUDE_FLOW_DB_PATH: path.join(root, '.swarm', 'memory.db'),
      CLAUDE_FLOW_MEMORY_PATH: path.join(root, '.swarm'), RUFLO_DAEMON_AUTOSTART: '0',
    }, { env: bootstrap });
    fs.writeFileSync(path.join(root, 'claude-flow.config.json'), JSON.stringify({ daemon: { autostart: false } }));
    const invocation = resolveShim('ruflo', ['mcp', 'start'], { env });
    assert.equal(invocation.resolved, true, 'installed public shim must resolve');
    const scriptIndex = invocation.args.indexOf('-File');
    assert.ok(scriptIndex >= 0, 'receipt requires the native PowerShell transport');
    const shim = invocation.args[scriptIndex + 1];
    const version = await run('ruflo', ['--version'], { cwd: root, env, timeout: 10000 });
    console.log(JSON.stringify({ diagnostic: 'inputs', node: process.version, uv: process.versions.uv,
      platform: process.platform, packageVersion: pkg.version, version,
      packageSha: sha(packageFile), bin, binSha: sha(bin), invocation,
      shimSha: sha(shim), shimSource: fs.readFileSync(shim, 'utf8').slice(0, 8192),
      sourceSha: sha(new URL(import.meta.url)) }));
    // Capture the original fixture's native argument forwarding without
    // creating any descendants: this isolates quoting from tree ownership.
    const legacyShim = path.join(root, 'legacy-fixture.ps1');
    const marker = path.join(root, 'legacy-marker');
    fs.writeFileSync(legacyShim, `& '${process.execPath.replaceAll("'", "''")}' -e $args[0]\nexit $LASTEXITCODE\n`);
    const legacyCode = `const {spawn}=require('node:child_process');
      require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid]));`;
    const legacy = await run(invocation.command, [
      ...invocation.args.slice(0, scriptIndex + 1), legacyShim, legacyCode,
    ], { cwd: root, env, timeout: 5000, maxBuffer: 65536 });
    console.log(JSON.stringify({ diagnostic: 'legacy-multiline-node-e',
      marker: fs.existsSync(marker), ...legacy }));
    for (const [transport, spec, eof] of [
      ['public-open-stdin', invocation, false],
      ['public-eof', invocation, true],
      ['installed-bin-open-stdin', { command: process.execPath, args: [bin, 'mcp', 'start'] }, false],
    ]) {
      console.log(JSON.stringify({ diagnostic: transport, ...await initialize(spec, root, env, eof) }));
    }
    clean = true;
  } finally {
    if (clean) { releaseRunRootHold(hold); fs.rmSync(root, { recursive: true, force: true }); }
    else console.error(`diagnostic root retained: ${root}`);
  }
});
