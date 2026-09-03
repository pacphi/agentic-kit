// Managed compatibility layer for Ruflo's currently shipped browser MCP.
// Ruflo 3.38.x shells out to `agent-browser`; its browser package declares
// ^0.27.0, while npm latest has moved beyond that range. Agentic Kit therefore
// pins an exact Node-compatible release, verifies the downloaded native binary,
// and gives only Ruflo MCP children an AK-owned config path. This module is a
// replaceable adapter boundary: Servo becomes eligible only when a released
// Ruflo build actually ships and selects it (ADR-0043).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.mjs';
import { globalInstallArgs } from './npm-global-install.mjs';
import * as paths from './paths.mjs';
import { writeJsonWithBackup } from './settings.mjs';

export const AGENT_BROWSER_PACKAGE = 'agent-browser';
export const AGENT_BROWSER_RUFLO_RANGE = '>=0.27.0 <0.28.0';
export const AGENT_BROWSER_TARGETS = Object.freeze({ node22: '0.27.0', node24: '0.27.3' });

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fileHash = (file, fsImpl = fs) => {
  try { return crypto.createHash('sha256').update(fsImpl.readFileSync(file)).digest('hex'); } catch { return null; }
};

export function targetAgentBrowserVersion(nodeVersion = process.versions.node) {
  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  if (!Number.isInteger(major) || major < 22) return null;
  return major >= 24 ? AGENT_BROWSER_TARGETS.node24 : AGENT_BROWSER_TARGETS.node22;
}

export function compatibleAgentBrowserVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version ?? ''));
  return !!match && Number(match[1]) === 0 && Number(match[2]) === 27;
}

// Chrome for Testing publishes no Linux ARM64 payload. Keep this capability
// test explicit so setup/sync can converge on those machines without treating
// a documented upstream distribution gap as a transient download failure.
export function browserPayloadAutoInstallSupported(
  platform = process.platform, arch = process.arch,
) {
  return !(platform === 'linux' && arch === 'arm64');
}

export function managedAgentBrowserEnv({
  enabled = true, configFile = paths.agentBrowserConfigPath(),
} = {}) {
  if (!enabled) return {};
  if (!path.isAbsolute(configFile)) throw new TypeError('agent-browser config path must be absolute');
  return { AGENT_BROWSER_CONFIG: path.resolve(configFile) };
}

function executable(file, fsImpl = fs) {
  try {
    const stat = fsImpl.statSync(file);
    if (!stat.isFile() || stat.size <= 0) return false;
    return process.platform === 'win32' || (stat.mode & 0o111) !== 0;
  } catch { return false; }
}

function realExecutable(file, fsImpl = fs) {
  if (!file || !executable(file, fsImpl)) return null;
  try { return fsImpl.realpathSync(file); } catch { return null; }
}

function isInside(root, target) {
  if (!root || !target) return false;
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative);
}

function chromeCandidatesIn(root, platform) {
  if (platform === 'darwin') return [
    path.join(root, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    path.join(root, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    path.join(root, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  ];
  if (platform === 'linux') return [path.join(root, 'chrome'), path.join(root, 'chrome-linux64', 'chrome')];
  if (platform === 'win32') return [path.join(root, 'chrome.exe'), path.join(root, 'chrome-win64', 'chrome.exe')];
  return [];
}

export function findAgentBrowserChrome({
  homeDir = paths.home, platform = process.platform, fsImpl = fs,
} = {}) {
  const root = path.join(homeDir, '.agent-browser', 'browsers');
  let revisions;
  try {
    revisions = fsImpl.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('chrome-'))
      .map((entry) => entry.name).sort().reverse();
  } catch { return null; }
  for (const revision of revisions) {
    for (const candidate of chromeCandidatesIn(path.join(root, revision), platform)) {
      const resolved = realExecutable(candidate, fsImpl);
      if (resolved) return { path: resolved, source: 'agent-browser-cache', revision };
    }
  }
  return null;
}

function defaultSystemChromeCandidates(platform, env = process.env) {
  if (platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  if (platform === 'linux') return [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  if (platform === 'win32') return [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  return [];
}

export function findSystemChrome({
  platform = process.platform, env = process.env,
  candidates = defaultSystemChromeCandidates(platform, env), fsImpl = fs,
} = {}) {
  for (const candidate of candidates) {
    const resolved = realExecutable(candidate, fsImpl);
    if (resolved) return { path: resolved, source: 'system-chrome', revision: null };
  }
  return null;
}

/** @param {string} globalRootDir
 * @param {{platform?:string,arch?:string,fsImpl?:typeof fs}} [options] */
function packageFacts(globalRootDir, {
  platform = process.platform, arch = process.arch, fsImpl = fs,
} = {}) {
  const packageRoot = path.join(globalRootDir, AGENT_BROWSER_PACKAGE);
  let manifest = null;
  try { manifest = JSON.parse(fsImpl.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')); } catch { /* absent */ }
  let canonicalPackageRoot = null;
  try { canonicalPackageRoot = fsImpl.realpathSync(packageRoot); } catch { /* absent */ }
  const effectiveArch = platform === 'win32' && arch === 'arm64' ? 'x64' : arch;
  const suffix = platform === 'win32' ? '.exe' : '';
  const stems = platform === 'linux'
    ? [`agent-browser-linux-${effectiveArch}${suffix}`, `agent-browser-linux-musl-${effectiveArch}${suffix}`]
    : [`agent-browser-${platform}-${effectiveArch}${suffix}`];
  const native = stems.map((name) => path.join(packageRoot, 'bin', name))
    .map((candidate) => realExecutable(candidate, fsImpl))
    .find((candidate) => isInside(canonicalPackageRoot, candidate)) ?? null;
  return {
    present: manifest?.name === AGENT_BROWSER_PACKAGE,
    version: manifest?.version ?? null,
    packageRoot: manifest ? canonicalPackageRoot : null,
    native,
    nativeSha256: native ? fileHash(native, fsImpl) : null,
  };
}

function receiptState(receipt, facts) {
  if (!receipt) return 'missing';
  const written = receipt.written ?? {};
  const coreCurrent = receipt.owner === 'agentic-kit'
    && receipt.package === AGENT_BROWSER_PACKAGE
    && written.version === facts.version
    && path.resolve(written.packageRoot ?? '') === path.resolve(facts.packageRoot ?? '');
  if (!coreCurrent) return 'drifted';
  // Receipts written by the unreleased first implementation did not bind the
  // executable digest. They may be upgraded only after the normal native
  // version proof succeeds; teardown never accepts this weaker state.
  if (!written.executable || !written.sha256) return 'legacy';
  return path.resolve(written.executable) === path.resolve(facts.native ?? '')
    && written.sha256 === facts.nativeSha256 ? 'current' : 'drifted';
}

function inspectConfig(configFile, receipt, fsImpl) {
  const sha256 = fileHash(configFile, fsImpl);
  const current = receipt?.owner === 'agentic-kit'
    && path.resolve(receipt.written?.path ?? '') === path.resolve(configFile)
    && receipt.written?.sha256 === sha256;
  const state = receipt ? (current ? 'current' : 'drifted') : (sha256 ? 'external' : 'missing');
  let document = null;
  try { document = JSON.parse(fsImpl.readFileSync(configFile, 'utf8')); } catch { /* missing/malformed */ }
  return {
    path: configFile,
    state,
    valid: plain(document) && document.headless === true,
    executablePath: typeof document?.executablePath === 'string' ? document.executablePath : null,
  };
}

const detectBrowser = (options) => findAgentBrowserChrome(options) ?? findSystemChrome(options);

export function inspectAgentBrowser(cfg, {
  globalRootDir = paths.globalRoot(), configFile = paths.agentBrowserConfigPath(),
  homeDir = paths.home, nodeVersion = process.versions.node,
  platform = process.platform, arch = process.arch, env = process.env, fsImpl = fs,
} = {}) {
  const target = targetAgentBrowserVersion(nodeVersion);
  const facts = packageFacts(globalRootDir, { platform, arch, fsImpl });
  const ownership = cfg?.integrations?.ownership?.agentBrowser ?? {};
  const pkgReceiptState = receiptState(ownership.package, facts);
  const config = inspectConfig(configFile, ownership.config, fsImpl);
  const browser = detectBrowser({ homeDir, platform, env, fsImpl });
  const compatible = facts.present && compatibleAgentBrowserVersion(facts.version);
  return {
    enabled: cfg?.agentBrowser !== false,
    target,
    supported: !!target,
    package: {
      ...facts,
      compatible,
      ownership: ['current', 'legacy'].includes(pkgReceiptState)
        ? 'agentic-kit' : (facts.present ? 'external' : 'none'),
      receiptState: pkgReceiptState,
    },
    config,
    browser,
    browserPayload: {
      autoInstallSupported: browserPayloadAutoInstallSupported(platform, arch),
      platform,
      arch,
    },
    ready: !!(target && compatible && facts.native && config.state === 'current' && config.valid && browser),
  };
}

function ensureOwnership(cfg) {
  cfg.integrations ??= {};
  cfg.integrations.ownership ??= {};
  cfg.integrations.ownership.agentBrowser ??= {};
  return cfg.integrations.ownership.agentBrowser;
}

function packagePreflight(facts, receipt) {
  const state = receiptState(receipt, facts);
  if (facts.present && !compatibleAgentBrowserVersion(facts.version) && state !== 'current') {
    return {
      ok: false,
      detail: `external agent-browser ${facts.version} is incompatible with Ruflo ${AGENT_BROWSER_RUFLO_RANGE}; preserved`,
    };
  }
  if (receipt && state === 'drifted') {
    return { ok: false, detail: 'agent-browser package drifted from its ownership receipt; preserved' };
  }
  return { ok: true, receiptState: state };
}

async function convergePackage({
  facts, receiptState: state, target, allowUpgrade, globalRootDir, platform, arch, fsImpl, runner,
}) {
  const owned = state === 'current' || state === 'legacy';
  const needsInstall = !facts.present || (allowUpgrade && owned && facts.version !== target);
  if (!needsInstall) return { ok: true, changed: false, installedByKit: false, facts };
  const install = await runner('npm', globalInstallArgs(`${AGENT_BROWSER_PACKAGE}@${target}`), { timeout: 600_000 });
  if (install.code !== 0) {
    return {
      ok: false, changed: false,
      detail: `agent-browser install failed: ${(install.stderr || `exit ${install.code}`).trim().split('\n').slice(-1)[0]}`,
    };
  }
  return {
    ok: true, changed: true, installedByKit: true,
    facts: packageFacts(globalRootDir, { platform, arch, fsImpl }),
  };
}

async function verifyPackage(facts, { target, installedByKit, runner }) {
  if (!facts.present || (installedByKit && facts.version !== target)) {
    return { ok: false, detail: `installed package did not verify as ${AGENT_BROWSER_PACKAGE}@${target}` };
  }
  if (!compatibleAgentBrowserVersion(facts.version)) {
    return { ok: false, detail: `agent-browser ${facts.version} is outside Ruflo ${AGENT_BROWSER_RUFLO_RANGE}` };
  }
  if (!facts.native) {
    return { ok: false, detail: 'agent-browser postinstall did not materialize a package-owned native executable' };
  }
  const version = await runner(facts.native, ['--version'], { timeout: 30_000 });
  const expected = new RegExp(`(?:^|\\s)${facts.version.replaceAll('.', '\\.')}\\s*$`);
  return version.code === 0 && expected.test(version.stdout.trim())
    ? { ok: true }
    : { ok: false, detail: `agent-browser native executable failed version verification for ${facts.version}` };
}

function receiptInstalledPackage(cfg, facts) {
  const ownership = ensureOwnership(cfg);
  ownership.package = {
    owner: 'agentic-kit', method: 'npm', package: AGENT_BROWSER_PACKAGE,
    written: {
      version: facts.version,
      packageRoot: path.resolve(facts.packageRoot),
      executable: facts.native,
      sha256: facts.nativeSha256,
    },
  };
}

function ensureTrustedConfig(cfg, { configFile, fsImpl }) {
  const receipt = cfg?.integrations?.ownership?.agentBrowser?.config;
  const before = inspectConfig(configFile, receipt, fsImpl);
  if (before.state === 'external') {
    return { ok: false, changed: false, detail: `trusted config path is occupied by an unowned file: ${configFile}` };
  }
  if (before.state === 'drifted' && fileHash(configFile, fsImpl)) {
    return { ok: false, changed: false, detail: `agent-browser config drifted from its ownership receipt: ${configFile}` };
  }
  writeJsonWithBackup(configFile, { headless: true });
  const ownership = ensureOwnership(cfg);
  ownership.config = {
    owner: 'agentic-kit',
    written: { path: path.resolve(configFile), sha256: fileHash(configFile, fsImpl) },
  };
  return { ok: true, changed: before.state !== 'current' || !before.valid };
}

async function ensureBrowserPayload(facts, {
  homeDir, platform, arch, env, fsImpl, runner, installBrowser, systemChromeCandidates,
}) {
  let browser = detectBrowser({
    homeDir, platform, env, fsImpl, candidates: systemChromeCandidates,
  });
  if (!browser && installBrowser && !browserPayloadAutoInstallSupported(platform, arch)) {
    return {
      ok: true, changed: false, ready: false,
      detail: `Chrome for Testing is unavailable on ${platform}/${arch}; provide a compatible Chromium/Chrome executable`,
    };
  }
  if (!browser && installBrowser) {
    const install = await runner(facts.native, ['install'], { timeout: 600_000 });
    if (install.code !== 0) {
      return { ok: false, changed: true, ready: false, detail: 'agent-browser CLI ready but Chrome for Testing download failed' };
    }
    browser = findAgentBrowserChrome({ homeDir, platform, fsImpl });
    return { ok: true, changed: true, ready: !!browser, browser };
  }
  return { ok: true, changed: false, ready: !!browser, browser };
}

function activationDecision(cfg, nodeVersion) {
  if (cfg?.agentBrowser === false) {
    return { result: { ok: true, changed: false, detail: 'management disabled' }, target: null };
  }
  const target = targetAgentBrowserVersion(nodeVersion);
  return target
    ? { result: null, target }
    : { result: { ok: false, changed: false, detail: `unsupported Node ${nodeVersion}; Node 22+ required` }, target: null };
}

async function ensureAgentBrowserPackage(cfg, {
  target, allowUpgrade, runner, globalRootDir, platform, arch, fsImpl,
}) {
  const initialFacts = packageFacts(globalRootDir, { platform, arch, fsImpl });
  const preflight = packagePreflight(initialFacts, cfg?.integrations?.ownership?.agentBrowser?.package);
  if (!preflight.ok) return { ok: false, changed: false, detail: preflight.detail };
  const converged = await convergePackage({
    facts: initialFacts, receiptState: preflight.receiptState, target, allowUpgrade,
    globalRootDir, platform, arch, fsImpl, runner,
  });
  if (!converged.ok) return converged;
  const verified = await verifyPackage(converged.facts, {
    target, installedByKit: converged.installedByKit, runner,
  });
  if (!verified.ok) return { ...verified, changed: converged.changed };
  if (converged.installedByKit || preflight.receiptState === 'legacy') {
    receiptInstalledPackage(cfg, converged.facts);
  }
  return { ok: true, changed: converged.changed, facts: converged.facts };
}

function successfulEnsureResult(version, packageChanged, configured, payload) {
  const changed = packageChanged || configured.changed || payload.changed;
  if (!configured.ok) return { ...configured, changed };
  if (!payload.ok) return { ...payload, changed, usable: true };
  const detail = payload.detail ?? (payload.ready
    ? `agent-browser ${version} ready (${payload.browser.source})`
    : `agent-browser ${version} ready; no local Chrome payload detected`);
  return { ok: true, changed, usable: true, ready: payload.ready, detail };
}

export async function ensureAgentBrowser(cfg, {
  runner = run, globalRootDir = paths.globalRoot(), configFile = paths.agentBrowserConfigPath(),
  homeDir = paths.home, nodeVersion = process.versions.node,
  platform = process.platform, arch = process.arch, env = process.env, fsImpl = fs,
  installBrowser = true, allowUpgrade = true, systemChromeCandidates = undefined,
} = {}) {
  const activation = activationDecision(cfg, nodeVersion);
  if (activation.result) return activation.result;
  const packageResult = await ensureAgentBrowserPackage(cfg, {
    target: activation.target, allowUpgrade, runner, globalRootDir, platform, arch, fsImpl,
  });
  if (!packageResult.ok) return packageResult;
  const configured = ensureTrustedConfig(cfg, { configFile, fsImpl });
  if (!configured.ok) {
    return { ...configured, changed: packageResult.changed || configured.changed };
  }
  const payload = await ensureBrowserPayload(packageResult.facts, {
    homeDir, platform, arch, env, fsImpl, runner, installBrowser, systemChromeCandidates,
  });
  return successfulEnsureResult(packageResult.facts.version, packageResult.changed, configured, payload);
}

export async function removeManagedAgentBrowser(cfg, {
  runner = run, globalRootDir = paths.globalRoot(), platform = process.platform,
  arch = process.arch, fsImpl = fs, configFile = paths.agentBrowserConfigPath(),
} = {}) {
  const ownership = cfg?.integrations?.ownership?.agentBrowser;
  const facts = packageFacts(globalRootDir, { platform, arch, fsImpl });
  if (!ownership?.package) {
    const config = removeManagedAgentBrowserConfig(cfg, { configFile, fsImpl });
    return {
      ...config,
      detail: `agent-browser package preserved (not Kit-owned); ${config.detail}`,
    };
  }
  if (receiptState(ownership.package, facts) !== 'current') {
    return { ok: false, changed: false, detail: 'agent-browser package drifted; ownership receipt retained and package preserved' };
  }
  const removed = await runner('npm', ['uninstall', '-g', AGENT_BROWSER_PACKAGE], { timeout: 300_000 });
  if (removed.code !== 0 || packageFacts(globalRootDir, { platform, arch, fsImpl }).present) {
    return { ok: false, changed: false, detail: 'agent-browser package removal could not be verified; receipt retained' };
  }
  delete ownership.package;
  if (ownership.config?.owner === 'agentic-kit'
    && ownership.config.written?.sha256 === fileHash(configFile, fsImpl)) {
    fsImpl.rmSync(configFile, { force: true });
    delete ownership.config;
  }
  if (!Object.keys(ownership).length) delete cfg.integrations.ownership.agentBrowser;
  return { ok: true, changed: true, detail: 'Kit-owned agent-browser package removed; browser/session/profile data preserved' };
}

export function removeManagedAgentBrowserConfig(cfg, {
  configFile = paths.agentBrowserConfigPath(), fsImpl = fs,
} = {}) {
  const ownership = cfg?.integrations?.ownership?.agentBrowser;
  const receipt = ownership?.config;
  if (!receipt) return { ok: true, changed: false, detail: 'managed agent-browser config absent' };
  const currentHash = fileHash(configFile, fsImpl);
  if (currentHash && (receipt.owner !== 'agentic-kit'
    || receipt.written?.sha256 !== currentHash
    || path.resolve(receipt.written?.path ?? '') !== path.resolve(configFile))) {
    return { ok: false, changed: false, detail: 'agent-browser config drifted; preserved with receipt' };
  }
  if (currentHash) fsImpl.rmSync(configFile, { force: true });
  delete ownership.config;
  if (!Object.keys(ownership).length) delete cfg.integrations.ownership.agentBrowser;
  return { ok: true, changed: !!currentHash, detail: 'managed agent-browser MCP config removed' };
}
