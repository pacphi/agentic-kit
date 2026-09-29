// Opt-in diagnosis only. A backend response never substitutes for public routing
// proof. Run alongside (not instead of) ruflo-memory-routing.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnEnv, envValue } from '../kit/helpers/home-sandbox.mjs';
import { resolveShim } from '../../src/lib/exec.mjs';
import { createDiagnosticScope } from './ruflo-windows-diagnostic-process.mjs';

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const initialized = (stdout) => stdout.split('\n').some((line) => {
  try { const r = JSON.parse(line); return r.id === 1 && Boolean(r.result?.protocolVersion); }
  catch { return false; }
});
const input = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ak-native-diagnostic', version: '1' },
} })}\n`;

test('diagnose installed Ruflo Windows public shim versus installed bin transport', {
  skip: process.env.AK_RUFLO_WINDOWS_DIAGNOSTIC !== '1', timeout: 120000,
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
  const scope = createDiagnosticScope();
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
    const version = await scope.launch(resolveShim('ruflo', ['--version'], { env }),
      { cwd: root, env, timeoutMs: 10000 });
    console.log(JSON.stringify({ diagnostic: 'inputs', node: process.version, uv: process.versions.uv,
      platform: process.platform, packageVersion: pkg.version, version,
      packageSha: sha(packageFile), bin, binSha: sha(bin), invocation,
      shimSha: sha(shim), shimSource: fs.readFileSync(shim, 'utf8').slice(0, 8192),
      sourceSha: sha(new URL(import.meta.url)),
      launcherSha: sha(new URL('./ruflo-windows-diagnostic-process.mjs', import.meta.url)) }));
    assert.equal(version.cleanupComplete, true, 'version launch cleanup incomplete');
    // Capture the original fixture's native argument forwarding without
    // creating any descendants: this isolates quoting from tree ownership.
    const legacyShim = path.join(root, 'legacy-fixture.ps1');
    const marker = path.join(root, 'legacy-marker');
    fs.writeFileSync(legacyShim, `& '${process.execPath.replaceAll("'", "''")}' -e $args[0]\nexit $LASTEXITCODE\n`);
    const legacyCode = `const {spawn}=require('node:child_process');
      require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid]));`;
    const legacy = await scope.launch({ command: invocation.command, args: [
      ...invocation.args.slice(0, scriptIndex + 1), legacyShim, legacyCode,
    ] }, { cwd: root, env, timeoutMs: 5000 });
    console.log(JSON.stringify({ diagnostic: 'legacy-multiline-node-e',
      marker: fs.existsSync(marker), ...legacy }));
    assert.equal(legacy.cleanupComplete, true, 'legacy launch cleanup incomplete');
    for (const [transport, spec, eof] of [
      ['public-open-stdin', invocation, false],
      ['public-eof', invocation, true],
      ['installed-bin-open-stdin', { command: process.execPath, args: [bin, 'mcp', 'start'] }, false],
    ]) {
      const observation = await scope.launch(spec, { cwd: root, env, input, endInput: eof,
        timeoutMs: 15000, until: initialized });
      console.log(JSON.stringify({ diagnostic: transport, initialized: observation.matched, endInput: eof, ...observation }));
      assert.equal(observation.cleanupComplete, true, `${transport} cleanup incomplete`);
    }
    clean = scope.release();
    assert.equal(clean, true, 'every diagnostic launch must prove cleanup before root removal');
  } finally {
    if (clean) fs.rmSync(root, { recursive: true, force: true });
    else console.error(`diagnostic root retained: ${root}`);
  }
});
