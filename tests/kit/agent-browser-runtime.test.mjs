import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AGENT_BROWSER_PACKAGE,
  AGENT_BROWSER_RUFLO_RANGE,
  browserPayloadAutoInstallSupported,
  compatibleAgentBrowserVersion,
  targetAgentBrowserVersion,
  managedAgentBrowserEnv,
  findAgentBrowserChrome,
  findSystemChrome,
  ensureAgentBrowser,
  inspectAgentBrowser,
  removeManagedAgentBrowser,
} from '../../src/lib/agent-browser.mjs';
import { REVIEWED_GLOBAL_INSTALL_SCRIPTS, globalInstallArgs } from '../../src/lib/npm-global-install.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fakePackage(root, version, { native = true } = {}) {
  const packageRoot = path.join(root, 'agent-browser');
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: AGENT_BROWSER_PACKAGE, version,
  }));
  if (native) {
    const nativePath = path.join(packageRoot, 'bin', 'agent-browser-darwin-arm64');
    fs.writeFileSync(nativePath, 'native');
    fs.chmodSync(nativePath, 0o755);
  }
  return packageRoot;
}

test('Ruflo compatibility is exact and Node-aware instead of following npm latest', () => {
  assert.equal(AGENT_BROWSER_RUFLO_RANGE, '>=0.27.0 <0.28.0');
  assert.equal(targetAgentBrowserVersion('22.18.0'), '0.27.0');
  assert.equal(targetAgentBrowserVersion('23.9.0'), '0.27.0');
  assert.equal(targetAgentBrowserVersion('24.0.0'), '0.27.3');
  assert.equal(targetAgentBrowserVersion('26.4.0'), '0.27.3');
  assert.equal(targetAgentBrowserVersion('21.9.0'), null);
  assert.equal(compatibleAgentBrowserVersion('0.27.0'), true);
  assert.equal(compatibleAgentBrowserVersion('0.27.3'), true);
  assert.equal(compatibleAgentBrowserVersion('0.28.0'), false);
  assert.equal(compatibleAgentBrowserVersion('0.36.0'), false);
  assert.equal(browserPayloadAutoInstallSupported('linux', 'arm64'), false);
  assert.equal(browserPayloadAutoInstallSupported('linux', 'x64'), true);
  assert.equal(browserPayloadAutoInstallSupported('darwin', 'arm64'), true);
});

test('agent-browser postinstall is in the one reviewed global lifecycle policy', () => {
  assert.ok(REVIEWED_GLOBAL_INSTALL_SCRIPTS.includes('agent-browser'));
  assert.deepEqual(globalInstallArgs('agent-browser@0.27.3').slice(-1), ['agent-browser@0.27.3']);
});

test('managed MCP env points only at the trusted Kit config and can be disabled', () => {
  assert.deepEqual(managedAgentBrowserEnv({ enabled: false, configFile: '/safe/config.json' }), {});
  assert.deepEqual(managedAgentBrowserEnv({ enabled: true, configFile: '/safe/config.json' }), {
    AGENT_BROWSER_CONFIG: path.resolve('/safe/config.json'),
  });
  assert.throws(() => managedAgentBrowserEnv({ enabled: true, configFile: 'relative.json' }), /absolute/);
});

test('read-only browser discovery distinguishes managed cache from system Chrome', () => {
  const home = tmp('ak-agent-browser-discovery');
  const cached = path.join(home, '.agent-browser', 'browsers', 'chrome-148',
    'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, 'chrome');
  fs.chmodSync(cached, 0o755);
  assert.deepEqual(findAgentBrowserChrome({ homeDir: home, platform: 'darwin' }), {
    path: fs.realpathSync(cached), source: 'agent-browser-cache', revision: 'chrome-148',
  });

  const applications = path.join(home, 'Applications');
  const system = path.join(applications, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
  fs.mkdirSync(path.dirname(system), { recursive: true });
  fs.writeFileSync(system, 'chrome');
  fs.chmodSync(system, 0o755);
  assert.deepEqual(findSystemChrome({ platform: 'darwin', candidates: [system] }), {
    path: fs.realpathSync(system), source: 'system-chrome', revision: null,
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('ensure installs the exact vetted version, verifies native CLI, writes trusted config, and receipts it', async () => {
  const root = tmp('ak-agent-browser-install');
  const globalRootDir = path.join(root, 'global');
  const configFile = path.join(root, 'config', 'agent-browser.json');
  const cfg = { agentBrowser: true, integrations: { ownership: {} } };
  const calls = [];
  const runner = async (bin, args) => {
    calls.push([bin, args]);
    if (bin === 'npm') {
      fakePackage(globalRootDir, '0.27.3');
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: 'agent-browser 0.27.3\n', stderr: '' };
  };
  const result = await ensureAgentBrowser(cfg, {
    globalRootDir, configFile, nodeVersion: '26.4.0', platform: 'darwin', arch: 'arm64',
    runner, installBrowser: false,
  });

  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(calls[0], ['npm', globalInstallArgs('agent-browser@0.27.3')]);
  assert.ok(path.isAbsolute(calls[1][0]), 'verification runs the package-owned native binary');
  assert.deepEqual(calls[1][1], ['--version']);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { headless: true });
  assert.equal(cfg.integrations.ownership.agentBrowser.package.written.version, '0.27.3');
  assert.equal(cfg.integrations.ownership.agentBrowser.package.written.sha256,
    sha256(cfg.integrations.ownership.agentBrowser.package.written.executable));
  assert.equal(cfg.integrations.ownership.agentBrowser.config.written.path, configFile);

  const state = inspectAgentBrowser(cfg, {
    globalRootDir, configFile, nodeVersion: '26.4.0', platform: 'darwin', arch: 'arm64',
  });
  assert.equal(state.package.ownership, 'agentic-kit');
  assert.equal(state.package.receiptState, 'current');
  assert.equal(state.config.state, 'current');
  fs.rmSync(root, { recursive: true, force: true });
});

test('npm success without a package-owned native executable is a failed install with no package receipt', async () => {
  const root = tmp('ak-agent-browser-postinstall-fail');
  const globalRootDir = path.join(root, 'global');
  const cfg = { agentBrowser: true, integrations: { ownership: {} } };
  const result = await ensureAgentBrowser(cfg, {
    globalRootDir,
    configFile: path.join(root, 'config.json'),
    nodeVersion: '26.4.0', platform: 'darwin', arch: 'arm64', installBrowser: false,
    runner: async (bin) => {
      if (bin === 'npm') fakePackage(globalRootDir, '0.27.3', { native: false });
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /native executable/i);
  assert.equal(cfg.integrations.ownership.agentBrowser, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a native executable symlink escaping the package root is never trusted or receipted', async (t) => {
  const root = tmp('ak-agent-browser-native-escape');
  const globalRootDir = path.join(root, 'global');
  const packageRoot = fakePackage(globalRootDir, '0.27.3', { native: false });
  const outside = path.join(root, 'outside-agent-browser');
  fs.writeFileSync(outside, 'native');
  fs.chmodSync(outside, 0o755);
  try {
    fs.symlinkSync(outside, path.join(packageRoot, 'bin', 'agent-browser-darwin-arm64'));
  } catch {
    fs.rmSync(root, { recursive: true, force: true });
    t.skip('this platform does not permit symlink creation');
    return;
  }
  const cfg = { agentBrowser: true, integrations: { ownership: {} } };
  const result = await ensureAgentBrowser(cfg, {
    globalRootDir, configFile: path.join(root, 'config.json'), nodeVersion: '26.4.0',
    platform: 'darwin', arch: 'arm64', installBrowser: false,
    runner: async () => { throw new Error('escaped executable must not run'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /native executable/i);
  assert.equal(cfg.integrations.ownership.agentBrowser, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an existing unreceipted install remains external and an incompatible one is preserved', async () => {
  const root = tmp('ak-agent-browser-external');
  const globalRootDir = path.join(root, 'global');
  fakePackage(globalRootDir, '0.27.3');
  const cfg = { agentBrowser: true, integrations: { ownership: {} } };
  const calls = [];
  const compatible = await ensureAgentBrowser(cfg, {
    globalRootDir, configFile: path.join(root, 'config.json'), nodeVersion: '26.4.0',
    platform: 'darwin', arch: 'arm64', installBrowser: false,
    runner: async (bin, args) => { calls.push([bin, args]); return { code: 0, stdout: 'agent-browser 0.27.3\n', stderr: '' }; },
  });
  assert.equal(compatible.ok, true);
  assert.equal(calls.some(([bin]) => bin === 'npm'), false);
  assert.equal(cfg.integrations.ownership.agentBrowser.package, undefined,
    'a compatible external package is used but never adopted');

  fs.rmSync(path.join(globalRootDir, 'agent-browser'), { recursive: true, force: true });
  fakePackage(globalRootDir, '0.36.0');
  const incompatible = await ensureAgentBrowser(cfg, {
    globalRootDir, configFile: path.join(root, 'config.json'), nodeVersion: '26.4.0',
    platform: 'darwin', arch: 'arm64', installBrowser: false,
    runner: async () => { throw new Error('must not mutate or execute incompatible external package'); },
  });
  assert.equal(incompatible.ok, false);
  assert.match(incompatible.detail, /external.*incompatible/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(globalRootDir, 'agent-browser', 'package.json'))).version, '0.36.0');
  fs.rmSync(root, { recursive: true, force: true });
});

test('--no-upgrade semantics preserve an already compatible receipt-owned version', async () => {
  const root = tmp('ak-agent-browser-no-upgrade');
  const globalRootDir = path.join(root, 'global');
  const packageRoot = fakePackage(globalRootDir, '0.27.0');
  const canonicalPackageRoot = fs.realpathSync(packageRoot);
  const cfg = { agentBrowser: true, integrations: { ownership: { agentBrowser: { package: {
    owner: 'agentic-kit', package: 'agent-browser',
    written: { version: '0.27.0', packageRoot: canonicalPackageRoot },
  } } } } };
  const calls = [];
  const result = await ensureAgentBrowser(cfg, {
    globalRootDir, configFile: path.join(root, 'config.json'), nodeVersion: '26.4.0',
    platform: 'darwin', arch: 'arm64', installBrowser: false, allowUpgrade: false,
    runner: async (bin, args) => {
      calls.push([bin, args]);
      return { code: 0, stdout: 'agent-browser 0.27.0\n', stderr: '' };
    },
  });
  assert.equal(result.ok, true, result.detail);
  assert.equal(calls.some(([bin]) => bin === 'npm'), false);
  assert.equal(cfg.integrations.ownership.agentBrowser.package.written.version, '0.27.0');
  assert.equal(typeof cfg.integrations.ownership.agentBrowser.package.written.sha256, 'string',
    'a verified legacy receipt is upgraded to bind the native digest');
  fs.rmSync(root, { recursive: true, force: true });
});

test('Linux ARM64 converges without retrying an unavailable Chrome for Testing payload', async () => {
  const root = tmp('ak-agent-browser-linux-arm64');
  const globalRootDir = path.join(root, 'global');
  const packageRoot = fakePackage(globalRootDir, '0.27.3');
  const darwinNative = path.join(packageRoot, 'bin', 'agent-browser-darwin-arm64');
  const linuxNative = path.join(packageRoot, 'bin', 'agent-browser-linux-arm64');
  fs.renameSync(darwinNative, linuxNative);
  const cfg = { agentBrowser: true, integrations: { ownership: {} } };
  const calls = [];
  const result = await ensureAgentBrowser(cfg, {
    globalRootDir, configFile: path.join(root, 'config.json'), homeDir: path.join(root, 'home'),
    nodeVersion: '26.4.0', platform: 'linux', arch: 'arm64', installBrowser: true,
    systemChromeCandidates: [],
    runner: async (bin, args) => {
      calls.push([bin, args]);
      return { code: 0, stdout: 'agent-browser 0.27.3\n', stderr: '' };
    },
  });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.ready, false);
  assert.match(result.detail, /unavailable on linux\/arm64/i);
  assert.deepEqual(calls.map(([, args]) => args), [['--version']],
    'verification runs, but the unsupported browser installer does not');
  fs.rmSync(root, { recursive: true, force: true });
});

test('removal is receipt-gated and never deletes browser/session/profile data', async () => {
  const root = tmp('ak-agent-browser-remove');
  const globalRootDir = path.join(root, 'global');
  const packageRoot = fakePackage(globalRootDir, '0.27.3');
  const canonicalPackageRoot = fs.realpathSync(packageRoot);
  const executable = path.join(canonicalPackageRoot, 'bin', 'agent-browser-darwin-arm64');
  const dataFile = path.join(root, 'home', '.agent-browser', 'profiles', 'keep', 'Cookies');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, 'private');
  const cfg = { integrations: { ownership: { agentBrowser: { package: {
    owner: 'agentic-kit', package: 'agent-browser',
    written: {
      version: '0.27.3', packageRoot: canonicalPackageRoot, executable, sha256: sha256(executable),
    },
  } } } } };
  const calls = [];
  const result = await removeManagedAgentBrowser(cfg, {
    globalRootDir, platform: 'darwin', arch: 'arm64',
    runner: async (bin, args) => {
      calls.push([bin, args]);
      fs.rmSync(packageRoot, { recursive: true, force: true });
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['npm', ['uninstall', '-g', 'agent-browser']]]);
  assert.equal(fs.existsSync(dataFile), true);
  assert.equal(cfg.integrations.ownership.agentBrowser?.package, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('binary drift blocks receipt-gated removal without invoking npm', async () => {
  const root = tmp('ak-agent-browser-remove-drift');
  const globalRootDir = path.join(root, 'global');
  const packageRoot = fs.realpathSync(fakePackage(globalRootDir, '0.27.3'));
  const executable = path.join(packageRoot, 'bin', 'agent-browser-darwin-arm64');
  const cfg = { integrations: { ownership: { agentBrowser: { package: {
    owner: 'agentic-kit', package: 'agent-browser',
    written: { version: '0.27.3', packageRoot, executable, sha256: sha256(executable) },
  } } } } };
  fs.appendFileSync(executable, 'changed');
  const result = await removeManagedAgentBrowser(cfg, {
    globalRootDir,
    runner: async () => { throw new Error('drifted package must not invoke npm'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /drifted/i);
  assert.equal(fs.existsSync(packageRoot), true);
  assert.ok(cfg.integrations.ownership.agentBrowser.package);
  fs.rmSync(root, { recursive: true, force: true });
});
