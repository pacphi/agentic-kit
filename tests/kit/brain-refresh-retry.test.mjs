import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sandboxHome, assertSandboxed, sandboxProject, writeKitConfig, offlineKitConfig, captureLog, spawnEnv, rmrf } from './helpers/home-sandbox.mjs';
import { isolateProject } from './helpers/project-isolation.mjs';

const home = sandboxHome('ak-brain-retry');
after(() => rmrf(home));
isolateProject('ak-brain-retry-cwd');
const paths = await import('../../src/lib/paths.mjs');
const brain = await import('../../src/lib/ruvnet-brain.mjs');
const { brainReleaseRow } = await import('../../src/commands/status/sections/ruvnet-brain.mjs');
const sync = await import('../../src/commands/sync.mjs');
const status = await import('../../src/commands/status.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
assertSandboxed(paths, home);
assert.ok(paths.codexConfigPath().startsWith(home + path.sep));
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bin = path.join(pkgRoot, 'bin', 'agentic-kit.mjs');
const flags = { 'dry-run': true, 'no-upgrade': false, 'retry-brain': true, yes: true, json: false,
  skip: ['versions', 'self', 'ruvector', 'codex-mcp', 'host-alignment'] };

function seed(managed = true) {
  writeKitConfig(home, offlineKitConfig({ ruvnetBrain: managed, aqe: false }));
}

test('retry cannot override no-upgrade, explicit skip or disabled Brain management', async () => {
  for (const variation of [{ 'no-upgrade': true }, { skip: ['ruvnet-brain'] }, { disabled: true }]) {
    seed(!variation.disabled);
    const result = await captureLog(() => sync.run({ flags: { ...flags, ...variation }, pkgRoot,
      collectFn: async () => [], refreshHosts: async () => {}, fetchLatest: async () => null }));
    assert.equal(result.result, 2);
    assert.match(result.out, /retry-brain/);
  }
});

test('CLI help exposes the one-shot retry directly without reviving a retired command', () => {
  const help = execFileSync(process.execPath, [bin, 'sync', '--help'], { env: spawnEnv(home), encoding: 'utf8' });
  assert.match(help, /--retry-brain/);
  assert.match(help, /one.*attempt|once|one-shot/i);
});

test('CLI rejects conflicting retry flags as one JSON usage result before any install', () => {
  seed();
  let output;
  try {
    output = execFileSync(process.execPath, [bin, 'sync', '--retry-brain', '--no-upgrade', '--json'],
      { env: spawnEnv(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    assert.equal(error.status, 2);
    output = error.stdout;
  }
  const result = JSON.parse(output);
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /no-upgrade/);
});

test('retry preview exposes the action without clearing the stored hold', async () => {
  seed();
  const kb = path.join(home, 'preview-kb');
  process.env.RUVNET_BRAIN_KB = kb;
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), '');
  fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ releaseTag: 'v4.3.22' }));
  brain.recordHeldRefresh({ latest: '4.3.28', detail: 'still refused' });
  const before = fs.readFileSync(paths.kitConfigPath());
  const held = await brain.drift({ cacheOnly: true });
  held.latest = '4.3.28';
  held.outdated = true;
  held.releaseAssetAvailable = true;
  const result = await captureLog(() => sync.run({ flags, pkgRoot, refreshHosts: async () => {},
    fetchLatest: async () => null, brainDrift: async () => held,
    collectFn: async ({ retryBrain }) => [brainReleaseRow(held, { retry: retryBrain })] }));
  assert.match(result.out, /sync plan/);
  assert.match(result.out, /sync refreshes the KB/);
  assert.deepEqual(fs.readFileSync(paths.kitConfigPath()), before);
});

test('real status collector threads retry without bypassing KB and asset safety', async () => {
  seed();
  const observation = { present: true, kbState: 'present', installedRelease: '4.3.22', latest: '4.3.28',
    outdated: true, releaseAssetAvailable: true,
    heldRefresh: { installed: '4.3.22', latest: '4.3.28', at: Date.now(), detail: 'refused' } };
  const options = { pkgRoot, record: false, versionEvidence: { brain: observation, drift: [] } };
  const ordinary = (await status.collect(options)).find((row) => row.subsystem === 'ruvnet-brain');
  const retry = (await status.collect({ ...options, retryBrain: true })).find((row) => row.subsystem === 'ruvnet-brain');
  assert.equal(ordinary.repair, 'manual');
  assert.equal(retry.repair, 'sync');
  for (const variation of [{ kbState: 'unknown' }, { releaseAssetAvailable: false }, { releaseAssetAvailable: null }]) {
    const blocked = (await status.collect({ ...options, retryBrain: true,
      versionEvidence: { brain: { ...observation, ...variation }, drift: [] } })).find((row) => row.subsystem === 'ruvnet-brain');
    assert.notEqual(blocked.repair, 'sync');
  }
});

test('one explicit retry refuses once, preserves the new hold and does not retry on the next ordinary sync', {
  skip: process.platform === 'win32' ? 'POSIX npx fixture; policy and preview tests run cross-platform' : false,
}, async () => {
  seed();
  const project = sandboxProject('ak-brain-retry-project');
  const kb = path.join(home, 'apply-kb');
  const fakeBin = path.join(home, 'fakebin');
  const log = path.join(home, 'installer.log');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'npx'), `#!/bin/sh\necho attempt >> "${log}"\necho "install stopped: private overlay refusal" >&2\nexit 1\n`, { mode: 0o755 });
  fs.mkdirSync(kb, { recursive: true });
  for (const file of ['forge-mcp-all.mjs', 'forge-update.mjs']) fs.writeFileSync(path.join(kb, file), '');
  fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ releaseTag: 'v4.3.22' }));
  const prior = { path: process.env.PATH, kb: process.env.RUVNET_BRAIN_KB, fetch: globalThis.fetch, cwd: process.cwd() };
  process.env.PATH = `${fakeBin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  process.env.RUVNET_BRAIN_KB = kb;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    tag_name: 'v4.3.28', assets: [{ name: 'ruvnet-brain.zip', browser_download_url: 'fixture' }],
  }) });
  process.chdir(project);
  try {
    brain.recordHeldRefresh({ latest: '4.3.28', detail: 'initial refusal' });
    const collectFn = async ({ retryBrain }) => [brainReleaseRow(await brain.drift({ cacheOnly: true }), { retry: retryBrain })];
    const options = { pkgRoot, fetchLatest: async () => null, refreshHosts: async () => {}, collectFn };
    const first = await captureLog(() => sync.run({ ...options, flags: { ...flags, 'dry-run': false } }));
    assert.equal(first.result, 1);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
    assert.match(loadKitConfig().versionCheck.ruvnetBrain.heldRefresh.detail, /private overlay refusal/);
    assert.equal(brainReleaseRow(await brain.drift({ cacheOnly: true })).repair, 'manual');
    const second = await captureLog(() => sync.run({ ...options, flags: { ...flags, 'dry-run': false, 'retry-brain': false } }));
    assert.equal(second.result, 0);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
  } finally {
    process.chdir(prior.cwd);
    process.env.PATH = prior.path;
    process.env.RUVNET_BRAIN_KB = prior.kb;
    globalThis.fetch = prior.fetch;
    rmrf(project);
  }
});
