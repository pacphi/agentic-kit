// `ak sync --dry-run` previews the online version lookup a real sync makes
// before it plans (ADR-0063, "The `record` parameter"): the plan shows an
// upgrade the recorded versions do not know about yet, and nothing is
// recorded. kit.json and the whole HOME stay byte-identical, and every
// `npm view` the preview runs (versions and Ruflo's release dates) keeps its
// cache in a per-run temporary folder that is gone when sync returns. When
// every lookup fails, one line says the plan uses the recorded versions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  sandboxHome, assertSandboxed, snapshot, assertUnchanged, rmrf, sandboxProject, writeKitConfig, offlineKitConfig,
  fakeGlobalRoot, spawnEnv,
} from './helpers/home-sandbox.mjs';
import { isolateProject } from './helpers/project-isolation.mjs';

const HOME = sandboxHome('ak-sync-dry-preview');
const paths = await import('../../src/lib/paths.mjs');
const sync = await import('../../src/commands/sync.mjs');
const { KIT_PKG } = await import('../../src/lib/versions.mjs');
const versionsSection = (await import('../../src/commands/status/sections/versions.mjs')).default;
const selfSection = (await import('../../src/commands/status/sections/self.mjs')).default;
const brainSection = (await import('../../src/commands/status/sections/ruvnet-brain.mjs')).default;
const ruvectorSection = (await import('../../src/commands/status/sections/ruvector.mjs')).default;
const { loadKitConfig } = await import('../../src/lib/config.mjs');
assertSandboxed(paths, HOME);
isolateProject('ak-sync-dry-preview');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-sync-dry-preview');
const PKG_ROOT = path.join(HOME, 'installed-kit');
const KB = path.join(HOME, 'brain-kb');
const POSIX = process.platform !== 'win32';
const HOUR = 3600_000;
const savedKb = process.env.RUVNET_BRAIN_KB;
process.env.RUVNET_BRAIN_KB = KB;
after(() => {
  if (savedKb === undefined) delete process.env.RUVNET_BRAIN_KB; else process.env.RUVNET_BRAIN_KB = savedKb;
  rmrf(HOME, PROJECT);
});

const kitJsonText = () => fs.readFileSync(paths.kitConfigPath(), 'utf8');

/** kit.json whose versions were recorded `age` ago: ruflo and agentic-qe at
 *  `seen`, the kit at 4.0.0. Optional Brain and ruvector records. Returns the
 *  fake npm global root. */
function seed({ age = HOUR, selfAge = age, seen = { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }, brain, ruvector } = {}) {
  fs.mkdirSync(PKG_ROOT, { recursive: true });
  fs.writeFileSync(path.join(PKG_ROOT, 'package.json'), JSON.stringify({ name: KIT_PKG, version: '4.0.0' }));
  const at = Date.now() - age;
  const cfg = offlineKitConfig({ ruvnetBrain: !!brain });
  cfg.versionCheck = {
    ttlHours: 24, last: at, seen, observedAt: { ruflo: at, 'agentic-qe': at },
    self: { last: Date.now() - selfAge, best: { version: '4.0.0', tag: 'latest' } },
    ...(brain ? { ruvnetBrain: { last: at, ...brain } } : {}),
    ...(ruvector ? { ruvector: { last: at, ...ruvector } } : {}),
  };
  writeKitConfig(HOME, cfg);
  const pkgs = { ruflo: '9.9.9', 'agentic-qe': '9.9.9', ...(ruvector ? { ruvector: '1.2.0' } : {}) };
  const root = fakeGlobalRoot(HOME, pkgs);
  paths._setGlobalRootForTest(root);
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  if (ruvector) {
    fs.writeFileSync(paths.claudeUserMcpPath(),
      JSON.stringify({ mcpServers: { ruvector: { command: 'npx', args: ['-y', 'ruvector', 'mcp', 'start'] } } }));
  } else {
    fs.rmSync(paths.claudeUserMcpPath(), { force: true });
  }
  rmrf(KB);
  if (brain) {
    fs.mkdirSync(KB, { recursive: true });
    fs.writeFileSync(path.join(KB, 'forge-mcp-all.mjs'), '');
    fs.writeFileSync(path.join(KB, 'SOURCE.json'), JSON.stringify({ releaseTag: 'v4.3.28' }));
  }
  return root;
}

const moduleUrl = (rel) => pathToFileURL(path.join(REPO_ROOT, rel)).href;

/** `ak sync --json …` in a child process (an in-process run would send the test
 *  runner's own stdout through sync's stderr redirect). The forced lookups
 *  answer `answers[pkg]` (null otherwise) and the release dates fail; the plan
 *  read is the real collector unless `emptyPlan`. The child's temp folder is
 *  inside HOME, so the preview's npm folder is covered by HOME's snapshot. */
function syncJsonChild({ root, flags, answers = {}, emptyPlan = false, env }) {
  const script = `
    const paths = await import(${JSON.stringify(moduleUrl('src/lib/paths.mjs'))});
    paths._setGlobalRootForTest(${JSON.stringify(root)});
    const sync = await import(${JSON.stringify(moduleUrl('src/commands/sync.mjs'))});
    const { exitWhenFlushed } = await import(${JSON.stringify(moduleUrl('src/lib/output.mjs'))});
    const answers = ${JSON.stringify(answers)};
    exitWhenFlushed(await sync.run({
      flags: ${JSON.stringify(DRY({ json: true, ...flags }))}, pkgRoot: ${JSON.stringify(REPO_ROOT)},
      fetchLatest: async (pkg) => answers[pkg] ?? null,
      releaseDatesRunner: async () => ({ code: 1, stdout: '', stderr: 'offline' }),
      ${emptyPlan ? 'collectFn: async () => [],' : ''}
    }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PROJECT, env, encoding: 'utf8', timeout: 120_000,
  });
  assert.ok(child.stdout.trim().startsWith('{'), `stdout is not a JSON object:\n${child.stdout}\n--- stderr:\n${child.stderr}`);
  return { child, json: JSON.parse(child.stdout) };
}

/** A collectFn that runs the version sections with the arguments sync passes
 *  and returns their rows, so the plan is exactly what they report. */
async function versionSectionsCollect(args) {
  const ctx = { ...args, cfg: loadKitConfig(), refresh: false };
  const rows = [];
  for (const section of [versionsSection, selfSection, brainSection, ruvectorSection]) rows.push(...await section.collect(ctx));
  return rows;
}

/** Run `ak sync` in the project with console output captured line by line. */
async function syncLines(opts) {
  const lines = [];
  const saved = { log: console.log, error: console.error, cwd: process.cwd() };
  console.log = (...a) => lines.push(a.map(String).join(' '));
  console.error = console.log;
  process.chdir(PROJECT);
  try {
    const result = await sync.run({ pkgRoot: PKG_ROOT, refreshHosts: async () => {}, ...opts });
    return { result, lines, out: lines.join('\n') };
  } finally {
    process.chdir(saved.cwd);
    console.log = saved.log;
    console.error = saved.error;
  }
}

const DRY = (over = {}) => ({ 'dry-run': true, 'no-upgrade': false, yes: false, json: false, ...over });
const failedDates = async () => ({ code: 1, stdout: '', stderr: 'offline' });
const NOT_CHECKED = /versions not checked online \(offline or timed out\); this plan uses the versions ak recorded/;

test('a dry run looks the versions up online and plans the upgrade a fresh cache does not know about, recording nothing', () => {
  const root = seed({ age: HOUR });
  const env = spawnEnv(HOME);
  const beforeHome = snapshot(HOME);
  const beforeProject = snapshot(PROJECT);
  const { child, json } = syncJsonChild({ root, flags: {}, answers: { ruflo: '9.9.10', 'agentic-qe': '9.9.9' }, env });
  assert.equal(child.status, 0, child.stderr);
  const versions = json.plan.filter((p) => p.subsystem === 'versions');
  assert.ok(versions.some((p) => /ruflo 9\.9\.9 installed, 9\.9\.10 available \(live;/.test(p.message)),
    `the plan shows the upgrade the lookup found: ${JSON.stringify(json.plan)}`);
  assert.equal(json.converged, null, 'a dry run proves nothing');
  assert.doesNotMatch(child.stderr, NOT_CHECKED, 'the lookups answered');
  assertUnchanged(beforeHome, HOME, '`ak sync --dry-run` must not touch HOME, kit.json included');
  assertUnchanged(beforeProject, PROJECT, '`ak sync --dry-run` must not touch the project');
});

test('under --json the not-checked-online line goes to stderr and stdout stays one JSON object', () => {
  const root = seed({ age: 3 * HOUR });
  const env = spawnEnv(HOME);
  const beforeHome = snapshot(HOME);
  const { child, json } = syncJsonChild({ root, flags: {}, emptyPlan: true, env });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(json.exitCode, 0);
  assert.match(child.stderr, /versions not checked online \(offline or timed out\); this plan uses the versions ak recorded 3h ago/);
  assertUnchanged(beforeHome, HOME, '`ak sync --json --dry-run` must not touch HOME');
});

test('when every lookup fails, the plan uses the recorded versions and one line says so', async () => {
  seed({ age: 3 * HOUR, seen: { ruflo: '9.9.10', 'agentic-qe': '9.9.9' } });
  const before = kitJsonText();
  const { result, lines, out } = await syncLines({
    flags: DRY(), fetchLatest: async () => null, releaseDatesRunner: failedDates, collectFn: versionSectionsCollect,
  });
  assert.equal(result, 0, out);
  assert.equal(lines.filter((l) => NOT_CHECKED.test(l)).length, 1, out);
  assert.match(out, /this plan uses the versions ak recorded 3h ago/);
  assert.match(out, /\[versions\] sync upgrades \+ re-heals — because: ruflo 9\.9\.9 installed, 9\.9\.10 available \(cache-fallback;/);
  assert.equal(kitJsonText(), before);
});

test('a dry run on a two-day-old cache writes neither kit.json nor ~/.npm: every npm view uses a temporary cache that is removed', {
  skip: POSIX ? false : 'POSIX shell fake npm',
}, async () => {
  seed({ age: 48 * HOUR, ruvector: { latest: '1.5.0' } });
  const tmpRoot = fs.mkdtempSync(path.join(HOME, 'preview-tmp-'));
  const bin = fs.mkdtempSync(path.join(HOME, 'fakebin-npm-'));
  const log = path.join(bin, 'npm.log');
  fs.writeFileSync(path.join(bin, 'npm'), [
    '#!/bin/sh',
    `echo "$* | cache=$npm_config_cache | logs=$npm_config_logs_max | notifier=$npm_config_update_notifier" >> "${log}"`,
    'case "$*" in',
    `  "view ruflo time --json") echo '{"created":"2020-01-01T00:00:00Z","3.46.0":"2026-09-26T22:34:55Z"}' ;;`,
    '  "view ruflo@latest version") echo 9.9.10 ;;',
    '  "view agentic-qe@latest version") echo 9.9.9 ;;',
    '  "view ruvector@latest version") echo 1.6.0 ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const before = kitJsonText();
  const beforeHome = snapshot(HOME);
  const savedPath = process.env.PATH;
  process.env.PATH = bin;
  let run;
  try {
    run = await syncLines({ flags: DRY(), collectFn: versionSectionsCollect, tmpRoot });
  } finally { process.env.PATH = savedPath; }
  assert.equal(run.result, 0, run.out);
  assert.equal(kitJsonText(), before, 'a dry run on a stale cache must not write kit.json');
  const views = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('view '));
  const asked = views.map((l) => l.split(' | ')[0]);
  for (const call of ['view ruflo@latest version', 'view agentic-qe@latest version', 'view ruflo time --json',
    `view ${KIT_PKG}@latest version`, 'view ruvector@latest version']) {
    assert.ok(asked.includes(call), `${call} ran through the preview:\n${views.join('\n')}`);
  }
  const prefix = path.join(tmpRoot, 'ak-sync-preview-npm-');
  for (const line of views) {
    const cache = /cache=([^|]*) \|/.exec(line)?.[1] ?? '';
    assert.ok(cache.startsWith(prefix), `npm cache redirected under the injected tmpRoot: ${line}`);
    assert.match(line, /\| logs=0 \| notifier=false$/, line);
  }
  assert.deepEqual(fs.readdirSync(tmpRoot), [], 'the temporary npm cache is gone after the run');
  assert.match(run.out, /\[versions\].*ruflo 9\.9\.9 installed, 9\.9\.10 available \(live;/);
  assert.match(run.out, /\[ruvector\].*ruvector CLI 1\.2\.0 installed, 1\.6\.0 available/);
  assert.doesNotMatch(run.out, NOT_CHECKED, 'the lookups answered');
  assertUnchanged(beforeHome, HOME, '`ak sync --dry-run` must not touch HOME',
    { ignore: [path.relative(HOME, bin)] });
});

test('the Brain release is previewed too, and not recorded', async () => {
  seed({ age: HOUR, brain: { latest: '4.3.28', releaseAssetAvailable: true, installedRelease: '4.3.28' } });
  const before = kitJsonText();
  const savedFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return { ok: true, json: async () => ({ tag_name: 'v4.3.29', assets: [{ name: 'ruvnet-brain.zip', browser_download_url: 'x' }] }) };
  };
  let run;
  try {
    run = await syncLines({
      flags: DRY(), fetchLatest: async () => null, releaseDatesRunner: failedDates, collectFn: versionSectionsCollect,
    });
  } finally { globalThis.fetch = savedFetch; }
  assert.equal(run.result, 0, run.out);
  assert.deepEqual(fetched, ['https://api.github.com/repos/stuinfla/ruvnet-brain/releases/latest']);
  assert.match(run.out, /\[ruvnet-brain\].*release v4\.3\.28, release v4\.3\.29 available \(live;/);
  assert.doesNotMatch(run.out, NOT_CHECKED, 'the Brain lookup answered');
  assert.equal(kitJsonText(), before);
});

test('--dry-run --no-upgrade makes no lookup and records nothing, even on a stale cache', async () => {
  seed({ age: 48 * HOUR, brain: { latest: '4.3.28', releaseAssetAvailable: true } });
  const before = kitJsonText();
  const calls = { fetchLatest: 0, releaseDates: 0, brainDrift: 0 };
  const bin = fs.mkdtempSync(path.join(HOME, 'fakebin-npm-'));
  const log = path.join(bin, 'npm.log');
  if (POSIX) fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$*" >> "${log}"\necho 9.9.10\n`, { mode: 0o755 });
  const savedFetch = globalThis.fetch;
  const savedPath = process.env.PATH;
  const fetched = [];
  globalThis.fetch = async (url) => { fetched.push(String(url)); return { ok: true, json: async () => ({ tag_name: 'v4.3.29', assets: [] }) }; };
  process.env.PATH = bin;
  let run;
  try {
    run = await syncLines({
      flags: DRY({ 'no-upgrade': true }),
      fetchLatest: async () => { calls.fetchLatest += 1; return '9.9.10'; },
      releaseDatesRunner: async () => { calls.releaseDates += 1; return { code: 1, stdout: '', stderr: '' }; },
      brainDrift: async () => { calls.brainDrift += 1; return {}; },
      collectFn: versionSectionsCollect,
    });
  } finally {
    process.env.PATH = savedPath;
    globalThis.fetch = savedFetch;
  }
  assert.equal(run.result, 0, run.out);
  assert.deepEqual(calls, { fetchLatest: 0, releaseDates: 0, brainDrift: 0 });
  assert.deepEqual(fetched, [], 'the Brain section reads the recorded release');
  if (POSIX) assert.equal(fs.existsSync(log), false, 'no section looked a version up through npm');
  assert.doesNotMatch(run.out, NOT_CHECKED, 'no lookup was made, so none failed');
  assert.equal(kitJsonText(), before);
});

test('a dry run whose --skip leaves nothing to look up says nothing about being offline', async () => {
  seed({ age: HOUR });
  let lookups = 0;
  const run = await syncLines({
    flags: DRY({ skip: ['versions', 'self'] }),
    fetchLatest: async () => { lookups += 1; return null; },
    releaseDatesRunner: async () => { lookups += 1; return { code: 1, stdout: '', stderr: '' }; },
    collectFn: versionSectionsCollect,
  });
  assert.equal(run.result, 0, run.out);
  assert.equal(lookups, 0);
  assert.doesNotMatch(run.out, NOT_CHECKED);
});

test('the offline line gives the age of the parts it could not check', async () => {
  seed({ age: HOUR, selfAge: 48 * HOUR });
  const onlySelf = await syncLines({
    flags: DRY({ skip: ['versions'] }), fetchLatest: async () => null, collectFn: versionSectionsCollect,
  });
  assert.match(onlySelf.out, /this plan uses the versions ak recorded 2d ago/, onlySelf.out);
  const both = await syncLines({
    flags: DRY(), fetchLatest: async () => null, releaseDatesRunner: failedDates, collectFn: versionSectionsCollect,
  });
  assert.match(both.out, /this plan uses the versions ak recorded up to 2d ago/, both.out);
});

// ── the temporary npm cache ───────────────────────────────────────────────────

test('no temporary folder is made when no npm lookup will run', async () => {
  const { previewPlanVersions } = await import('../../src/commands/sync/plan-versions.mjs');
  seed();
  const tmpRoot = path.join(HOME, 'no-such-parent', 'tmp');
  const { online } = await previewPlanVersions({
    pkgRoot: PKG_ROOT, fetchLatest: async () => null, releaseDatesRunner: failedDates, tmpRoot,
  });
  assert.equal(online, false);
  assert.equal(fs.existsSync(tmpRoot), false, 'mkdtemp under a missing folder would have thrown');
});

test('a lookup that throws still leaves no temporary folder behind', async () => {
  const { previewPlanVersions } = await import('../../src/commands/sync/plan-versions.mjs');
  seed({ brain: { latest: '4.3.28', releaseAssetAvailable: true } });
  const tmpRoot = fs.mkdtempSync(path.join(HOME, 'preview-throw-'));
  let made = false;
  await assert.rejects(previewPlanVersions({
    pkgRoot: PKG_ROOT, tmpRoot,
    // The real npm runner makes the folder on its first lookup (npm itself is absent from the sandbox PATH).
    brainDrift: async () => { made = fs.readdirSync(tmpRoot).length === 1; throw new Error('brain lookup exploded'); },
  }), /brain lookup exploded/);
  assert.equal(made, true, 'the npm lookups made the folder before the throw');
  assert.deepEqual(fs.readdirSync(tmpRoot), [], 'finally removed it');
});

test('a folder that cannot be removed does not fail the preview', async (t) => {
  const { previewPlanVersions } = await import('../../src/commands/sync/plan-versions.mjs');
  seed();
  const tmpRoot = fs.mkdtempSync(path.join(HOME, 'preview-rm-'));
  t.mock.method(fs, 'rmSync', () => { throw new Error('EBUSY (test)'); });
  const { versionEvidence, online } = await previewPlanVersions({ pkgRoot: PKG_ROOT, tmpRoot });
  t.mock.restoreAll();
  assert.equal(online, false);
  assert.ok(Array.isArray(versionEvidence.drift), 'the preview still returns its evidence');
  assert.equal(fs.readdirSync(tmpRoot).length, 1, 'the folder stays; nothing else is attempted');
});
