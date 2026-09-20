// Exercise the real self-status collector and sync planner against isolated
// cache/package files; replace only registry I/O and the package install step.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxHome, assertSandboxed, writeKitConfig, offlineKitConfig, captureLog } from './helpers/home-sandbox.mjs';

const home = sandboxHome('ak-sync-self');
const paths = await import('../../src/lib/paths.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
const sync = await import('../../src/commands/sync.mjs');
const selfSection = (await import('../../src/commands/status/sections/self.mjs')).default;
const { selfDrift, KIT_PKG } = await import('../../src/lib/versions.mjs');
assertSandboxed(paths, home);
const pkgRoot = path.join(home, 'installed-kit');
const project = path.join(home, 'project');
fs.mkdirSync(pkgRoot, { recursive: true });
fs.mkdirSync(project, { recursive: true });

function seed(version = '4.0.0-alpha.49') {
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: KIT_PKG, version }));
  const cfg = offlineKitConfig();
  cfg.versionCheck.self = { last: Date.now(), best: { version, tag: version.includes('-') ? 'next' : 'latest' } };
  writeKitConfig(home, cfg);
}
const flags = extra => ({ 'dry-run': false, 'no-upgrade': false, yes: true, json: false, ...extra });
async function run(options) {
  const previous = process.cwd(); process.chdir(project);
  try { return await captureLog(() => sync.run({ pkgRoot, flags: flags(),
    collectFn: args => selfSection.collect(args), ...options })); }
  finally { process.chdir(previous); }
}

test('normal sync discovers and schedules a self-update hidden by a fresh stale-version cache', async t => {
  seed();
  const lookups = [], installs = [];
  t.mock.method(sync.SYNC_STEPS.find(step => step.id === 'self'), 'run', async ctx => {
    const state = await selfDrift({ pkgRoot: ctx.pkgRoot });
    installs.push(state.latest);
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: KIT_PKG, version: state.latest }));
  });
  const { result, out } = await run({ fetchLatest: async (pkg, tag) => {
    lookups.push([pkg, tag]);
    return pkg === KIT_PKG ? (tag === 'next' ? '4.0.0-alpha.50' : '4.0.0-alpha.0') : '9.9.9';
  } });
  assert.equal(result, 0);
  assert.deepEqual(installs, ['4.0.0-alpha.50']);
  assert.match(out, /\[self\].*4\.0\.0-alpha\.50/);
  assert.deepEqual(lookups.filter(([pkg]) => pkg === KIT_PKG).map(([, tag]) => tag), ['latest', 'next']);
  assert.equal(loadKitConfig().versionCheck.self.best.version, '4.0.0-alpha.50');
});

for (const mode of ['dry-run', 'no-upgrade']) {
  test(`${mode} does not force registry refresh or change the fresh self cache`, async () => {
    seed();
    const before = fs.readFileSync(paths.kitConfigPath(), 'utf8');
    let lookups = 0;
    const { result } = await run({ flags: flags({ [mode]: true }), fetchLatest: async () => { lookups++; return '4.0.0-alpha.50'; } });
    assert.equal(result, 0);
    assert.equal(lookups, 0);
    assert.equal(fs.readFileSync(paths.kitConfigPath(), 'utf8'), before);
  });
}

test('stable installations refresh only latest and do not enter the prerelease channel', async () => {
  seed('4.0.0');
  const tags = [];
  await run({ fetchLatest: async (pkg, tag) => {
    if (pkg === KIT_PKG) tags.push(tag);
    return pkg === KIT_PKG ? '4.0.0' : '9.9.9';
  } });
  assert.deepEqual(tags, ['latest']);
});

test('failed forced self lookups preserve known updates and do not renew the cache TTL', async () => {
  seed();
  const cfg = loadKitConfig();
  cfg.versionCheck.self = { last: 1, best: { version: '4.0.0-alpha.50', tag: 'next' } };
  writeKitConfig(home, cfg);
  const before = fs.readFileSync(paths.kitConfigPath(), 'utf8');
  const result = await selfDrift({ pkgRoot, force: true, fetchLatest: async () => null });
  assert.equal(result.latest, '4.0.0-alpha.50');
  assert.equal(result.outdated, true);
  assert.equal(fs.readFileSync(paths.kitConfigPath(), 'utf8'), before);
});

test('a failed next lookup retains its cached candidate without claiming a fresh observation', async () => {
  seed();
  const cfg = loadKitConfig();
  cfg.versionCheck.self = { last: 1, best: { version: '4.0.0-alpha.50', tag: 'next' } };
  writeKitConfig(home, cfg);
  const result = await selfDrift({ pkgRoot, force: true, fetchLatest: async (_pkg, tag) => tag === 'latest' ? '4.0.0-alpha.0' : null });
  assert.equal(result.latest, '4.0.0-alpha.50');
  assert.equal(loadKitConfig().versionCheck.self.last, 1);
});

test('stable installs reject cached next-channel candidates when latest is unavailable', async () => {
  seed('4.0.0');
  const cfg = loadKitConfig();
  cfg.versionCheck.self.best = { version: '5.0.0-alpha.1', tag: 'next' };
  writeKitConfig(home, cfg);
  const tags = [];
  const result = await selfDrift({ pkgRoot, force: true, fetchLatest: async (_pkg, tag) => { tags.push(tag); return null; } });
  assert.deepEqual(tags, ['latest']);
  assert.equal(result.latest, null);
  assert.equal(result.outdated, false);
});

test('successful registry observations supersede cached versions even after a channel rollback', async () => {
  seed();
  const cfg = loadKitConfig();
  cfg.versionCheck.self.best = { version: '4.0.0-alpha.99', tag: 'next' };
  writeKitConfig(home, cfg);
  const result = await selfDrift({ pkgRoot, force: true, fetchLatest: async (_pkg, tag) => tag === 'next' ? '4.0.0-alpha.50' : '4.0.0-alpha.0' });
  assert.equal(result.latest, '4.0.0-alpha.50');
  assert.equal(loadKitConfig().versionCheck.self.best.version, '4.0.0-alpha.50');
});
