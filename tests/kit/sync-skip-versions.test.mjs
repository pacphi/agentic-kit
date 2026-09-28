// `ak sync --skip versions` (and `--skip self`, `--skip ruvnet-brain`,
// `--skip ruvector`) leaves that part's online version lookup out of the run as
// well (ADR-0063): the forced pre-plan lookup is not made, and the plan read and
// the converge proof use what ak recorded instead of fetching on an expired TTL.
// A sync that skips nothing still makes every forced lookup first.
//
// Every lookup path is observed: the forced lookups through the injected
// fetchLatest/releaseDatesRunner/brainDrift; the sections' own reads through a
// fake `npm` on PATH that logs its arguments (POSIX only), and a global `fetch`
// stub for the Brain's GitHub release lookup. The fakes answer a NEWER version
// for the part a test skips, so a lookup that leaked would record it and the
// byte comparison of that part's kit.json record would fail.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sandboxHome, assertSandboxed, captureLog, rmrf, sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';
import { isolateProject } from './helpers/project-isolation.mjs';

const HOME = sandboxHome('ak-sync-skip-versions');
const paths = await import('../../src/lib/paths.mjs');
const sync = await import('../../src/commands/sync.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
const { KIT_PKG } = await import('../../src/lib/versions.mjs');
const versionsSection = (await import('../../src/commands/status/sections/versions.mjs')).default;
const selfSection = (await import('../../src/commands/status/sections/self.mjs')).default;
const brainSection = (await import('../../src/commands/status/sections/ruvnet-brain.mjs')).default;
const ruvectorSection = (await import('../../src/commands/status/sections/ruvector.mjs')).default;
assertSandboxed(paths, HOME);
isolateProject('ak-sync-skip-versions');

const PROJECT = sandboxProject('ak-sync-skip-versions');
const PKG_ROOT = path.join(HOME, 'installed-kit');
const KB = path.join(HOME, 'brain-kb');
const POSIX = process.platform !== 'win32';
const TWO_DAYS_AGO = Date.now() - 48 * 3600_000;
const savedKb = process.env.RUVNET_BRAIN_KB;
process.env.RUVNET_BRAIN_KB = KB;
after(() => {
  if (savedKb === undefined) delete process.env.RUVNET_BRAIN_KB; else process.env.RUVNET_BRAIN_KB = savedKb;
  rmrf(HOME, PROJECT);
});

/** kit.json whose version caches all expired two days ago, so a plain read
 *  would fetch. `ruvector` also installs and registers a ruvector CLI. */
function seed({ ruvnetBrain = false, ruvector = false } = {}) {
  fs.mkdirSync(PKG_ROOT, { recursive: true });
  fs.writeFileSync(path.join(PKG_ROOT, 'package.json'), JSON.stringify({ name: KIT_PKG, version: '4.0.0' }));
  const cfg = offlineKitConfig({ ruvnetBrain });
  cfg.versionCheck = {
    ttlHours: 24,
    last: TWO_DAYS_AGO,
    seen: { ruflo: '9.9.9', 'agentic-qe': '9.9.9' },
    self: { last: TWO_DAYS_AGO, best: { version: '4.0.0', tag: 'latest' } },
    ruvnetBrain: { last: TWO_DAYS_AGO, latest: '4.3.28', releaseAssetAvailable: true },
    ruvector: { last: TWO_DAYS_AGO, latest: '1.5.0' },
  };
  writeKitConfig(HOME, cfg);
  const pkgs = { ruflo: '9.9.9', 'agentic-qe': '9.9.9', ...(ruvector ? { ruvector: '1.2.0' } : {}) };
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, pkgs));
  fs.mkdirSync(path.dirname(paths.claudeUserMcpPath()), { recursive: true });
  if (ruvector) {
    fs.writeFileSync(paths.claudeUserMcpPath(),
      JSON.stringify({ mcpServers: { ruvector: { command: 'npx', args: ['-y', 'ruvector', 'mcp', 'start'] } } }));
  } else {
    fs.rmSync(paths.claudeUserMcpPath(), { force: true });
  }
}

/** The bytes kit.json holds for the versions part: the whole version record
 *  but the kit's own (`self`), which a sync looks up unless --skip self. */
const versionsPartText = () => {
  const { self: _self, ...rest } = loadKitConfig().versionCheck;
  return JSON.stringify(rest);
};
/** The bytes kit.json holds for one part's version record. */
const recordText = (part) => JSON.stringify(loadKitConfig().versionCheck?.[part]);
const kitJsonText = () => fs.readFileSync(paths.kitConfigPath(), 'utf8');

const MARKER = {
  subsystem: 'sync-test-only-marker', level: 'warn', message: 'marker row', fix: 'no sync step performs this',
};

/** A collectFn that runs the four real version sections with the arguments
 *  sync passes, then plans one marker row that no step performs (so the apply
 *  phase does no work and the converge proof still runs). */
function versionSectionsCollect(calls) {
  return async (args) => {
    calls.push(args);
    const ctx = { ...args, cfg: loadKitConfig(), refresh: false };
    for (const section of [versionsSection, selfSection, brainSection, ruvectorSection]) await section.collect(ctx);
    return args.record ? [] : [MARKER];
  };
}

/** The versions the fakes answer: newer than what seed() recorded. */
const NEWER = { ruflo: '9.9.10', 'agentic-qe': '9.9.10', [KIT_PKG]: '4.1.0', ruvector: '1.6.0' };
const NEWER_BRAIN = { tag_name: 'v4.3.29', assets: [{ name: 'ruvnet-brain.zip', browser_download_url: 'x' }] };

/** Run `fn` with a fake `npm` on PATH that logs its arguments and answers
 *  `npm view <pkg>@latest version` for the packages in `answers` (any other
 *  call exits 1), and a recording `fetch` stub that answers `brainRelease`
 *  (or fails without one). */
async function observingLookups(fn, { answers = {}, brainRelease = null } = {}) {
  const bin = fs.mkdtempSync(path.join(HOME, 'fakebin-npm-'));
  const log = path.join(bin, 'npm.log');
  const cases = Object.entries(answers).map(([pkg, v]) => `  "view ${pkg}@latest version") echo ${v} ;;`);
  if (POSIX) {
    fs.writeFileSync(path.join(bin, 'npm'),
      ['#!/bin/sh', `echo "$*" >> "${log}"`, 'case "$*" in', ...cases, '  *) exit 1 ;;', 'esac', ''].join('\n'),
      { mode: 0o755 });
  }
  const fetched = [];
  const saved = { path: process.env.PATH, fetch: globalThis.fetch, cwd: process.cwd() };
  process.env.PATH = bin;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return brainRelease ? { ok: true, json: async () => brainRelease } : { ok: false, json: async () => ({}) };
  };
  process.chdir(PROJECT);
  try {
    const result = await fn();
    const npm = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return { ...result, npm, fetched };
  } finally {
    process.chdir(saved.cwd);
    process.env.PATH = saved.path;
    globalThis.fetch = saved.fetch;
  }
}

/** A real (or dry) sync with every lookup observed. The injected forced
 *  lookup answers `latest[pkg]` (null for a package not in it). */
function observedSync(flags, { latest = {}, ...fakes } = {}) {
  const calls = { fetchLatest: [], releaseDates: 0, brainDrift: [], collect: [] };
  return observingLookups(async () => {
    const { result, out } = await captureLog(() => sync.run({
      flags: { 'dry-run': false, 'no-upgrade': false, yes: true, json: false, ...flags },
      pkgRoot: PKG_ROOT,
      fetchLatest: async (pkg) => { calls.fetchLatest.push(pkg); return latest[pkg] ?? null; },
      releaseDatesRunner: async () => { calls.releaseDates += 1; return { code: 1, stdout: '', stderr: '' }; },
      brainDrift: async (opts) => { calls.brainDrift.push(opts); return {}; },
      refreshHosts: async () => {},
      collectFn: versionSectionsCollect(calls.collect),
    }));
    return { result, out, calls };
  }, fakes);
}

const npmViews = (npm, pkg) => npm.filter((line) => line.startsWith(`view ${pkg}@`));

test('--skip versions makes no forced or plan-time lookup for ruflo/agentic-qe and records nothing', async () => {
  seed();
  const before = versionsPartText();
  const selfBefore = loadKitConfig().versionCheck.self;
  // Newer ruflo/agentic-qe everywhere, so a leaked versions lookup would record
  // them. The kit's own (unskipped) lookup answers nothing, so its record keeps
  // the recorded best and only its `last` is restamped (versions.mjs).
  const { ruflo, 'agentic-qe': aqe } = NEWER;
  const { calls, npm, out } = await observedSync({ skip: ['versions'] },
    { latest: { ruflo, 'agentic-qe': aqe }, answers: { ruflo, 'agentic-qe': aqe } });
  assert.equal(calls.collect.length, 2, `the plan read and the converge proof both ran\n${out}`);
  assert.deepEqual(calls.fetchLatest.filter((pkg) => pkg === 'ruflo' || pkg === 'agentic-qe'), []);
  assert.equal(calls.releaseDates, 0, "Ruflo's release dates are part of the versions lookup");
  if (POSIX) {
    assert.deepEqual([...npmViews(npm, 'ruflo'), ...npmViews(npm, 'agentic-qe')], [],
      'neither the plan read nor the converge proof may fetch on the expired cache');
  }
  assert.equal(versionsPartText(), before, "kit.json's versions record is byte-identical");
  assert.deepEqual(loadKitConfig().versionCheck.self.best, selfBefore.best, 'the failed kit lookup keeps its recorded best');
});

test('--skip self makes no lookup for the kit itself', async () => {
  seed();
  const before = recordText('self');
  const { calls, npm, out } = await observedSync({ skip: ['self'] },
    { latest: NEWER, answers: { [KIT_PKG]: NEWER[KIT_PKG] } });
  assert.equal(calls.collect.length, 2, out);
  assert.deepEqual(calls.fetchLatest.filter((pkg) => pkg === KIT_PKG), []);
  if (POSIX) assert.deepEqual(npmViews(npm, KIT_PKG), []);
  assert.ok(calls.fetchLatest.includes('ruflo'), 'the versions lookup still runs: only self was skipped');
  assert.equal(recordText('self'), before, "kit.json's self record is byte-identical");
});

test('--skip ruvnet-brain makes no Brain release lookup', async () => {
  seed({ ruvnetBrain: true });
  const before = recordText('ruvnetBrain');
  const { calls, fetched, out } = await observedSync({ skip: ['ruvnet-brain'] }, { brainRelease: NEWER_BRAIN });
  assert.equal(calls.collect.length, 2, out);
  assert.deepEqual(calls.brainDrift.filter((opts) => opts?.force === true), []);
  assert.deepEqual(fetched, [], 'the plan read and the proof read the recorded Brain release');
  assert.equal(recordText('ruvnetBrain'), before, "kit.json's Brain record is byte-identical");
});

test('--skip ruvector makes no ruvector lookup', async () => {
  seed({ ruvector: true });
  const before = recordText('ruvector');
  const { calls, npm, out } = await observedSync({ skip: ['ruvector'] }, { answers: { ruvector: NEWER.ruvector } });
  assert.equal(calls.collect.length, 2, out);
  if (POSIX) assert.deepEqual(npmViews(npm, 'ruvector'), [], 'neither the plan read nor the proof looks ruvector up');
  assert.equal(recordText('ruvector'), before, "kit.json's ruvector record is byte-identical");
});

test('an unskipped ruvector on an expired cache is still looked up by a real sync', {
  skip: POSIX ? false : 'POSIX shell fake npm',
}, async () => {
  seed({ ruvector: true });
  const { npm, out } = await observedSync({}, { answers: { ruvector: NEWER.ruvector } });
  assert.ok(npmViews(npm, 'ruvector').length > 0, out);
  assert.equal(loadKitConfig().versionCheck.ruvector.latest, NEWER.ruvector);
});

test('a sync that skips nothing makes every forced lookup before it plans', async () => {
  seed({ ruvnetBrain: true });
  const { calls, out } = await observedSync({});
  assert.equal(calls.collect.length, 2, out);
  for (const pkg of ['ruflo', 'agentic-qe', KIT_PKG]) assert.ok(calls.fetchLatest.includes(pkg), `looked up ${pkg}`);
  assert.equal(calls.releaseDates, 1);
  assert.deepEqual(calls.brainDrift, [{ force: true }]);
});

test('a dry run with --skip versions reads the recorded versions and writes nothing', async () => {
  seed();
  const before = kitJsonText();
  const { result, calls, npm, out } = await observedSync({ 'dry-run': true, skip: ['versions'] },
    { latest: NEWER, answers: NEWER });
  assert.equal(result, 0, out);
  assert.equal(calls.collect.length, 1, 'a dry run stops after the plan');
  assert.deepEqual(calls.fetchLatest.filter((pkg) => pkg === 'ruflo' || pkg === 'agentic-qe'), []);
  assert.equal(calls.releaseDates, 0);
  assert.ok(calls.fetchLatest.includes(KIT_PKG), 'the dry run previews the parts --skip did not name');
  if (POSIX) assert.deepEqual([...npmViews(npm, 'ruflo'), ...npmViews(npm, 'agentic-qe')], []);
  assert.equal(kitJsonText(), before);
});

// ── the sections take the evidence sync hands them ──────────────────────────

test('the versions section uses the drift rows it is given and never calls drift()', async () => {
  let called = 0;
  const rows = await versionsSection.collect({
    versionEvidence: { drift: [{ pkg: 'agentic-qe', installed: '1.0.0', latest: '1.1.0', outdated: true, latestSource: 'cache' }] },
    drift: async () => { called += 1; return []; },
  });
  assert.equal(called, 0);
  assert.match(rows[0].message, /agentic-qe 1\.0\.0 installed, 1\.1\.0 available/);
});

test("the support-window row reads the evidence's kit.json copy when one is given", async () => {
  let loads = 0;
  const cfg = { versionCheck: { rufloMinors: { observedAt: Date.now(), firstPublished: { '3.46': new Date().toISOString() } } } };
  const rows = await versionsSection.collect({
    versionEvidence: { drift: [{ pkg: 'ruflo', installed: '3.46.0', latest: '3.46.0', outdated: false, latestSource: 'cache' }], cfg },
    loadConfig: () => { loads += 1; return {}; },
  });
  assert.equal(loads, 0);
  assert.ok(rows.some((r) => /inside the support window/.test(r.message)), JSON.stringify(rows));
});

test('the self section uses the self drift it is given', async () => {
  seed();
  const { rows, npm } = await observingLookups(async () => ({
    rows: await selfSection.collect({
      pkgRoot: PKG_ROOT,
      versionEvidence: { self: { pkg: KIT_PKG, installed: '4.0.0', latest: '4.1.0', tag: 'latest', outdated: true } },
    }),
  }));
  assert.match(rows[0].message, /kit 4\.0\.0 installed, 4\.1\.0 available/);
  if (POSIX) assert.deepEqual(npm, []);
});

test('the ruvector section uses the ruvector drift it is given', async () => {
  seed({ ruvector: true });
  const { rows, npm } = await observingLookups(async () => ({
    rows: await ruvectorSection.collect({
      cfg: {}, versionEvidence: { ruvector: { present: true, outdated: true, installed: '1.2.0', latest: '1.6.0' } },
    }),
  }), { answers: { ruvector: '9.9.9' } });
  assert.match(rows[0].message, /ruvector CLI 1\.2\.0 installed, 1\.6\.0 available/);
  if (POSIX) assert.deepEqual(npm, []);
});

test('the ruvnet-brain section uses the Brain drift it is given', async () => {
  seed({ ruvnetBrain: true });
  const brain = {
    present: true, outdated: false, unversioned: false, installedRelease: '4.3.28', latest: '4.3.28',
    releaseAssetAvailable: true, latestSource: 'cache', latestObservedAt: TWO_DAYS_AGO, heldRefresh: null,
  };
  const { rows, fetched } = await observingLookups(async () => ({
    rows: await brainSection.collect({ cfg: { ruvnetBrain: true }, versionEvidence: { brain } }),
  }));
  assert.deepEqual(fetched, []);
  assert.match(rows[0].message, /ruvnet-brain release v4\.3\.28/);
});

// ── the cache-only evidence ──────────────────────────────────────────────────

test('skipped parts get cache-only evidence: no network, no write', async () => {
  const { skippedVersionEvidence } = await import('../../src/commands/sync/plan-versions.mjs');
  seed({ ruvnetBrain: true, ruvector: true });
  const before = kitJsonText();
  const { evidence, npm, fetched } = await observingLookups(async () => ({
    evidence: await skippedVersionEvidence({
      skip: new Set(['versions', 'self', 'ruvnet-brain', 'ruvector']), pkgRoot: PKG_ROOT,
    }),
  }), { answers: NEWER, brainRelease: NEWER_BRAIN });
  assert.deepEqual(evidence.drift.map((r) => [r.pkg, r.latest, r.latestSource]),
    [['ruflo', '9.9.9', 'cache-fallback'], ['agentic-qe', '9.9.9', 'cache-fallback']]);
  assert.equal(evidence.self.latest, '4.0.0');
  assert.equal(evidence.brain.latest, '4.3.28');
  assert.equal(evidence.brain.latestSource, 'cache-fallback');
  assert.deepEqual([evidence.ruvector.installed, evidence.ruvector.latest, evidence.ruvector.latestSource],
    ['1.2.0', '1.5.0', 'cache-fallback']);
  if (POSIX) assert.deepEqual(npm, []);
  assert.deepEqual(fetched, []);
  assert.equal(kitJsonText(), before);
});

test('no skipped part means no evidence; the Brain and ruvector are read only when ak manages them', async () => {
  const { skippedVersionEvidence } = await import('../../src/commands/sync/plan-versions.mjs');
  seed();
  assert.deepEqual(await skippedVersionEvidence({ skip: new Set(), pkgRoot: PKG_ROOT }), {});
  assert.deepEqual(await skippedVersionEvidence({ skip: new Set(['ruvnet-brain', 'ruvector']), pkgRoot: PKG_ROOT }), {});
});
