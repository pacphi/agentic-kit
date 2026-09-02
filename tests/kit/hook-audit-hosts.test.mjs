import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign as signEd25519 } from 'node:crypto';

import { run as runAuditCommand } from '../../src/commands/audit.mjs';
import { auditCodexHooks } from '../../src/lib/hook-audit/index.mjs';
import { auditHooks } from '../../src/lib/hook-audit/orchestrator.mjs';
import { normalizedOccurrence, readBoundedFile } from '../../src/lib/hook-audit/common.mjs';
import { auditClaudeHooks } from '../../src/lib/hook-audit/providers/claude.mjs';

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-host-hooks-'));
  return {
    root,
    project: path.join(root, 'project'),
    codex: path.join(root, 'codex'),
    claude: path.join(root, 'claude'),
    opencode: path.join(root, 'opencode'),
  };
}

function externalManifest() {
  return {
    name: 'hermes', version: '1.0.0', contract: 1,
    host: {
      id: 'hermes', label: 'Hermes',
      install: { bin: 'hermes', externalInstallPolicy: 'detect-never-overwrite' },
      capabilities: {
        canDriveSession: true, canBePrimary: false, canRouteActivities: true,
        commandStatusline: false, transcripts: true, usage: false,
        nativeMcpConfig: false, nativeGuidance: false,
      },
      trust: { approvalPolicy: 'unchanged', changes: [] }, enabledByDefault: false,
      configProjection: 'ruflo', observability: [],
    },
    detection: { bin: 'hermes', versionArgs: ['--version'], versionPattern: '\\d+\\.\\d+\\.\\d+' },
    driving: { surfaces: ['acp'] },
    trust: { changes: [{
      id: 'hermes-hooks', kind: 'third-party-adapter', scope: 'project', owner: 'hermes',
      value: 'subprocess hooks', effect: 'run consented lifecycle hooks',
    }] },
    lifecycle: { detect: { hook: { command: ['hermes', 'detect'], timeoutMs: 5000 } } },
  };
}

function aqeShimSource() {
  return `
const path = require('node:path');
const PROJECT = process.env.CLAUDE_PROJECT_DIR || '.';
const args = process.argv.slice(2);
const candidates = [
  path.join(PROJECT, 'node_modules', 'agentic-qe', 'dist', 'cli', 'bundle.js'),
  path.join(PROJECT, 'dist', 'cli', 'bundle.js'),
];
let cmdArgs;
if (!candidates.some(() => false)) {
  cmdArgs = ['-y', '--prefer-offline', 'agentic-qe', 'hooks', ...args];
}
`;
}

function rufloAutoMemorySource() {
  return `
const log = (msg) => console.log('[AutoMemory] ' + msg);
const success = (msg) => console.log('[AutoMemory] ' + msg);
async function doSync() { log('Syncing insights to auto memory files...'); success('Synced'); }
const command = process.argv[2] || 'status';
switch (command) { case 'sync': await doSync(); break; }
process.exit(0);
`;
}

function signedRufloManifest(helper, { digest = null, signature = null } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const manifest = {
    version: '3.38.20',
    files: { 'auto-memory-hook.mjs': digest ?? createHash('sha256').update(helper).digest('hex') },
  };
  const bytes = Buffer.from(JSON.stringify({ version: manifest.version, files: manifest.files }), 'utf8');
  return {
    document: {
      manifest,
      signature: signature ?? signEd25519(null, bytes, privateKey).toString('base64'),
      algorithm: 'ed25519',
    },
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

test('host-neutral audit reports each provider and never proposes automatic trust or execution', () => {
  const fx = fixture();
  try {
    write(path.join(fx.codex, 'hooks.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node stop.cjs' }] }] } });
    write(path.join(fx.claude, 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node stop.cjs', timeout: 3000 }] }] } });
    write(path.join(fx.opencode, 'opencode.json'), { plugin: ['example-plugin@1.0.0'] });
    write(path.join(fx.opencode, 'plugins', 'local.js'), 'export const Local = async () => ({ "tool.execute.before": async () => {} });\n');
    const manifest = path.join(fx.root, 'hermes.json');
    write(manifest, externalManifest());

    const report = auditHooks({
      hosts: ['all'], projectRoots: [fx.project],
      versions: { codex: '0.151.0', claude: '2.1.258', opencode: '1.18.25' },
      config: { hostAdapters: [{ name: 'hermes', source: manifest, contract: 1 }] },
      codex: { codexHome: fx.codex, pluginCacheDir: path.join(fx.codex, 'plugins', 'cache') },
      claude: { claudeRoot: fx.claude, managedSettingsFile: null },
      opencode: { opencodeRoot: fx.opencode },
    });

    assert.deepEqual(report.hosts, ['codex', 'claude', 'opencode', 'external']);
    assert.equal(report.reports.codex.records.length, 1);
    assert.equal(report.reports.claude.records.length, 1);
    assert.equal(report.reports.opencode.records.length, 2);
    assert.equal(report.reports.external.records.length, 1);
    assert.equal(report.summary.automaticActions, 0);
    assert.ok(Object.values(report.reports).every((host) => host.mode === 'read-only'));
    assert.ok(Object.values(report.reports).flatMap((host) => host.records).every((record) => record.trust.observedState === 'unknown'));
    assert.equal(report.upstream.status, 'valid');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Codex discovers inline TOML and preserves MCP handler identity', () => {
  const fx = fixture();
  try {
    write(path.join(fx.codex, 'config.toml'), `[[hooks.PostToolUse]]
matcher = "^apply_patch$"

[[hooks.PostToolUse.hooks]]
type = "mcp_tool"
server = "scanner"
tool = "scan_patch"
input = {"path":"\${tool_input.file_path}"}
timeout = 30
statusMessage = "Scanning"
`);
    const report = auditCodexHooks({
      codexHome: fx.codex, projectRoots: [], pluginCacheDir: path.join(fx.codex, 'plugins', 'cache'), codexVersion: '0.151.0',
    });
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0].type, 'mcp_tool');
    assert.equal(report.records[0].timeout.effective, 30);
    assert.match(report.records[0].source.file, /config\.toml/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Codex inventories valid inline plugin hooks and refuses symlinked manifests', (t) => {
  const fx = fixture();
  try {
    write(path.join(fx.codex, 'config.toml'), '[plugins."inline@test"]\nenabled = true\n');
    const plugin = path.join(fx.codex, 'plugins', 'cache', 'test', 'inline', '1.0.0');
    write(path.join(plugin, '.codex-plugin', 'plugin.json'), {
      name: 'inline', version: '1.0.0', hooks: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node inline.cjs' }] }] } },
    });
    let report = auditCodexHooks({ codexHome: fx.codex, projectRoots: [], pluginCacheDir: path.join(fx.codex, 'plugins', 'cache'), codexVersion: '0.151.0' });
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0].scope.kind, 'plugin-cache-inline');

    const manifest = path.join(plugin, '.codex-plugin', 'plugin.json');
    const actual = path.join(fx.root, 'manifest.json');
    fs.renameSync(manifest, actual);
    try { fs.symlinkSync(actual, manifest); } catch (error) {
      if (error.code === 'EPERM') { t.skip('file symlinks unavailable'); return; }
      throw error;
    }
    report = auditCodexHooks({ codexHome: fx.codex, projectRoots: [], pluginCacheDir: path.join(fx.codex, 'plugins', 'cache'), codexVersion: '0.151.0' });
    assert.equal(report.records.length, 0);
    assert.match(report.pluginIssues[0], /non-symlink/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('public command text redacts credential assignments while fingerprints remain deterministic', () => {
  const fx = fixture();
  try {
    write(path.join(fx.codex, 'hooks.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'API_TOKEN=super-secret node stop.cjs' }] }] } });
    const options = { codexHome: fx.codex, projectRoots: [], pluginCacheDir: path.join(fx.codex, 'plugins', 'cache'), codexVersion: '0.151.0' };
    const first = auditCodexHooks(options);
    const second = auditCodexHooks(options);
    assert.doesNotMatch(JSON.stringify(first), /super-secret/);
    assert.equal(first.records[0].behaviorFingerprint, second.records[0].behaviorFingerprint);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('unverified newer Codex versions do not inherit the 0.151 timeout profile', () => {
  const fx = fixture();
  try {
    write(path.join(fx.codex, 'hooks.json'), { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node end.cjs', timeout: 5 }] }] } });
    const report = auditCodexHooks({ codexHome: fx.codex, projectRoots: [], pluginCacheDir: path.join(fx.codex, 'plugins', 'cache'), codexVersion: '0.152.0' });
    assert.equal(report.hostSchema.confidence, 'syntax-only');
    assert.equal(report.records[0].timeout.effective, null);
    assert.equal(report.plan.length, 0);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Codex profiles are exact and future syntax remains observable without optimistic validation', () => {
  const fx = fixture();
  try {
    write(path.join(fx.codex, 'hooks.json'), {
      hooks: {
        FutureEvent: [{ hooks: [{ type: 'future_handler', futureField: true }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'node end.cjs', timeout: 5 }] }],
      },
    });
    const report = auditCodexHooks({
      codexHome: fx.codex,
      projectRoots: [],
      pluginCacheDir: path.join(fx.codex, 'plugins', 'cache'),
      codexVersion: '0.151.999',
    });
    assert.equal(report.hostSchema.confidence, 'syntax-only');
    assert.equal(report.summary.invalidSources, 0);
    assert.equal(report.records.length, 2);
    assert.equal(report.plan.length, 0);
    assert.ok(report.records.every((record) => record.timeout.effective === null));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Codex attributes exact Ruflo AutoMemory Stop stdout incompatibility without patch authority', () => {
  const fx = fixture();
  try {
    const helper = rufloAutoMemorySource();
    const helperDigest = createHash('sha256').update(helper).digest('hex');
    const signed = signedRufloManifest(helper);
    write(path.join(fx.project, '.codex', 'hooks.json'), {
      hooks: { Stop: [{ hooks: [{
        type: 'command',
        command: 'sh -c \'D="${CLAUDE_PROJECT_DIR:-.}"; exec node "$D/.claude/helpers/auto-memory-hook.mjs" sync\'',
        timeout: 10000,
      }] }] },
    });
    write(path.join(fx.project, '.claude', 'helpers', 'auto-memory-hook.mjs'), helper);
    write(path.join(fx.project, '.claude', 'helpers', 'helpers.manifest.json'), signed.document);

    const report = auditCodexHooks({
      codexHome: fx.codex, projectRoots: [fx.project],
      pluginCacheDir: path.join(fx.codex, 'plugins', 'cache'), codexVersion: '0.152.1',
      rufloHelpersPublicKey: signed.publicKey,
    });
    assert.equal(report.records.length, 1);
    const diagnostic = report.records[0].diagnostics.find(
      (item) => item.code === 'ruflo-codex-stop-output-not-json',
    );
    assert.equal(diagnostic.evidence.generatorVersion, '3.38.20');
    assert.equal(diagnostic.evidence.helperDigest, helperDigest);
    assert.equal(diagnostic.evidence.signatureVerified, true);
    const action = report.plan.find((item) => item.diagnostic === diagnostic.code);
    assert.equal(action.classification, 'upstream-required');
    assert.equal(action.upstream.dependency, 'ruflo');
    assert.equal(action.upstream.owner, 'ruvnet/ruflo');
    assert.equal(report.summary.automaticActions, 0);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Codex does not infer Ruflo ownership when the helper manifest digest does not match', () => {
  const fx = fixture();
  try {
    const helper = rufloAutoMemorySource();
    const signed = signedRufloManifest(helper, { digest: '0'.repeat(64) });
    write(path.join(fx.project, '.codex', 'hooks.json'), {
      hooks: { Stop: [{ hooks: [{
        type: 'command', command: 'node .claude/helpers/auto-memory-hook.mjs sync', timeout: 10,
      }] }] },
    });
    write(path.join(fx.project, '.claude', 'helpers', 'auto-memory-hook.mjs'), helper);
    write(path.join(fx.project, '.claude', 'helpers', 'helpers.manifest.json'), signed.document);
    const report = auditCodexHooks({
      codexHome: fx.codex, projectRoots: [fx.project],
      pluginCacheDir: path.join(fx.codex, 'plugins', 'cache'), codexVersion: '0.152.1',
      rufloHelpersPublicKey: signed.publicKey,
    });
    assert.ok(report.records[0].diagnostics.every(
      (item) => item.code !== 'ruflo-codex-stop-output-not-json',
    ));
    assert.ok(report.plan.every((item) => item.upstream?.dependency !== 'ruflo'));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Codex does not infer Ruflo ownership from an invalid helper manifest signature', () => {
  const fx = fixture();
  try {
    const helper = rufloAutoMemorySource();
    const signed = signedRufloManifest(helper, { signature: Buffer.alloc(64).toString('base64') });
    write(path.join(fx.project, '.codex', 'hooks.json'), {
      hooks: { Stop: [{ hooks: [{
        type: 'command', command: 'node .claude/helpers/auto-memory-hook.mjs sync', timeout: 10,
      }] }] },
    });
    write(path.join(fx.project, '.claude', 'helpers', 'auto-memory-hook.mjs'), helper);
    write(path.join(fx.project, '.claude', 'helpers', 'helpers.manifest.json'), signed.document);
    const report = auditCodexHooks({
      codexHome: fx.codex, projectRoots: [fx.project],
      pluginCacheDir: path.join(fx.codex, 'plugins', 'cache'), codexVersion: '0.152.1',
      rufloHelpersPublicKey: signed.publicKey,
    });
    assert.ok(report.records[0].diagnostics.every(
      (item) => item.code !== 'ruflo-codex-stop-output-not-json',
    ));
    assert.ok(report.plan.every((item) => item.upstream?.dependency !== 'ruflo'));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Codex does not apply the Stop output contract to another lifecycle event', () => {
  const fx = fixture();
  try {
    const helper = rufloAutoMemorySource();
    const signed = signedRufloManifest(helper);
    write(path.join(fx.project, '.codex', 'hooks.json'), {
      hooks: { PostToolUse: [{ hooks: [{
        type: 'command', command: 'node .claude/helpers/auto-memory-hook.mjs sync', timeout: 10,
      }] }] },
    });
    write(path.join(fx.project, '.claude', 'helpers', 'auto-memory-hook.mjs'), helper);
    write(path.join(fx.project, '.claude', 'helpers', 'helpers.manifest.json'), signed.document);
    const report = auditCodexHooks({
      codexHome: fx.codex, projectRoots: [fx.project],
      pluginCacheDir: path.join(fx.codex, 'plugins', 'cache'), codexVersion: '0.152.1',
      rufloHelpersPublicKey: signed.publicKey,
    });
    assert.ok(report.records[0].diagnostics.every(
      (item) => item.code !== 'ruflo-codex-stop-output-not-json',
    ));
    assert.ok(report.plan.every((item) => item.upstream?.dependency !== 'ruflo'));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('structured argv boundaries remain material to occurrence identity', () => {
  const source = {
    file: '/fixture/adapter.json', digest: 'a'.repeat(64), sourceKind: 'external-adapter-manifest',
    authority: 'operator-configured', generatedStatus: 'direct', owner: 'fixture', baseDir: '/fixture',
  };
  const first = normalizedOccurrence({
    host: 'fixture', event: 'execution.run', type: 'argv-subprocess',
    handler: { command: ['node', 'a b'] }, source,
  });
  const second = normalizedOccurrence({
    host: 'fixture', event: 'execution.run', type: 'argv-subprocess',
    handler: { command: ['node a', 'b'] }, source,
  });
  assert.notEqual(first.behaviorFingerprint, second.behaviorFingerprint);
  assert.notEqual(first.command.digest, second.command.digest);
});

test('duplicate Claude occurrences retain unique action ids and inline plugin ownership', () => {
  const fx = fixture();
  try {
    const plugin = path.join(fx.root, 'plugin');
    write(path.join(fx.claude, 'plugins', 'installed_plugins.json'), {
      plugins: {
        'fixture@test': [{ installPath: plugin, version: '1.0.0' }],
      },
    });
    write(path.join(plugin, '.claude-plugin', 'plugin.json'), {
      name: 'fixture',
      version: '1.0.0',
      hooks: {
        hooks: {
          SessionEnd: [{ hooks: [
            { type: 'command', command: 'node end.cjs', timeout: 5 },
            { type: 'command', command: 'node end.cjs', timeout: 5 },
          ] }],
        },
      },
    });
    const report = auditClaudeHooks({
      claudeRoot: fx.claude,
      projectRoots: [],
      managedSettingsFile: null,
      claudeVersion: '2.1.258',
    });
    assert.equal(report.records.length, 2);
    assert.equal(new Set(report.plan.map((action) => action.id)).size, 2);
    assert.ok(report.records.every((record) => record.source.generatedStatus === 'generated'));
    assert.ok(report.records.every((record) => record.source.authority === 'generated-runtime-copy'));
    assert.ok(report.plan.every((action) => action.classification === 'upstream-required'));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('bounded reads reject a source replaced between inspection and open', () => {
  const fx = fixture();
  const file = path.join(fx.root, 'hooks.json');
  const replacement = path.join(fx.root, 'replacement.json');
  write(file, { hooks: {} });
  write(replacement, { hooks: { Stop: [] } });
  const originalOpen = fs.openSync;
  let replaced = false;
  fs.openSync = function replaceBeforeOpen(target, ...args) {
    if (!replaced && target === file) {
      replaced = true;
      fs.renameSync(replacement, file);
    }
    return originalOpen.call(fs, target, ...args);
  };
  try {
    const result = readBoundedFile(file, fx.root);
    assert.equal(result.status, 'refused');
    assert.match(result.error, /identity changed/);
  } finally {
    fs.openSync = originalOpen;
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Codex-only command isolates version and config probes to the selected provider', async () => {
  const binaries = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const status = await runAuditCommand({
      flags: { host: ['codex'], project: [] },
      positionals: ['hooks'],
      detectVersionFn(binary) { binaries.push(binary); return 'unknown'; },
      loadConfigFn() { throw new Error('unrelated kit config must not be loaded'); },
    });
    assert.notEqual(status, 2);
    assert.deepEqual(binaries, ['codex']);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test('external audit loads adapter configuration without probing unrelated host binaries', async () => {
  const binaries = [];
  let configLoads = 0;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const status = await runAuditCommand({
      flags: { host: ['external'], project: [] },
      positionals: ['hooks'],
      detectVersionFn(binary) { binaries.push(binary); return 'unknown'; },
      loadConfigFn() { configLoads += 1; return { hostAdapters: [] }; },
    });
    assert.equal(status, 0);
    assert.deepEqual(binaries, []);
    assert.equal(configLoads, 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test('external audit refuses contract drift, name mismatch, and built-in shadowing before records', () => {
  const fx = fixture();
  try {
    const contractFile = path.join(fx.root, 'contract.json');
    const nameFile = path.join(fx.root, 'name.json');
    const builtinFile = path.join(fx.root, 'builtin.json');
    write(contractFile, externalManifest());
    write(nameFile, externalManifest());
    const builtin = externalManifest();
    builtin.name = 'codex';
    builtin.host.id = 'codex';
    write(builtinFile, builtin);
    const report = auditHooks({
      hosts: ['external'], projectRoots: [],
      config: { hostAdapters: [
        { name: 'hermes', source: contractFile, contract: 2 },
        { name: 'other', source: nameFile, contract: 1 },
        { name: 'codex', source: builtinFile, contract: 1 },
      ] },
    }).reports.external;
    assert.equal(report.records.length, 0);
    assert.equal(report.plan.length, 0);
    assert.equal(report.sources.filter((source) => source.status === 'inadmissible').length, 3);
    assert.match(report.issues.join('\n'), /contract-mismatch/);
    assert.match(report.issues.join('\n'), /name-mismatch/);
    assert.match(report.issues.join('\n'), /builtin-shadow/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('unknown Claude versions use structural-only validation and never remediation semantics', () => {
  const fx = fixture();
  try {
    write(path.join(fx.claude, 'settings.json'), {
      hooks: { FutureEvent: [{ matcher: { future: true }, hooks: [
        { futureShape: true }, { type: 'command', futureCommandField: ['future'] },
      ] }] },
    });
    const report = auditClaudeHooks({
      claudeRoot: fx.claude, projectRoots: [], managedSettingsFile: null, claudeVersion: '2.2.0',
    });
    assert.equal(report.hostSchema.confidence, 'syntax-only');
    assert.equal(report.sources[0].status, 'valid');
    assert.equal(report.plan.length, 0);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Claude plugin discovery preserves registry provenance and honors manifest-free default hooks', () => {
  const fx = fixture();
  try {
    const plugin = path.join(fx.claude, 'plugins', 'cache', 'market', 'demo', '1.0.0');
    write(path.join(fx.claude, 'plugins', 'installed_plugins.json'), {
      plugins: { 'demo@market': [{ installPath: plugin, version: '1.0.0' }] },
    });
    write(path.join(plugin, 'hooks', 'hooks.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node stop.cjs' }] }] },
    });
    const report = auditHooks({
      hosts: ['claude'], projectRoots: [], versions: { claude: '2.1.258' },
      claude: { claudeRoot: fx.claude, managedSettingsFile: null },
    });
    assert.deepEqual(report.reports.claude.sources.map((source) => source.kind), ['plugin-registry', 'plugin-cache']);
    assert.equal(report.reports.claude.records.length, 1);
    assert.equal(report.reports.claude.records[0].source.pluginRef, 'demo@market');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Claude SessionEnd reports settings clamping and plugin budget dependence separately', () => {
  const fx = fixture();
  try {
    write(path.join(fx.claude, 'settings.json'), {
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node user.cjs', timeout: 120 }] }] },
    });
    const plugin = path.join(fx.claude, 'plugins', 'cache', 'market', 'demo', '1.0.0');
    write(path.join(fx.claude, 'plugins', 'installed_plugins.json'), {
      plugins: { 'demo@market': [{ installPath: plugin, version: '1.0.0' }] },
    });
    write(path.join(plugin, 'hooks', 'hooks.json'), {
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node plugin.cjs', timeout: 10 }] }] },
    });
    const report = auditHooks({
      hosts: ['claude'], projectRoots: [], versions: { claude: '2.1.258' },
      claude: { claudeRoot: fx.claude, managedSettingsFile: null },
    }).reports.claude;
    const settingsHook = report.records.find((record) => record.source.sourceKind === 'global');
    const pluginHook = report.records.find((record) => record.source.sourceKind === 'plugin-cache');
    assert.equal(settingsHook.timeout.effective, 60);
    assert.equal(settingsHook.timeout.maximum, 60);
    assert.ok(settingsHook.diagnostics.some((item) => item.code === 'sessionend-timeout-clamped'));
    assert.equal(pluginHook.timeout.effective, null);
    assert.equal(pluginHook.timeout.status, 'plugin-session-budget-dependent');
    assert.ok(pluginHook.diagnostics.some((item) => item.code === 'plugin-sessionend-budget-not-raised'));
    assert.equal(report.plan.length, 2);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('exact AQE Stop projections report npx hot-path and millisecond-authored timeout upstream actions', () => {
  const fx = fixture();
  try {
    write(path.join(fx.project, '.claude', 'settings.json'), {
      hooks: { Stop: [{ hooks: [
        {
          type: 'command',
          command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/aqe-hook.cjs" session-end --save-state --json',
          timeout: 5000,
          continueOnError: true,
        },
        {
          type: 'command',
          command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/aqe-hook.cjs" post-route --success true --json',
          timeout: 5000,
          continueOnError: true,
        },
      ] }] },
    });
    write(path.join(fx.project, '.claude', 'hooks', 'aqe-hook.cjs'), aqeShimSource());

    const report = auditClaudeHooks({
      claudeRoot: fx.claude,
      projectRoots: [fx.project],
      managedSettingsFile: null,
      claudeVersion: '2.1.258',
    });

    assert.equal(report.records.length, 2);
    for (const record of report.records) {
      assert.ok(record.diagnostics.some((item) => item.code === 'aqe-npx-hot-path-fallback'));
      assert.ok(record.diagnostics.some((item) => item.code === 'aqe-claude-timeout-unit-mismatch'));
    }
    assert.equal(report.plan.length, 4);
    assert.ok(report.plan.every((action) => action.classification === 'upstream-required'));
    assert.ok(report.plan.every((action) => action.upstream?.dependency === 'agentic-qe'));
    assert.ok(report.plan.every((action) => action.upstream?.owner === 'proffesor-for-testing/agentic-qe'));
    assert.ok(report.plan.every((action) => action.upstream?.publication === 'explicit-user-approval-required'));
    assert.equal(report.summary.automaticActions, 0);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('AQE Stop signatures without the exact helper fallback do not invent npx ownership', () => {
  const fx = fixture();
  try {
    write(path.join(fx.project, '.claude', 'settings.json'), {
      hooks: { Stop: [{ hooks: [{
        type: 'command',
        command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/aqe-hook.cjs" session-end --json',
        timeout: 30,
      }] }] },
    });
    write(path.join(fx.project, '.claude', 'hooks', 'aqe-hook.cjs'), 'process.exit(0);\n');
    const report = auditClaudeHooks({
      claudeRoot: fx.claude, projectRoots: [fx.project], managedSettingsFile: null,
      claudeVersion: '2.1.258',
    });
    assert.ok(report.records.every((record) => !record.diagnostics.some(
      (item) => item.code === 'aqe-npx-hot-path-fallback',
    )));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('generated AQE plugin cache findings are upstream-only and never automatic', () => {
  const fx = fixture();
  try {
    const plugin = path.join(fx.claude, 'plugins', 'cache', 'market', 'aqe', '3.14.0');
    write(path.join(fx.claude, 'plugins', 'installed_plugins.json'), {
      plugins: { 'aqe@market': [{ installPath: plugin, version: '3.14.0' }] },
    });
    write(path.join(plugin, 'hooks', 'hooks.json'), {
      hooks: { Stop: [{ hooks: [{
        type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/.claude/hooks/aqe-hook.cjs" session-end --json', timeout: 5000,
      }] }] },
    });
    write(path.join(plugin, '.claude', 'hooks', 'aqe-hook.cjs'), aqeShimSource());

    const report = auditClaudeHooks({
      claudeRoot: fx.claude, projectRoots: [], managedSettingsFile: null,
      claudeVersion: '2.1.258',
    });
    assert.ok(report.records[0].diagnostics.some(
      (item) => item.code === 'aqe-claude-timeout-unit-mismatch',
    ));
    assert.ok(report.plan.length >= 1);
    assert.ok(report.plan.every((action) => action.classification === 'upstream-required'));
    assert.equal(report.summary.automaticActions, 0);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
