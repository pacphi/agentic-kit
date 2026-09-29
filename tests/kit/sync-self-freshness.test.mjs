// Exercise the real self-status collector and sync planner against isolated
// cache/package files; replace only registry I/O and the package install step.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxHome, assertSandboxed, writeKitConfig, offlineKitConfig, captureLog, rmrf } from './helpers/home-sandbox.mjs';
import { isolateProject } from './helpers/project-isolation.mjs';

const home = sandboxHome('ak-sync-self');
after(() => rmrf(home));
const paths = await import('../../src/lib/paths.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
const sync = await import('../../src/commands/sync.mjs');
const selfSection = (await import('../../src/commands/status/sections/self.mjs')).default;
const { selfDrift, KIT_PKG } = await import('../../src/lib/versions.mjs');
assertSandboxed(paths, home);
isolateProject('ak-sync-self-freshness');
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

test('no-upgrade does not force registry refresh or change the fresh self cache', async () => {
  seed();
  const before = fs.readFileSync(paths.kitConfigPath(), 'utf8');
  let lookups = 0;
  const { result } = await run({ flags: flags({ 'no-upgrade': true }), fetchLatest: async () => { lookups++; return '4.0.0-alpha.50'; } });
  assert.equal(result, 0);
  assert.equal(lookups, 0);
  assert.equal(fs.readFileSync(paths.kitConfigPath(), 'utf8'), before);
});

test('dry-run looks the kit up online and plans the self-update, but leaves the fresh self cache unchanged', async () => {
  seed();
  const before = fs.readFileSync(paths.kitConfigPath(), 'utf8');
  const tags = [];
  const { result, out } = await run({
    flags: flags({ 'dry-run': true }),
    fetchLatest: async (pkg, tag) => { if (pkg === KIT_PKG) tags.push(tag); return pkg === KIT_PKG ? '4.0.0-alpha.50' : null; },
    releaseDatesRunner: async () => ({ code: 1, stdout: '', stderr: '' }),
  });
  assert.equal(result, 0);
  assert.deepEqual(tags, ['latest', 'next']);
  assert.match(out, /\[self\].*kit 4\.0\.0-alpha\.49 installed, 4\.0\.0-alpha\.50 available/);
  assert.equal(fs.readFileSync(paths.kitConfigPath(), 'utf8'), before);
});

test('stable installations refresh only latest and do not enter the prerelease channel', async () => {
  seed('4.0.0');
  const tags = [];
  await run({ fetchLatest: async (pkg, tag) => {
    if (pkg === KIT_PKG) tags.push(tag);
    return pkg === KIT_PKG ? '4.0.0' : '9.9.9';
  } });
  assert.deepEqual(tags, ['latest']);
});

test('failed forced self lookups preserve known updates and restamp last, keeping when the update was seen', async () => {
  seed();
  const cfg = loadKitConfig();
  cfg.versionCheck.self = { last: 1, best: { version: '4.0.0-alpha.50', tag: 'next' } };
  writeKitConfig(home, cfg);
  const result = await selfDrift({ pkgRoot, force: true, fetchLatest: async () => null });
  assert.equal(result.latest, '4.0.0-alpha.50');
  assert.equal(result.outdated, true);
  const saved = loadKitConfig().versionCheck.self;
  assert.deepEqual(saved.best, { version: '4.0.0-alpha.50', tag: 'next' });
  assert.ok(saved.last > 1, 'the next lookup waits one TTL window');
  assert.equal(saved.observedAt, 1);
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

test('partial self answers retry once per TTL without renewing the cached observation', async t => {
  seed();
  const cfg = loadKitConfig();
  cfg.versionCheck.self = { last: 100, observedAt: 80, best: { version: '4.0.0-alpha.50', tag: 'next' } };
  writeKitConfig(home, cfg);
  let now = 200_000_000;
  t.mock.method(Date, 'now', () => now);
  const tags = [];
  const fetchLatest = async (_pkg, tag) => { tags.push(tag); return tag === 'latest' ? '4.0.0-alpha.0' : null; };
  const first = await selfDrift({ pkgRoot, fetchLatest });
  assert.deepEqual([first.latest, first.tag], ['4.0.0-alpha.50', 'next']);
  assert.deepEqual(loadKitConfig().versionCheck.self, {
    last: 100, observedAt: 80, best: { version: '4.0.0-alpha.50', tag: 'next' },
    attempt: { at: now, tags: ['latest', 'next'] },
  });
  const afterFirst = fs.readFileSync(paths.kitConfigPath(), 'utf8');
  now += 1000;
  assert.equal((await selfDrift({ pkgRoot, fetchLatest })).latest, first.latest);
  assert.deepEqual(tags, ['latest', 'next']);
  assert.equal(fs.readFileSync(paths.kitConfigPath(), 'utf8'), afterFirst);
  await selfDrift({ pkgRoot, force: true, fetchLatest });
  assert.deepEqual(tags, ['latest', 'next', 'latest', 'next']);
  now += 24 * 3600_000;
  await selfDrift({ pkgRoot, fetchLatest });
  assert.deepEqual(tags, ['latest', 'next', 'latest', 'next', 'latest', 'next']);
  assert.equal(loadKitConfig().versionCheck.self.observedAt, 80);
  now += 1000;
  const recovered = await selfDrift({ pkgRoot, force: true, fetchLatest: async (_pkg, tag) =>
    tag === 'next' ? '4.0.0-alpha.51' : null });
  assert.equal(recovered.latest, '4.0.0-alpha.51');
  assert.deepEqual(loadKitConfig().versionCheck.self,
    { last: now, observedAt: now, best: { version: '4.0.0-alpha.51', tag: 'next' } });
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

test('a stable install whose record holds only a next-channel candidate is not rewritten on every offline lookup', async (t) => {
  seed('4.0.0');
  const cfg = loadKitConfig();
  cfg.versionCheck.self = { last: 1, best: { version: '5.0.0-alpha.1', tag: 'next' } };
  writeKitConfig(home, cfg);
  let now = Date.now();
  t.mock.method(Date, 'now', () => (now += 1000)); // each call would restamp a different time
  let text = fs.readFileSync(paths.kitConfigPath(), 'utf8');
  let writes = 0;
  for (let i = 0; i < 3; i += 1) {
    const result = await selfDrift({ pkgRoot, fetchLatest: async () => null });
    assert.equal(result.latest, null, 'a next-channel candidate never reaches a stable install');
    const after = fs.readFileSync(paths.kitConfigPath(), 'utf8');
    if (after !== text) writes += 1;
    text = after;
  }
  assert.ok(writes <= 1, `${writes} kit.json writes for 3 offline lookups`);
  assert.deepEqual(loadKitConfig().versionCheck.self.best, { version: '5.0.0-alpha.1', tag: 'next' });
});

test('offline self attempts are scoped to tags and do not persist in read-only modes', async t => {
  seed('4.0.0');
  const cfg = loadKitConfig();
  cfg.versionCheck.self = { last: 100, observedAt: 80, best: { version: '5.0.0-alpha.1', tag: 'next' } };
  writeKitConfig(home, cfg);
  let now = 200_000_000;
  t.mock.method(Date, 'now', () => now);
  const tags = [];
  const fetchLatest = async (_pkg, tag) => { tags.push(tag); return null; };
  assert.equal((await selfDrift({ pkgRoot, fetchLatest })).latest, null);
  assert.deepEqual(loadKitConfig().versionCheck.self, {
    last: 100, observedAt: 80, best: { version: '5.0.0-alpha.1', tag: 'next' },
    attempt: { at: now, tags: ['latest'] },
  });
  const afterFirst = fs.readFileSync(paths.kitConfigPath(), 'utf8');
  await selfDrift({ pkgRoot, fetchLatest });
  assert.deepEqual(tags, ['latest']);
  assert.equal(fs.readFileSync(paths.kitConfigPath(), 'utf8'), afterFirst);
  await selfDrift({ pkgRoot, force: true, fetchLatest });
  assert.deepEqual(tags, ['latest', 'latest']);
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: KIT_PKG, version: '4.0.0-alpha.1' }));
  await selfDrift({ pkgRoot, fetchLatest });
  assert.deepEqual(tags, ['latest', 'latest', 'latest', 'next'], 'the untried channel is probed');
  const beforeReadOnly = fs.readFileSync(paths.kitConfigPath(), 'utf8');
  await selfDrift({ pkgRoot, force: true, record: false, fetchLatest });
  assert.deepEqual(tags.slice(-2), ['latest', 'next']);
  assert.equal(fs.readFileSync(paths.kitConfigPath(), 'utf8'), beforeReadOnly);
  await selfDrift({ pkgRoot, force: true, cacheOnly: true, fetchLatest });
  assert.equal(fs.readFileSync(paths.kitConfigPath(), 'utf8'), beforeReadOnly);
  assert.equal(tags.length, 6);
  now += 24 * 3600_000;
  await selfDrift({ pkgRoot, fetchLatest });
  assert.equal(tags.length, 8);
});

test('malformed self attempt stamps cannot suppress an offline retry', async t => {
  seed('4.0.0');
  const cfg = loadKitConfig();
  cfg.versionCheck.self = {
    last: 100, best: { version: '5.0.0-alpha.1', tag: 'next' },
    attempt: { at: Number.MAX_SAFE_INTEGER, tags: ['latest'] },
  };
  writeKitConfig(home, cfg);
  t.mock.method(Date, 'now', () => 200_000_000);
  let calls = 0;
  await selfDrift({ pkgRoot, fetchLatest: async () => { calls += 1; return null; } });
  assert.equal(calls, 1);
  assert.deepEqual(loadKitConfig().versionCheck.self.attempt, { at: 200_000_000, tags: ['latest'] });
  for (const attempt of [
    { at: '200000000', tags: ['latest'] },
    { at: 200_000_000.5, tags: ['latest'] },
    { at: 200_000_000, tags: ['next'] },
    { at: 200_000_000, tags: 'latest' },
  ]) {
    const next = loadKitConfig();
    next.versionCheck.self.attempt = attempt;
    writeKitConfig(home, next);
    await selfDrift({ pkgRoot, fetchLatest: async () => { calls += 1; return null; } });
  }
  assert.equal(calls, 5);
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
