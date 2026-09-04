// System-area (machine-footprint) collectors: the bounded walker and the
// Measurement vocabulary every collector reports in, then Storage, Projects and
// Catalog over real temp-dir fixtures.
//
// Two rules these tests hold themselves to, because the collectors default to
// the real ~/.claude, ~/.codex and npm caches: every fixture path is created
// under mkdtempSync, and every collector is handed an fs restricted to that
// fixture. A test that reached the developer's home directory fails with ENOENT
// rather than passing slowly against whatever happens to be installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  walkTree, walkMeasurements, rootMeasurements, presenceOf, statNode,
  measured, unknown, carriedForward, sumMeasurements, isMeasured, hasValue,
  MEASURED, UNKNOWN, WALK_LIMITS,
} from '../../src/lib/footprint/walk.mjs';
import * as storageModule from '../../src/lib/footprint/storage.mjs';
import {
  collectStorage, worktreeReclaimables, buildGrowth, localDay, labelSessions, STORAGE_DEFAULTS,
} from '../../src/lib/footprint/storage.mjs';
import {
  collectProjects, countLines, describeRemote, measureProject, nodeModulesRoots,
  parseGitRemote, projectRemote, LOC_EXCLUSIONS,
} from '../../src/lib/footprint/projects.mjs';
import { collectCatalog, tomlTableNames } from '../../src/lib/footprint/catalog.mjs';
import {
  artifactTreeDigest, buildCatalogSourceStamps, collectNativePluginInventory, probeCatalogDrift,
} from '../../src/lib/footprint/catalog-evidence.mjs';
import { collectConsumers } from '../../src/lib/footprint/consumers.mjs';
import {
  npmPackageRoot, managedTools, observedRuntimeTools, sharedCacheRoots,
  browserPayloadReadiness,
} from '../../src/lib/footprint/install.mjs';
import { MANAGED_COMPANION_REGISTRY } from '../../src/lib/adapters/index.mjs';

const DAY = 86_400_000;

/** A fixture root that is removed when the test ends, whatever the outcome.
 *
 *  Canonicalised with realpathSync.NATIVE, matching what the collectors resolve
 *  paths with. The JS realpath leaves a Windows 8.3 short name alone
 *  (C:\Users\RUNNER~1\...) while the native one resolves it to the long form the
 *  code under test produces (C:\Users\runneradmin\...) — the same directory in
 *  two spellings, which made every path assertion here fail on Windows only. */
function fixture(t, name) {
  const real = fs.realpathSync.native ?? fs.realpathSync;
  const dir = real(fs.mkdtempSync(path.join(os.tmpdir(), `ak-footprint-${name}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write one fixture file and return its byte length, so a test's expected
 *  totals are derived from what it actually created rather than restated. */
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  fs.writeFileSync(file, buffer);
  return buffer.length;
}

const touch = (file, ms) => fs.utimesSync(file, new Date(ms), new Date(ms));

/**
 * Real fs, fenced to `root`, with an optional set of directories made
 * unreadable. The fence is what proves a collector never reached the real home;
 * the deny list is the portable stand-in for `chmod 000`, which Windows cannot
 * reproduce and a root-run CI would ignore.
 */
function fixtureFs(root, { deny = [], denyCode = 'EACCES' } = {}) {
  const allowed = path.resolve(root);
  const denied = deny.map((dir) => path.resolve(dir));
  const guard = (target) => {
    const resolved = path.resolve(String(target));
    if (resolved === allowed || resolved.startsWith(allowed + path.sep)) return resolved;
    throw Object.assign(new Error(`ENOENT: outside the fixture (${resolved})`), { code: 'ENOENT' });
  };
  return {
    ...fs,
    readdirSync: (target, options) => {
      const resolved = guard(target);
      if (denied.includes(resolved)) {
        throw Object.assign(new Error(`${denyCode}: ${resolved}`), { code: denyCode });
      }
      return fs.readdirSync(resolved, options);
    },
    lstatSync: (target) => fs.lstatSync(guard(target)),
    statSync: (target) => fs.statSync(guard(target)),
    readFileSync: (target, options) => fs.readFileSync(guard(target), options),
    openSync: (target, flags) => fs.openSync(guard(target), flags),
  };
}

// ── the bounded walker ────────────────────────────────────────────────────────

test('the walker returns bytes, file count and newest mtime for a real tree', (t) => {
  const root = fixture(t, 'walk');
  const a = write(path.join(root, 'a.txt'), 'a'.repeat(100));
  const b = write(path.join(root, 'nested', 'b.txt'), 'b'.repeat(30));
  const newest = Date.now() - 5 * DAY;
  touch(path.join(root, 'a.txt'), newest - DAY);
  touch(path.join(root, 'nested', 'b.txt'), newest);

  const result = walkTree(root);
  assert.equal(result.status, MEASURED);
  assert.equal(result.bytes, a + b);
  assert.equal(result.files, 2);
  assert.equal(Math.round(result.newestMtimeMs), newest);
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.equal(result.degradedCount, 0);
});

test('the walker never follows a symlink, so a symlink cycle terminates', (t) => {
  const root = fixture(t, 'walk-symlink');
  const real = write(path.join(root, 'tree', 'real.txt'), 'x'.repeat(64));
  try {
    fs.symlinkSync(root, path.join(root, 'tree', 'loop'), 'dir');
    fs.symlinkSync(path.join(root, 'tree'), path.join(root, 'sideways'), 'dir');
    fs.symlinkSync(path.join(root, 'tree', 'real.txt'), path.join(root, 'alias.txt'), 'file');
  } catch {
    t.skip('this platform does not permit unprivileged symlink creation');
    return;
  }

  const result = walkTree(root);
  assert.equal(result.status, MEASURED);
  // The cycle would never terminate if `loop` were followed, and the aliases
  // would double- and triple-count `real.txt`'s bytes if they were measured.
  assert.equal(result.bytes, real);
  assert.equal(result.files, 1);
  assert.equal(result.symlinksSkipped, 3);
  assert.equal(result.complete, true);

  // A symlinked ROOT is refused outright rather than resolved to its target.
  const head = walkTree(path.join(root, 'sideways'));
  assert.equal(head.status, UNKNOWN);
  assert.match(head.reason, /symlink/);
  assert.equal(head.bytes, null);
});

test('the walker respects the depth cap and reports the truncation', (t) => {
  const root = fixture(t, 'walk-depth');
  const shallow = write(path.join(root, 'top.txt'), 'a'.repeat(10));
  write(path.join(root, 'one', 'two', 'three', 'deep.txt'), 'b'.repeat(1000));

  const result = walkTree(root, { maxDepth: 1 });
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, 'depth');
  assert.equal(result.complete, false);
  assert.equal(result.bytes, shallow, 'a capped walk reports a floor, not the total');
  // A floor is still a MEASUREMENT — it is flagged partial, never downgraded to
  // unknown and never rounded to zero.
  const { bytes } = walkMeasurements(result);
  assert.equal(bytes.status, MEASURED);
  assert.equal(bytes.partial, true);
});

test('the walker respects the entry cap', (t) => {
  const root = fixture(t, 'walk-entries');
  for (let i = 0; i < 10; i++) write(path.join(root, `f${i}.txt`), 'x'.repeat(8));

  const result = walkTree(root, { maxEntries: 3 });
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, 'entries');
  assert.equal(result.complete, false);
  assert.ok(result.entriesSeen <= 3, `entriesSeen ${result.entriesSeen} exceeded the cap`);
  assert.ok(result.files < 10);
  assert.equal(WALK_LIMITS.maxEntries > 3, true, 'the shipped cap is not the test cap');
});

test('one unreadable subtree degrades that node while its siblings still report', (t) => {
  const root = fixture(t, 'walk-degrade');
  const ok = write(path.join(root, 'readable', 'a.txt'), 'a'.repeat(40));
  const alsoOk = write(path.join(root, 'other', 'b.txt'), 'b'.repeat(20));
  write(path.join(root, 'denied', 'secret.txt'), 'c'.repeat(9999));

  const denied = path.join(root, 'denied');
  const result = walkTree(root, { fsImpl: fixtureFs(root, { deny: [denied] }) });
  assert.equal(result.status, MEASURED, 'a degraded child never unknowns the whole walk');
  assert.equal(result.bytes, ok + alsoOk, 'siblings keep their measured bytes');
  assert.equal(result.files, 2);
  assert.equal(result.complete, false);
  assert.deepEqual(result.degraded, [{ path: denied, reason: 'EACCES' }]);
});

test('the degraded COUNT is exact while the retained sample stays capped', (t) => {
  const root = fixture(t, 'walk-degrade-cap');
  const denied = [];
  for (let i = 0; i < 5; i++) {
    write(path.join(root, `d${i}`, 'x.txt'), 'x');
    denied.push(path.join(root, `d${i}`));
  }
  const result = walkTree(root, { maxDegraded: 2, fsImpl: fixtureFs(root, { deny: denied }) });
  assert.equal(result.degradedCount, 5);
  assert.equal(result.degraded.length, 2);
});

test('an unreadable root is unknown-with-reason, never a zero-byte directory', (t) => {
  const root = fixture(t, 'walk-root-denied');
  write(path.join(root, 'a.txt'), 'a'.repeat(100));

  const result = walkTree(root, { fsImpl: fixtureFs(root, { deny: [root] }) });
  assert.equal(result.status, UNKNOWN);
  assert.equal(result.reason, 'EACCES');
  assert.equal(result.bytes, null, 'an EACCES directory is not an empty one');
  assert.equal(result.files, null);
  assert.equal(result.complete, false);
  assert.equal(presenceOf(result), 'degraded');

  const { bytes, files } = rootMeasurements(result);
  for (const figure of [bytes, files]) {
    assert.equal(figure.status, UNKNOWN);
    assert.equal(figure.value, null);
    assert.equal(figure.reason, 'EACCES');
    assert.notEqual(figure.value, 0);
  }
});

test('a file root is a node in its own right, and a vanished file degrades only itself', (t) => {
  const root = fixture(t, 'walk-file-root');
  const history = path.join(root, 'history.jsonl');
  const size = write(history, 'a'.repeat(72));

  // Several known roots are single files (history.jsonl, the opencode store).
  const single = walkTree(history);
  assert.equal(single.status, MEASURED);
  assert.deepEqual({ bytes: single.bytes, files: single.files }, { bytes: size, files: 1 });
  assert.equal(single.complete, true);
  const filtered = walkTree(history, { acceptFile: () => false });
  assert.equal(filtered.files, 0, 'a deliberate filter is a scope, not a failure');
  assert.equal(filtered.complete, true);

  // A file that disappears between readdir and lstat is one degraded node.
  const kept = write(path.join(root, 'kept.log'), 'b'.repeat(10));
  const racing = path.join(root, 'gone.log');
  write(racing, 'c'.repeat(999));
  const base = fixtureFs(root);
  const result = walkTree(root, {
    fsImpl: {
      ...base,
      lstatSync: (target) => {
        if (path.resolve(String(target)) === racing) {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
        return base.lstatSync(target);
      },
    },
  });
  assert.equal(result.bytes, size + kept);
  assert.equal(result.files, 2);
  assert.deepEqual(result.degraded, [{ path: racing, reason: 'ENOENT' }]);
  assert.equal(result.complete, false);
});

test('a walker callback exception surfaces instead of reading as an unreadable subtree', (t) => {
  const root = fixture(t, 'walk-onfile-throws');
  write(path.join(root, 'a.txt'), 'a');
  assert.throws(() => walkTree(root, {
    onFile: () => { throw new Error('collector bug'); },
  }), /collector bug/);
});

// ── measurement provenance ────────────────────────────────────────────────────

test('an unmeasured value reads unknown-with-reason and never 0', () => {
  const figure = unknown('EACCES');
  assert.equal(figure.status, UNKNOWN);
  assert.equal(figure.value, null);
  assert.equal(figure.reason, 'EACCES');
  assert.equal(hasValue(figure), false);
  assert.equal(isMeasured(figure), false);
  // Even an unknown constructed without a stated cause carries one, because a
  // reasonless unknown is indistinguishable from a forgotten zero.
  assert.equal(unknown('').reason, 'unmeasured');
  assert.equal(unknown(null).reason, 'unmeasured');
});

test('a real empty directory reads as a MEASURED zero, and a missing one as absent', (t) => {
  const root = fixture(t, 'measure-empty');
  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);

  const walked = walkTree(empty);
  assert.equal(walked.status, MEASURED);
  assert.equal(walked.bytes, 0);
  assert.equal(presenceOf(walked), 'present');
  const present = rootMeasurements(walked);
  assert.equal(present.presence, 'present');
  assert.deepEqual(
    { value: present.bytes.value, status: present.bytes.status, reason: present.bytes.reason },
    { value: 0, status: MEASURED, reason: null },
    'an empty directory really does hold zero bytes',
  );

  // Absence is a measured zero too — a root that does not exist holds nothing.
  const gone = rootMeasurements(walkTree(path.join(root, 'nope')));
  assert.equal(gone.presence, 'absent');
  assert.equal(gone.bytes.status, MEASURED);
  assert.equal(gone.bytes.value, 0);

  // The distinction the whole domain turns on: same 0 on screen, different
  // provenance underneath, and an unreadable root gets neither.
  const denied = rootMeasurements(walkTree(empty, { fsImpl: fixtureFs(root, { deny: [empty] }) }));
  assert.equal(denied.presence, 'degraded');
  assert.equal(denied.bytes.status, UNKNOWN);
  assert.equal(denied.bytes.value, null);
});

test('sums stay honest: empty is zero, all-unknown is unknown, mixed is partial', () => {
  assert.equal(sumMeasurements([]).value, 0);
  assert.equal(sumMeasurements([]).status, MEASURED);

  const allUnknown = sumMeasurements([unknown('EACCES'), unknown('EPERM')]);
  assert.equal(allUnknown.status, UNKNOWN);
  assert.equal(allUnknown.value, null);

  const mixed = sumMeasurements([measured(10), unknown('EACCES'), measured(5)]);
  assert.equal(mixed.status, MEASURED);
  assert.equal(mixed.value, 15, 'an unmeasured input never contributes a 0');
  assert.equal(mixed.partial, true, 'a sum missing an input is a floor');

  const clean = sumMeasurements([measured(10), measured(5)]);
  assert.equal(clean.partial, false);
  assert.equal(sumMeasurements([measured(1, { partial: true }), measured(2)]).partial, true);
});

test('a carried-forward figure keeps the scan that produced it, not the current time', () => {
  const then = Date.now() - 3 * DAY;
  const figure = carriedForward(4096, then);
  assert.equal(figure.status, 'carried-forward');
  assert.equal(figure.asOf, then);
  assert.equal(isMeasured(figure), false, 'carried forward is not "this scan measured it"');
  assert.equal(hasValue(figure), true);
});

test('statNode reports a symlink as a symlink rather than measuring its target', (t) => {
  const root = fixture(t, 'statnode');
  const file = path.join(root, 'real.txt');
  write(file, 'a'.repeat(12));
  const node = statNode(file);
  assert.equal(node.kind, 'file');
  assert.equal(node.bytes, 12);

  try { fs.symlinkSync(file, path.join(root, 'alias.txt'), 'file'); } catch {
    t.skip('this platform does not permit unprivileged symlink creation');
    return;
  }
  const alias = statNode(path.join(root, 'alias.txt'));
  assert.equal(alias.kind, 'symlink');
  assert.equal(alias.bytes, null);
  assert.equal(statNode(path.join(root, 'missing')).reason, 'ENOENT');
});

// ── storage ───────────────────────────────────────────────────────────────────

/** Category → host → project → session fixture with known sizes and mtimes. */
function storageFixture(t) {
  const root = fixture(t, 'storage');
  const now = Date.now();
  const claudeProjects = path.join(root, 'claude', 'projects');
  const codexSessions = path.join(root, 'codex', 'sessions');
  const akConfig = path.join(root, 'ak', 'config');

  const sizes = {
    recent: write(path.join(claudeProjects, '-repos-keel', 'recent.jsonl'), 'a'.repeat(100)),
    aged: write(path.join(claudeProjects, '-repos-keel', 'aged.jsonl'), 'b'.repeat(50)),
    rollout: write(path.join(codexSessions, '2026', '08', '06', 'rollout.jsonl'), 'c'.repeat(30)),
    index: write(path.join(akConfig, 'usage-index.json'), 'd'.repeat(10)),
  };
  touch(path.join(claudeProjects, '-repos-keel', 'recent.jsonl'), now - DAY);
  touch(path.join(claudeProjects, '-repos-keel', 'aged.jsonl'), now - 200 * DAY);
  touch(path.join(codexSessions, '2026', '08', '06', 'rollout.jsonl'), now - 2 * DAY);
  touch(path.join(akConfig, 'usage-index.json'), now - 400 * DAY);

  const roots = [
    { id: 'claude-transcripts', category: 'transcripts', host: 'claude',
      label: 'session transcripts', path: claudeProjects, layout: 'claude-projects' },
    { id: 'codex-transcripts', category: 'transcripts', host: 'codex',
      label: 'session rollouts', path: codexSessions, layout: 'flat-sessions' },
    { id: 'ak-config', category: 'kit-caches', host: 'agentic-kit',
      label: 'config, indexes & snapshots', path: akConfig, layout: 'tree' },
  ];
  return { root, now, roots, sizes, claudeProjects, codexSessions };
}

const nodeAt = (nodes, key) => nodes.find((node) => node.key === key);

test('storage sums the category → host → project → session tree', (t) => {
  const { root, now, roots, sizes, claudeProjects } = storageFixture(t);
  const result = collectStorage({
    roots, projects: [], now: () => now, detectWorktrees: false, fsImpl: fixtureFs(root),
  });

  const transcripts = nodeAt(result.categories, 'transcripts');
  assert.equal(transcripts.bytes.value, sizes.recent + sizes.aged + sizes.rollout);
  assert.equal(transcripts.files.value, 3);

  const claude = nodeAt(transcripts.children, 'claude');
  assert.equal(claude.bytes.value, sizes.recent + sizes.aged);
  const project = nodeAt(claude.children, '-repos-keel');
  assert.equal(project.kind, 'project');
  assert.equal(project.attribution, 'path', 'a claude transcript names its project in the path');
  assert.equal(project.path, path.join(claudeProjects, '-repos-keel'));
  assert.equal(project.bytes.value, sizes.recent + sizes.aged);
  assert.deepEqual(project.children.map((leaf) => leaf.key).sort(), ['aged.jsonl', 'recent.jsonl']);
  assert.equal(nodeAt(project.children, 'recent.jsonl').bytes.value, sizes.recent);

  // A codex rollout path is dated, not project-scoped: unattributable, stated.
  const codex = nodeAt(transcripts.children, 'codex');
  const codexRoot = nodeAt(codex.children, 'codex-transcripts');
  assert.equal(codexRoot.attribution, 'none');
  assert.equal(codexRoot.bytes.value, sizes.rollout);

  const total = sizes.recent + sizes.aged + sizes.rollout + sizes.index;
  assert.equal(result.totals.bytes.value, total);
  assert.equal(result.totals.files.value, 4);
  assert.equal(result.totals.bytes.partial, false);
  assert.equal(result.complete, true);

  // Every category always appears, so a missing slice never reads as a gap.
  assert.deepEqual(
    result.categories.map((node) => node.key).sort(),
    ['kit-caches', 'learning-stores', 'ledgers-and-logs', 'transcripts'],
  );
  const empty = nodeAt(result.categories, 'ledgers-and-logs');
  assert.equal(empty.bytes.status, MEASURED);
  assert.equal(empty.bytes.value, 0, 'a category with no roots really is zero');
});

test('storage reports "nowhere to look" as unknown, not as a zero-byte category', (t) => {
  const { root, now, roots } = storageFixture(t);
  const withCatalog = collectStorage({
    roots, projects: [], now: () => now, detectWorktrees: false, fsImpl: fixtureFs(root),
  });
  assert.equal(nodeAt(withCatalog.categories, 'learning-stores').bytes.value, 0);

  const noCatalog = collectStorage({
    roots, projects: null, now: () => now, detectWorktrees: false, fsImpl: fixtureFs(root),
  });
  const learning = nodeAt(noCatalog.categories, 'learning-stores');
  assert.equal(learning.bytes.status, UNKNOWN);
  assert.equal(learning.bytes.value, null);
  assert.match(learning.bytes.reason, /no project catalog/);
});

test('a capped child list folds its remainder in, so the parent total still adds up', (t) => {
  const root = fixture(t, 'storage-cap');
  const now = Date.now();
  const sessions = path.join(root, 'projects', '-repos-keel');
  let total = 0;
  for (let i = 0; i < 5; i++) {
    total += write(path.join(sessions, `s${i}.jsonl`), 'x'.repeat(10 + i));
  }

  const result = collectStorage({
    roots: [{ id: 'claude-transcripts', category: 'transcripts', host: 'claude',
      label: 'session transcripts', path: path.join(root, 'projects'), layout: 'claude-projects' }],
    projects: [], now: () => now, detectWorktrees: false, maxChildren: 2, fsImpl: fixtureFs(root),
  });

  const project = nodeAt(nodeAt(nodeAt(result.categories, 'transcripts').children, 'claude')
    .children, '-repos-keel');
  assert.equal(project.bytes.value, total);
  assert.equal(project.children.length, 3, 'two kept leaves plus one aggregate remainder');
  const aggregate = project.children.at(-1);
  assert.equal(aggregate.kind, 'aggregate');
  assert.equal(aggregate.label, '3 more');
  assert.equal(project.children.reduce((acc, child) => acc + child.bytes.value, 0), total);
});

test('the default storage roots describe every category without touching the disk', () => {
  const roots = storageModule.defaultStorageRoots({ projects: ['/repos/keel'] });
  assert.deepEqual([...new Set(roots.map((entry) => entry.category))].sort(),
    [...storageModule.STORAGE_CATEGORIES].sort());
  assert.equal(new Set(roots.map((entry) => entry.id)).size, roots.length, 'ids are unique');
  assert.equal(roots.every((entry) => entry.path && entry.host && entry.label), true);
  assert.equal(roots.every((entry) => ['claude-projects', 'flat-sessions', 'tree']
    .includes(entry.layout)), true);

  // A supplied project contributes its three learning stores, attributed to it.
  const learning = roots.filter((entry) => entry.category === 'learning-stores');
  assert.deepEqual(learning.map((entry) => path.basename(entry.path)),
    ['.claude-flow', '.agentic-qe', '.swarm']);
  assert.equal(learning.every((entry) => entry.projectPath === '/repos/keel'), true);
  assert.equal(storageModule.defaultStorageRoots()
    .some((entry) => entry.category === 'learning-stores'), false);
});

test('an unreadable storage root degrades itself while its host siblings report', (t) => {
  const root = fixture(t, 'storage-degrade');
  const now = Date.now();
  const readable = path.join(root, 'claude', 'logs');
  const denied = path.join(root, 'claude', 'debug');
  const size = write(path.join(readable, 'a.log'), 'a'.repeat(64));
  write(path.join(denied, 'b.log'), 'b'.repeat(1024));

  const result = collectStorage({
    roots: [
      { id: 'claude-logs', category: 'ledgers-and-logs', host: 'claude', label: 'logs',
        path: readable, layout: 'tree' },
      { id: 'claude-debug', category: 'ledgers-and-logs', host: 'claude', label: 'debug',
        path: denied, layout: 'tree' },
    ],
    projects: [], now: () => now, detectWorktrees: false,
    fsImpl: fixtureFs(root, { deny: [denied] }),
  });

  const host = nodeAt(nodeAt(result.categories, 'ledgers-and-logs').children, 'claude');
  assert.equal(nodeAt(host.children, 'claude-logs').bytes.value, size);
  const broken = nodeAt(host.children, 'claude-debug');
  assert.equal(broken.bytes.status, UNKNOWN);
  assert.equal(broken.bytes.value, null);
  assert.equal(broken.bytes.reason, 'EACCES');
  // The host total keeps what it saw but says it is a floor.
  assert.equal(host.bytes.value, size);
  assert.equal(host.bytes.partial, true);
  assert.equal(result.complete, false);
});

test('storage growth derives from mtime and size alone', (t) => {
  const { root, now, roots, sizes } = storageFixture(t);
  const result = collectStorage({
    roots, projects: [], now: () => now, detectWorktrees: false, fsImpl: fixtureFs(root),
  });

  assert.equal(result.growth.windowDays, 30);
  assert.equal(result.growth.approximate, true);
  assert.match(result.growth.basis, /mtime/);
  const claude = result.growth.hosts.find((host) => host.host === 'claude');
  // Only the 1-day-old transcript falls inside the window; the 200-day-old one
  // contributes nothing, and no file's CONTENT was consulted to decide that.
  assert.equal(claude.totalBytes.value, sizes.recent);
  assert.equal(claude.days.length, 30);
  const yesterday = claude.days.find((day) => day.day === localDay(now - DAY));
  assert.deepEqual({ bytes: yesterday.bytes, files: yesterday.files },
    { bytes: sizes.recent, files: 1 });
  // The 400-day-old kit cache is outside the window entirely, so its host has
  // no growth series at all rather than a fabricated flat line.
  assert.equal(result.growth.hosts.some((host) => host.host === 'agentic-kit'), false);

  const rebuilt = buildGrowth(new Map(), { asOf: now, growthDays: 7 });
  assert.equal(rebuilt.hosts.length, 0);
  assert.equal(rebuilt.windowDays, 7);
});

test('reclaimable candidates carry a path and a rationale, and nothing can delete', (t) => {
  const { root, now, roots, sizes, claudeProjects } = storageFixture(t);
  const result = collectStorage({
    roots, projects: [], now: () => now, detectWorktrees: false, fsImpl: fixtureFs(root),
  });

  const aged = result.reclaimables.find((row) => row.id === 'aged-transcripts:claude');
  assert.equal(aged.kind, 'aged-transcripts');
  assert.equal(aged.path, claudeProjects);
  assert.equal(aged.bytes.value, sizes.aged, 'only the aged file is a candidate');
  assert.equal(aged.files.value, 1);
  assert.deepEqual(aged.samplePaths, [path.join(claudeProjects, '-repos-keel', 'aged.jsonl')]);
  assert.match(aged.rationale, /180d/);
  assert.equal(aged.advisory, true);
  assert.equal(result.reclaimables.every((row) => row.rationale && row.path), true);

  // Invariant 4: the module is advisory. No export removes anything, and the
  // cleanup hint is documentation naming the CLI that already owns removal.
  for (const name of Object.keys(storageModule)) {
    assert.doesNotMatch(name, /delete|remove|prune|clean|unlink|rm/i,
      `${name} must not exist on an advisory module`);
  }
  assert.equal(storageModule.pruneNpxStale, undefined);
});

test('an idle npx cache env is a candidate because the cache is reproducible', (t) => {
  const root = fixture(t, 'npx');
  const cache = path.join(root, 'npm-cache');
  const env = path.join(cache, '_npx', 'a1b2c3d4');
  const now = Date.now();
  let total = write(path.join(env, 'package.json'),
    JSON.stringify({ dependencies: { 'some-tool': '^1.0.0' } }));
  total += write(path.join(env, 'node_modules', 'some-tool', 'index.js'), 'x'.repeat(256));
  for (const file of ['package.json', path.join('node_modules', 'some-tool', 'index.js')]) {
    touch(path.join(env, file), now - 120 * DAY);
  }

  const before = process.env.npm_config_cache;
  t.after(() => {
    if (before === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = before;
  });
  process.env.npm_config_cache = cache;

  const rows = storageModule.npxReclaimables({
    asOf: now, opts: { ...STORAGE_DEFAULTS }, walk: walkTree, limits: {}, fsImpl: fixtureFs(root),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'stale-npx-env');
  assert.equal(rows[0].path, env);
  assert.equal(rows[0].label, 'npx cache env (some-tool)');
  assert.equal(rows[0].bytes.value, total);
  assert.deepEqual(rows[0].basis, { versionStale: false, idle: true, idleDays: 120 });
  assert.match(rows[0].rationale, /untouched for 120d/);
  assert.match(rows[0].rationale, /re-fetches on demand/);
  assert.equal(rows[0].cleanupHint, null,
    'idle age alone must not claim the version-stale pruning procedure applies');
  assert.equal(rows[0].advisory, true);
});

test('worktree candidates state what they know and never guess a dead checkout', (t) => {
  const root = fixture(t, 'worktrees');
  const now = Date.now();
  const project = path.join(root, 'repo');
  const admin = path.join(project, '.git', 'worktrees');

  // A record whose checkout is gone, one whose pointer is unreadable, and one
  // whose checkout exists but has been idle past the window.
  write(path.join(admin, 'dead', 'gitdir'), `${path.join(root, 'gone', '.git')}\n`);
  fs.mkdirSync(path.join(admin, 'broken'), { recursive: true });
  const idle = path.join(root, 'idle-checkout');
  const size = write(path.join(idle, 'file.txt'), 'a'.repeat(48));
  write(path.join(admin, 'idle', 'gitdir'), `${path.join(idle, '.git')}\n`);
  touch(path.join(idle, 'file.txt'), now - 200 * DAY);

  const rows = worktreeReclaimables({
    asOf: now, projects: [project], opts: { ...STORAGE_DEFAULTS },
    walk: walkTree, limits: {}, fsImpl: fixtureFs(root),
  });
  const byKind = (label) => rows.find((row) => row.label.includes(label));

  const dead = byKind('orphaned worktree record "dead"');
  assert.match(dead.rationale, /no longer exists/);
  assert.equal(dead.cleanupHint, 'git worktree prune');

  const broken = byKind('"broken" (unverifiable)');
  assert.equal(broken.bytes.status, UNKNOWN, 'a pointer we could not read is not a dead worktree');
  assert.equal(broken.bytes.value, null);

  const stale = byKind('idle worktree "idle"');
  assert.equal(stale.path, idle);
  assert.equal(stale.bytes.value, size);
  assert.match(stale.rationale, /200d/);
  assert.equal(rows.every((row) => row.advisory === true), true);
});

// ── projects ──────────────────────────────────────────────────────────────────

test('git remote URLs parse across git+https, ssh, scp and bare shapes', () => {
  for (const raw of [
    'https://github.com/pacphi/agentic-kit.git',
    'git+https://github.com/pacphi/agentic-kit.git',
    'ssh://git@github.com/pacphi/agentic-kit.git',
    'git@github.com:pacphi/agentic-kit.git',
  ]) {
    const remote = describeRemote(raw);
    assert.equal(remote.status, 'linked', raw);
    assert.equal(remote.host, 'github', raw);
    assert.equal(remote.slug, 'pacphi/agentic-kit', raw);
    assert.equal(remote.webUrl, 'https://github.com/pacphi/agentic-kit', raw);
  }

  // A self-hosted forge keeps the scheme it was written with — an http-only
  // server is never silently upgraded to https.
  const selfHosted = describeRemote('http://git.example.com/team/repo.git');
  assert.equal(selfHosted.webUrl, 'http://git.example.com/team/repo');
  assert.equal(selfHosted.host, 'git.example.com');

  // Unrecognized shapes are reported unlinked: the URL is never guessed.
  for (const raw of [
    'ssh://git@git.internal:2222/team/repo.git',
    '/srv/git/bare-repo.git',
    'git@example.com:repo',
    '',
  ]) {
    const remote = describeRemote(raw);
    assert.equal(remote.status, 'unrecognized', raw);
    assert.equal(remote.webUrl, null, raw);
  }
});

test('git config parsing prefers origin and never invents one', () => {
  const source = [
    '[core]', '\trepositoryformatversion = 0',
    '[remote "upstream"]', '\turl = https://github.com/upstream/repo.git',
    '[remote "origin"]', '\turl = git@github.com:pacphi/agentic-kit.git',
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    '[branch "main"]', '\tremote = origin',
  ].join('\n');
  assert.deepEqual(parseGitRemote(source), {
    name: 'origin', url: 'git@github.com:pacphi/agentic-kit.git',
  });
  // No origin, but remotes exist: reporting local-only would be a false negative.
  assert.deepEqual(parseGitRemote('[remote "fork"]\n\turl = https://example.com/a/b.git\n'), {
    name: 'fork', url: 'https://example.com/a/b.git',
  });
  assert.equal(parseGitRemote('[core]\n\tbare = false\n'), null);
});

test('a project with no remote is local-only, and an unreadable config is unknown', (t) => {
  const root = fixture(t, 'remote');
  const bare = path.join(root, 'no-git');
  fs.mkdirSync(bare, { recursive: true });
  assert.equal(projectRemote(bare, { fsImpl: fixtureFs(root) }).status, 'local-only');

  const noRemote = path.join(root, 'no-remote');
  write(path.join(noRemote, '.git', 'config'), '[core]\n\tbare = false\n');
  const local = projectRemote(noRemote, { fsImpl: fixtureFs(root) });
  assert.equal(local.status, 'local-only');
  assert.equal(local.webUrl, null);
  assert.equal(local.reason, null);

  // Unreadable is NOT local-only: absence of evidence is stated as such.
  const denied = projectRemote(noRemote, {
    fsImpl: {
      ...fs,
      readFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    },
  });
  assert.equal(denied.status, 'unknown');
  assert.equal(denied.reason, 'EACCES');
});

/** A project fixture with source, vendored, binary and overhead trees. */
function projectFixture(t) {
  const root = fixture(t, 'project');
  const project = path.join(root, 'repo');
  const tree = {
    'src/a.mjs': 'a\nb\nc',
    'src/b.ts': 'x\ny\n',
    'docs/guide.md': 'one\n',
    'vendor/v.js': 'vendored\nlines\n',
    'pnpm-lock.yaml': 'lockfile: true\n',
    'data.bin': 'no recognized extension\n',
  };
  const sizes = {};
  for (const [rel, content] of Object.entries(tree)) {
    sizes[rel] = write(path.join(project, ...rel.split('/')), content);
  }
  sizes['binary.js'] = write(path.join(project, 'binary.js'), Buffer.from('let x = 1;\n\0\n'));
  const gitBytes = write(path.join(project, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/pacphi/agentic-kit.git\n');
  const moduleBytes = write(path.join(project, 'node_modules', 'pkg', 'index.js'), 'module\n')
    + write(path.join(project, 'node_modules', 'pkg', 'node_modules', 'dep', 'i.js'), 'nested\n');

  const treeBytes = Object.values(sizes).reduce((acc, size) => acc + size, 0);
  return { root, project, sizes, treeBytes, gitBytes, moduleBytes };
}

test('project LOC buckets by extension and excludes vendored, binary and overhead files', (t) => {
  const { root, project } = projectFixture(t);
  const loc = countLines(project, { fsImpl: fixtureFs(root) });

  assert.deepEqual(loc.byLanguage, { javascript: 3, typescript: 2, markdown: 1 });
  assert.equal(loc.total.value, 6);
  assert.equal(loc.total.status, MEASURED);
  assert.equal(loc.total.partial, false, 'a deliberate exclusion is not a failed measurement');
  assert.equal(loc.files, 3);
  assert.equal(loc.skipped, 1, 'the NUL-bearing .js file is skipped, not counted as empty');
  assert.equal(loc.approximate, true);
  assert.equal(loc.complete, true);
  for (const excluded of ['node_modules/', 'vendor/', 'pnpm-lock.yaml']) {
    assert.ok(loc.exclusions.includes(excluded), `${excluded} must be stated alongside the figure`);
  }
  assert.deepEqual(loc.exclusions, LOC_EXCLUSIONS);
});

test('project git and node_modules bytes stay separate from the working tree', (t) => {
  const { root, project, treeBytes, gitBytes, moduleBytes } = projectFixture(t);
  const row = measureProject({ path: project, label: 'repo', source: 'fixture' },
    { fsImpl: fixtureFs(root) });

  assert.equal(row.treeBytes.value, treeBytes);
  assert.equal(row.gitBytes.value, gitBytes);
  assert.equal(row.nodeModulesBytes.value, moduleBytes);
  assert.equal(row.totalBytes.value, treeBytes + gitBytes + moduleBytes);
  assert.deepEqual(row.treeExclusions, ['.git', 'node_modules']);
  assert.equal(row.presence, 'present');
  assert.equal(row.complete, true);
  assert.equal(row.remote.webUrl, 'https://github.com/pacphi/agentic-kit');
  assert.equal(row.lastActivity.status, MEASURED);

  // The top-most node_modules is the only root: a nested copy is already its
  // bytes, so the roots partition rather than overlap.
  assert.deepEqual(nodeModulesRoots(project, { fsImpl: fixtureFs(root) }),
    [path.join(project, 'node_modules')]);

  // A project with no node_modules at all is a measured zero, not an unknown.
  const bare = path.join(root, 'bare');
  write(path.join(bare, 'index.mjs'), 'x\n');
  const bareRow = measureProject({ path: bare, label: 'bare' }, { fsImpl: fixtureFs(root) });
  assert.equal(bareRow.nodeModulesBytes.status, MEASURED);
  assert.equal(bareRow.nodeModulesBytes.value, 0);
  assert.equal(bareRow.gitBytes.value, 0, 'a missing .git holds a real zero bytes');
});

test('a project path that vanished is unknown everywhere, never a zero-byte project', (t) => {
  const root = fixture(t, 'project-missing');
  const row = measureProject({ path: path.join(root, 'gone'), label: 'gone' },
    { fsImpl: fixtureFs(root) });
  assert.equal(row.presence, 'absent');
  for (const figure of [row.treeBytes, row.gitBytes, row.nodeModulesBytes, row.totalBytes,
    row.lastActivity, row.loc.total]) {
    assert.equal(figure.status, UNKNOWN);
    assert.equal(figure.value, null);
  }
  assert.equal(row.remote.status, 'unknown', 'a vanished path is never reported local-only');
  assert.equal(row.complete, false);
});

test('the projects section measures the supplied catalog and reports discovery failure', (t) => {
  const { root, project } = projectFixture(t);
  const seen = [];
  const result = collectProjects({
    projects: [{ path: project, label: 'repo' },
      { path: path.join(root, 'second'), label: 'second' }],
    loc: false, limit: 1, fsImpl: fixtureFs(root),
    onProgress: (payload) => seen.push(payload.phase),
  });
  assert.equal(result.count.value, 2);
  assert.equal(result.scanned, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.locMeasured, false);
  assert.equal(result.projects[0].loc.total.status, UNKNOWN, 'LOC not run is unknown, not zero');
  assert.ok(seen.includes('done'));

  const failed = collectProjects({
    discover: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); },
    fsImpl: fixtureFs(root),
  });
  assert.equal(failed.count.status, UNKNOWN);
  assert.equal(failed.count.value, null, 'a failed discovery is not a machine with no projects');
  assert.equal(failed.complete, false);
});

// ── catalog ───────────────────────────────────────────────────────────────────

/** Host catalog surfaces across claude, codex and opencode, with deliberate
 *  overlap so dedup and the presence matrix have something to prove. */
function catalogFixture(t) {
  const root = fixture(t, 'catalog');
  const claudeRoot = path.join(root, 'claude');
  const codexRoot = path.join(root, 'codex');
  const opencodeRoot = path.join(root, 'opencode');

  // The same skill on two hosts, spelled differently: identity is the
  // normalized name, so this is ONE deployed skill present twice.
  write(path.join(claudeRoot, 'skills', 'Deep-Research', 'SKILL.md'),
    '---\nname: x\n---\nSECRET BODY\n');
  write(path.join(codexRoot, 'skills', 'deep-research', 'SKILL.md'), 'SECRET BODY\n');
  write(path.join(claudeRoot, 'skills', 'claude-only', 'SKILL.md'), 'SECRET BODY\n');
  write(path.join(claudeRoot, 'agents', 'reviewer.md'), 'SECRET BODY\n');
  write(path.join(claudeRoot, 'agents', 'v3', 'qe-tester.md'), 'SECRET BODY\n');
  write(path.join(claudeRoot, 'agents', 'README.md'), 'SECRET BODY\n');
  write(path.join(opencodeRoot, 'agents', 'reviewer.md'), 'SECRET BODY\n');
  write(path.join(claudeRoot, 'commands', 'reviewer.md'), 'SECRET BODY\n');
  write(path.join(claudeRoot, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'beads@marketplace': [{ installPath: path.join(root, 'p') }] } }));

  const claudeMcpFile = path.join(root, 'claude.json');
  write(claudeMcpFile, JSON.stringify({ mcpServers: { ruflo: {}, lightpanda: {} } }));
  const codexConfigFile = path.join(codexRoot, 'config.toml');
  write(codexConfigFile, '[mcp_servers.ruflo]\ncommand = "npx"\n\n[mcp_servers."with.dot"]\n');
  const opencodeConfigFile = path.join(opencodeRoot, 'opencode.json');
  write(opencodeConfigFile, JSON.stringify({ mcp: { ruflo: {} } }));

  return {
    root, claudeRoot, codexRoot, opencodeRoot, agentsRoot: path.join(root, 'agents'),
    claudeMcpFile, codexConfigFile, opencodeConfigFile,
  };
}

test('catalog dedups by normalized name and keeps a per-host presence matrix', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, ...roots } = fixtureRoots;
  const result = collectCatalog({
    ...roots, cwd: root, now: () => 1_700_000_000_000,
    includePluginSurfaces: false, fsImpl: fixtureFs(root),
  });

  const skills = result.items.filter((item) => item.kind === 'skill');
  assert.deepEqual(skills.map((item) => item.name).sort(), ['Deep-Research', 'claude-only']);
  const shared = skills.find((item) => item.name === 'Deep-Research');
  assert.deepEqual(shared.hosts.sort(), ['claude', 'codex', 'opencode'],
    'case and spacing are presentation; the deployed skill is one thing');
  assert.equal(shared.presence.length, 3);
  assert.deepEqual(shared.presence.map((entry) => entry.surface).sort(),
    ['claude-skills', 'codex-skills', 'opencode-claude-skills']);
  const claudeArtifact = shared.artifacts.find((artifact) => artifact.consumers.some((row) => row.host === 'claude'));
  assert.deepEqual(claudeArtifact.consumers.map((row) => row.host).sort(), ['claude', 'opencode'],
    'one physical Claude-compatible skill is exposed to both documented consumers');
  assert.deepEqual(new Set(shared.consumerBindings.map((row) => row.artifactId)).size, 2,
    'consumer bindings preserve two installed copies instead of treating three host edges as three copies');
  assert.equal(shared.digestCoverage.measured, 2,
    'digest coverage counts physical artifacts, not host consumer bindings');
  assert.equal(result.overlaps.exactName.find((group) => group.name === 'deep-research')?.occurrences, 2);
  const claudeMcpArtifacts = result.items.filter((item) => ['ruflo', 'lightpanda'].includes(item.name))
    .flatMap((item) => item.presence.filter((presence) => presence.surface === 'claude-user-mcp'))
    .map((presence) => presence.artifactId);
  assert.equal(new Set(claudeMcpArtifacts).size, 2,
    'separate config entries in one file retain separate artifact identities');

  // Kind is part of identity: a `reviewer` agent and a `reviewer` command are
  // two different deployed things.
  assert.deepEqual(
    result.items.filter((item) => item.name === 'reviewer').map((item) => item.kind).sort(),
    ['agent', 'command']);
  const agents = result.items.filter((item) => item.kind === 'agent').map((item) => item.name);
  assert.deepEqual(agents.sort(), ['reviewer', 'v3:qe-tester']);
  assert.ok(!agents.includes('README'), 'a README documents the surface, it is not an entry on it');

  assert.equal(result.counts.skill.value, 2);
  assert.equal(result.counts.agent.value, 2);
  assert.equal(result.counts.command.value, 1);
  assert.equal(result.counts.mcpServer.value, 3, 'ruflo on three hosts is one server');

  assert.equal(result.perHost.claude.skill.value, 2);
  assert.equal(result.perHost.codex.skill.value, 1);
  assert.equal(result.perHost.opencode.skill.value, 2);
  assert.equal(result.perHost.opencode.agent.value, 1);
  assert.equal(result.perHost.codex.agent.value, 0);
  assert.equal(result.perHost.codex.mcpServer.value, 2);
  assert.equal(result.complete, false, 'fallback plugin inventories keep overall evidence partial');
  assert.deepEqual(result.degraded, []);
  assert.deepEqual(result.partial.sort(), ['claude-plugins', 'codex-plugins']);
});

test('catalog includes project-scoped Codex skills from .agents/skills', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, ...roots } = fixtureRoots;
  const project = path.join(root, 'project');
  write(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(project, '.agents', 'skills', 'project-only', 'SKILL.md'),
    '---\nname: project-only\n---\nSECRET BODY\n');

  const result = collectCatalog({
    ...roots, cwd: project, projects: [], now: () => 1_700_000_000_000,
    includePluginSurfaces: false, fsImpl: fixtureFs(root),
  });

  const skill = result.items.find((item) => item.kind === 'skill' && item.name === 'project-only');
  assert.deepEqual(skill?.hosts, ['codex', 'opencode']);
  assert.equal(skill?.presence[0]?.surface, `codex-project-skills:${project}`);
  assert.equal(result.perHost.codex.skill.value, 2);
  assert.equal(result.surfaces.find((surface) => surface.id === `codex-project-skills:${project}`)?.count, 1);
});

test('catalog exposes project Claude-compatible skills to Claude and OpenCode without duplicating the artifact', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, ...roots } = fixtureRoots;
  const project = path.join(root, 'claude-compatible-project');
  write(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(project, '.claude', 'skills', 'shared-project', 'SKILL.md'),
    '---\nname: shared-project\n---\nshared project skill\n');

  const result = collectCatalog({
    ...roots, cwd: project, now: () => 1_700_000_000_000,
    includePluginSurfaces: false, fsImpl: fixtureFs(root),
  });
  const skill = result.items.find((item) => item.kind === 'skill' && item.name === 'shared-project');
  assert.deepEqual(skill.hosts.sort(), ['claude', 'opencode']);
  assert.equal(skill.artifacts.length, 1);
  assert.deepEqual(skill.artifacts[0].consumers.map((row) => row.host).sort(), ['claude', 'opencode']);
  assert.equal(skill.consumerBindings.every((row) => row.resolution === 'not-reported'), true);
  assert.equal(skill.consumerBindings.find((row) => row.host === 'opencode').mechanism,
    'claude-compatible-directory');
});

test('catalog inventories OpenCode skills.paths as configured consumer bindings', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, opencodeConfigFile, ...roots } = fixtureRoots;
  const configured = path.join(root, 'shared-catalog');
  write(path.join(configured, 'configured-skill', 'SKILL.md'), 'configured skill\n');
  write(opencodeConfigFile, JSON.stringify({ mcp: { ruflo: {} }, skills: { paths: [configured] } }));

  const result = collectCatalog({
    ...roots, opencodeConfigFile, cwd: root, now: () => 1_700_000_000_000,
    includePluginSurfaces: false, fsImpl: fixtureFs(root),
  });
  const skill = result.items.find((item) => item.kind === 'skill' && item.name === 'configured-skill');
  assert.deepEqual(skill.hosts, ['opencode']);
  assert.equal(skill.consumerBindings.length, 1);
  assert.equal(skill.consumerBindings[0].mechanism, 'configured-path');
  assert.equal(skill.consumerBindings[0].configuredBy, 'opencode.json');
  assert.equal(skill.consumerBindings[0].resolution, 'not-reported');
});

test('OpenCode compatibility disablement preserves evidence but excludes the consumer', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, ...roots } = fixtureRoots;
  const result = collectCatalog({
    ...roots, cwd: root, now: () => 1_700_000_000_000,
    includePluginSurfaces: false, fsImpl: fixtureFs(root),
    env: { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1' },
  });
  const skill = result.items.find((item) => item.kind === 'skill' && item.name === 'claude-only');
  assert.deepEqual(skill.hosts, ['claude']);
  assert.equal(skill.consumerBindings.find((binding) => binding.host === 'opencode')?.enabled, false);
  assert.equal(result.perHost.opencode.skill.value, 0);
});

test('configured and conventional views of one skill remain one physical artifact', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, opencodeConfigFile, ...roots } = fixtureRoots;
  write(opencodeConfigFile, JSON.stringify({ skills: { paths: [path.join(roots.claudeRoot, 'skills')] } }));
  const result = collectCatalog({
    ...roots, opencodeConfigFile, cwd: root, now: () => 1_700_000_000_000,
    includePluginSurfaces: false, fsImpl: fixtureFs(root),
  });
  const skill = result.items.find((item) => item.kind === 'skill' && item.name === 'claude-only');
  assert.equal(skill.artifacts.length, 1);
  assert.equal(skill.consumerBindings.length, 3);
  assert.equal(result.overlaps.exactName.some((group) => group.name === 'claude-only'), false,
    'multiple discovery mechanisms do not manufacture a duplicate copy');
});

test('invalid, remote and JSONC-only OpenCode skill paths are explicit partial evidence', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, opencodeConfigFile, ...roots } = fixtureRoots;
  write(opencodeConfigFile, JSON.stringify({ skills: { paths: 'not-an-array' } }));
  const invalid = collectCatalog({
    ...roots, opencodeConfigFile, cwd: root, now: () => 1_700_000_000_000,
    includePluginSurfaces: false, fsImpl: fixtureFs(root),
  });
  assert.equal(invalid.surfaces.find((surface) => surface.id === 'opencode-skill-paths:config')?.status, 'degraded');

  write(opencodeConfigFile, JSON.stringify({ skills: { paths: ['https://example.test/skills'] } }));
  const remote = collectCatalog({
    ...roots, opencodeConfigFile, cwd: root, now: () => 1_700_000_000_000,
    includePluginSurfaces: false, fsImpl: fixtureFs(root),
  });
  const remoteSurface = remote.surfaces.find((surface) => surface.id === 'opencode-skill-paths:config');
  assert.equal(remoteSurface.partial, true);
  assert.match(remoteSurface.reason, /remote/i);
  assert.equal(remote.sourceStamps.entries.some((entry) => /^https?:/.test(entry.path)), false);

  const project = path.join(root, 'jsonc-project');
  write(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(project, 'opencode.jsonc'), '{ // valid JSONC, deliberately not interpreted here\n "skills": {"paths": ["./skills"]}\n}\n');
  const jsonc = collectCatalog({
    ...roots, opencodeConfigFile, cwd: project, projects: [project], now: () => 1_700_000_000_000,
    includePluginSurfaces: false, fsImpl: fixtureFs(root),
  });
  const jsoncSurface = jsonc.surfaces.find((surface) => surface.id === `opencode-project-skill-paths-jsonc:${project}:config`);
  assert.equal(jsoncSurface.status, 'degraded');
  assert.match(jsoncSurface.reason, /jsonc/i);
});

test('catalog inventories project agents, commands and MCP registrations across supported host surfaces', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, ...roots } = fixtureRoots;
  const project = path.join(root, 'project-resources');
  write(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(project, '.claude', 'agents', 'reviewer.md'), 'same agent\n');
  write(path.join(project, '.claude', 'commands', 'ship.md'), 'same command\n');
  write(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { ruflo: { command: 'ruflo', args: ['mcp', 'start'] } } }));
  write(path.join(project, '.codex', 'agents', 'planner.toml'), 'name = "planner"\n');
  write(path.join(project, '.codex', 'config.toml'), '[mcp_servers.ruflo]\ncommand = "ruflo"\nargs = ["mcp", "start"]\n');
  write(path.join(project, '.opencode', 'agents', 'reviewer.md'), 'same agent\n');
  write(path.join(project, '.opencode', 'commands', 'ship.md'), 'same command\n');
  write(path.join(project, '.opencode', 'skills', 'project-open', 'SKILL.md'), 'open skill\n');
  write(path.join(project, 'opencode.json'), JSON.stringify({ mcp: { ruflo: { type: 'local', command: ['ruflo', 'mcp', 'start'] } } }));

  const result = collectCatalog({
    ...roots, cwd: project, projects: [project], now: () => 1_700_000_000_000,
    includePluginSurfaces: false, fsImpl: fixtureFs(root),
    inspectProjectArtifacts: (_project, files) => new Map(files.map((file) => [file, {
      repository: true, tracked: file.endsWith('reviewer.md'), workingTree: 'clean', reason: null,
    }])),
  });

  for (const id of [
    `claude-project-mcp:${project}`, `codex-project-mcp:${project}`,
    `codex-project-agents:${project}`, `opencode-project-agents:${project}`,
    `opencode-project-commands:${project}`, `opencode-project-dot-skills:${project}`,
    `opencode-project-mcp-json:${project}`,
  ]) assert.equal(result.surfaces.find((surface) => surface.id === id)?.status, 'ok', id);
  const claudeAgent = result.items.find((item) => item.kind === 'agent' && item.name === 'reviewer');
  const projectAgent = claudeAgent.presence.find((presence) => presence.host === 'claude' && presence.scope === 'project');
  assert.equal(projectAgent.digest.status, 'measured');
  assert.deepEqual(projectAgent.tracking, { repository: true, tracked: true, workingTree: 'clean', reason: null });
  const mcp = result.items.find((item) => item.kind === 'mcpServer' && item.name === 'ruflo');
  assert.equal(mcp.presence.filter((presence) => presence.scope === 'project').length, 3);
  assert.equal(mcp.presence.filter((presence) => presence.scope === 'project')
    .every((presence) => presence.digest?.status === 'measured'), true);
});

test('catalog never reclassifies a user capability root as project-local', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, ...baseRoots } = fixtureRoots;
  const userHome = path.join(root, 'user-home');
  const claudeRoot = path.join(userHome, '.claude');
  const agentsRoot = path.join(userHome, '.agents');

  write(path.join(claudeRoot, 'skills', 'claude-user', 'SKILL.md'), 'claude user skill\n');
  write(path.join(claudeRoot, 'agents', 'reviewer.md'), 'claude user agent\n');
  write(path.join(claudeRoot, 'commands', 'review.md'), 'claude user command\n');
  write(path.join(agentsRoot, 'skills', 'shared-user', 'SKILL.md'), 'shared user skill\n');

  const result = collectCatalog({
    ...baseRoots, claudeRoot, agentsRoot, cwd: root, projects: [userHome],
    now: () => 1_700_000_000_000, includePluginSurfaces: false, fsImpl: fixtureFs(root),
  });

  for (const item of result.items) {
    const sameFileInTwoScopes = item.presence.some((left) => item.presence.some((right) => (
      left.host === right.host
      && left.sourceFile === right.sourceFile
      && left.scope !== right.scope
    )));
    assert.equal(sameFileInTwoScopes, false,
      `${item.kind}:${item.name} must not be both user- and project-scoped on one host`);
  }

  assert.equal(result.surfaces.some((surface) => surface.scope === 'project'
    && surface.project === userHome), false,
  'a census cwd whose project roots are the user roots contributes no project surfaces');

  const userPressure = result.projects.find((row) => row.project === userHome);
  assert.equal(userPressure, undefined,
    'the user home must not produce a project-pressure record');
  assert.deepEqual(
    result.items.find((item) => item.name === 'shared-user')?.hosts.sort(),
    ['codex', 'opencode'],
    'one shared user skill can legitimately be carried by both hosts',
  );
});

test('catalog hashes bounded entrypoints but never returns their bodies', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, ...roots } = fixtureRoots;
  const reads = [];
  const base = fixtureFs(root);
  const spy = {
    ...base,
    readFileSync: (target, options) => {
      reads.push(String(target));
      return base.readFileSync(target, options);
    },
  };

  const result = collectCatalog({
    ...roots, cwd: root, now: () => 1_700_000_000_000,
    includePluginSurfaces: false, fsImpl: spy,
  });
  assert.ok(reads.some((file) => /SKILL\.md$/.test(file)), 'skill entrypoints are hashed');
  assert.doesNotMatch(JSON.stringify(result), /SECRET BODY/, 'artifact prose must not leave the collector');
});

test('skill definition evidence covers the bounded tree and fails closed on symlinks or caps', (t) => {
  const root = fixture(t, 'catalog-definition');
  const skill = path.join(root, 'skill');
  write(path.join(skill, 'SKILL.md'), 'same entrypoint\n');
  write(path.join(skill, 'references', 'guide.md'), 'first supporting file\n');
  const first = artifactTreeDigest(skill, { fsImpl: fixtureFs(root) });
  assert.equal(first.status, 'measured');
  assert.equal(first.files.length, 2);

  write(path.join(skill, 'references', 'guide.md'), 'different supporting file\n');
  const changed = artifactTreeDigest(skill, { fsImpl: fixtureFs(root) });
  assert.notEqual(first.value, changed.value,
    'matching SKILL.md entrypoints do not imply matching skill definitions');

  const capped = artifactTreeDigest(skill, { fsImpl: fixtureFs(root), maxEntries: 1 });
  assert.equal(capped.status, 'unknown');
  assert.match(capped.reason, /entry limit/);

  try { fs.symlinkSync(path.join(skill, 'SKILL.md'), path.join(skill, 'alias.md')); } catch {
    t.diagnostic('symlink creation unavailable on this platform');
    return;
  }
  const linked = artifactTreeDigest(skill, { fsImpl: fixtureFs(root) });
  assert.equal(linked.status, 'unknown');
  assert.match(linked.reason, /symlink/);
});

test('an unreadable catalog surface has no count, and the total it feeds is a floor', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, ...roots } = fixtureRoots;
  const denied = path.join(roots.codexRoot, 'skills');
  const result = collectCatalog({
    ...roots, cwd: root, now: () => 1_700_000_000_000, includePluginSurfaces: false,
    fsImpl: fixtureFs(root, { deny: [denied] }),
  });

  const surface = result.surfaces.find((entry) => entry.id === 'codex-skills');
  assert.equal(surface.status, 'degraded');
  assert.equal(surface.count, null, 'we did not look, so there is no number');
  assert.equal(surface.reason, 'EACCES');
  // The kinds that surface fed stay measured but become floors; unaffected
  // kinds keep clean totals.
  assert.equal(result.counts.skill.partial, true);
  assert.equal(result.counts.agent.partial, false);
  assert.equal(result.complete, false);
  assert.deepEqual(result.degraded, ['codex-skills']);

  // A surface that simply is not there is a real zero, distinct from the above.
  const absent = result.surfaces.find((entry) => entry.id === 'opencode-commands');
  assert.equal(absent.status, 'absent');
  assert.equal(absent.count, 0);
});

test('plugin-contributed entries are namespaced to the plugin that carries them', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, ...roots } = fixtureRoots;
  // Both layouts in the wild: content at the plugin root, and content under a
  // nested `.claude/`. A plugin using one reports the other absent.
  write(path.join(root, 'p', 'skills', 'deep-dive', 'SKILL.md'), 'SECRET BODY\n');
  write(path.join(root, 'p', '.claude', 'agents', 'helper.md'), 'SECRET BODY\n');
  write(path.join(root, 'p', '.mcp.json'), JSON.stringify({ mcpServers: { plugmcp: {} } }));
  write(path.join(root, 'cp', 'skills', 'grounding', 'SKILL.md'), 'SECRET BODY\n');

  const result = collectCatalog({
    ...roots, cwd: root, now: () => 1_700_000_000_000, fsImpl: fixtureFs(root),
    inspectCodexPlugins: () => ({
      configPresent: true,
      plugins: [{ ref: 'ruvnet-brain@store', root: path.join(root, 'cp') }],
    }),
  });

  const names = result.items.map((item) => `${item.kind}:${item.name}`);
  assert.ok(names.includes('skill:beads:deep-dive'), names.join(' '));
  assert.ok(names.includes('agent:beads:helper'));
  assert.ok(names.includes('mcpServer:beads:plugmcp'));
  assert.ok(names.includes('skill:ruvnet-brain:grounding'));
  // A host's plugin inventory is its enabled refs, kept whole.
  assert.deepEqual(result.items.filter((item) => item.kind === 'plugin').map((item) => item.name),
    ['beads@marketplace', 'ruvnet-brain@store']);
  assert.equal(result.perHost.codex.skill.value, 2,
    'a plugin skill joins the host that carries it');

  // An unreadable codex config is codex's problem, not a reason to lose the
  // rest of the catalog.
  const survived = collectCatalog({
    ...roots, cwd: root, now: () => 1_700_000_000_000, fsImpl: fixtureFs(root),
    inspectCodexPlugins: () => { throw new Error('codex config unreadable'); },
  });
  assert.equal(survived.counts.skill.value >= 2, true);
});

test('standalone and plugin skills stay distinct while exact-name and digest overlap is explicit', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, ...roots } = fixtureRoots;
  const body = '---\nname: shared\nversion: 1.0.0\n---\nBOUNDED BODY\n';
  write(path.join(roots.claudeRoot, 'skills', 'shared', 'SKILL.md'), body);
  write(path.join(root, 'p', 'skills', 'shared', 'SKILL.md'), body);

  const result = collectCatalog({
    ...roots, cwd: root, now: () => 1_700_000_000_000, fsImpl: fixtureFs(root),
  });
  const standalone = result.items.find((item) => item.kind === 'skill' && item.name === 'shared');
  const contributed = result.items.find((item) => item.kind === 'skill' && item.name === 'beads:shared');

  assert.ok(standalone);
  assert.equal(contributed?.pluginRef, 'beads@marketplace');
  assert.equal(contributed?.presence[0]?.provider?.ref, 'beads@marketplace');
  assert.notEqual(standalone.key, contributed.key, 'producer is part of capability identity');
  assert.ok(result.overlaps.exactName.some((group) => group.name === 'shared'
    && group.itemKeys.includes(standalone.key) && group.itemKeys.includes(contributed.key)));
  assert.ok(result.overlaps.exactEntrypointDigest.some((group) => group.itemKeys.includes(standalone.key)
    && group.itemKeys.includes(contributed.key)));
  assert.doesNotMatch(JSON.stringify(result), /BOUNDED BODY/);
});

test('project pressure separates project, user and plugin skill contributions', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, ...roots } = fixtureRoots;
  const project = path.join(root, 'project-pressure');
  const body = 'same bytes\n';
  write(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(project, '.agents', 'skills', 'shared', 'SKILL.md'), body);
  write(path.join(roots.agentsRoot, 'skills', 'shared', 'SKILL.md'), body);
  write(path.join(root, 'p', 'skills', 'plugin-only', 'SKILL.md'), 'plugin\n');

  const result = collectCatalog({
    ...roots, cwd: project, now: () => 1_700_000_000_000, fsImpl: fixtureFs(root),
  });
  const pressure = result.projects.find((row) => row.project === project);
  assert.equal(pressure.byHost.codex.sources.project.skill.value, 1);
  assert.equal(pressure.byHost.codex.sources.user.skill.value >= 1, true);
  assert.equal(pressure.byHost.claude.sources.plugin.skill.value >= 1, true);
  assert.equal(pressure.byHost.codex.overlaps.skillNames.value, 1);
  assert.equal(pressure.byHost.codex.overlaps.skillDigests.value, 1);
  assert.equal(pressure.launching, true, 'launching project is explicit for summary-first rendering');
  assert.equal(pressure.contextInclusion.status, 'unknown');
  assert.match(pressure.guidance[0].nextCommand, /^ak x skills plan --project /);
});

test('native plugin inventory whitelists lifecycle evidence and drops sensitive fields', () => {
  const run = (binary) => ({
    status: 0,
    stdout: binary === 'claude'
      ? JSON.stringify([{ id: 'safe@market', version: '1.2.3', enabled: false,
        scope: 'user', installPath: '/plugins/safe', mcpServers: { secret: { headers: { authorization: 'nope' } } } }])
      : JSON.stringify({ installed: [{ pluginId: 'safe@market', version: '1.2.3', enabled: true,
        installPolicy: 'prompt', source: { source: 'marketplace', document: 'private' }, headers: { token: 'nope' } }] }),
  });
  const result = collectNativePluginInventory({ run });
  assert.equal(result.claude.plugins[0].enabled, false, 'installed-disabled state survives');
  assert.equal(result.codex.plugins[0].sourceKind, 'marketplace');
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /authorization|private|token|mcpServers|headers/);
});

test('native plugin command/schema failures degrade instead of becoming an empty success', () => {
  const result = collectNativePluginInventory({
    run: (binary) => (binary === 'claude'
      ? { status: 1, stdout: '', stderr: 'failed' }
      : { status: 0, stdout: '{"unexpected":true}' }),
  });
  assert.equal(result.claude.status, 'degraded');
  assert.match(result.claude.reason, /exited 1/);
  assert.equal(result.codex.status, 'degraded');
  assert.match(result.codex.reason, /schema/);
});

test('installed-disabled plugins remain inventory but contribute no capabilities', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, ...roots } = fixtureRoots;
  write(path.join(root, 'disabled', 'skills', 'hidden', 'SKILL.md'), 'hidden\n');
  const nativePlugins = {
    claude: { status: 'ok', source: 'fixture', plugins: [{
      ...{ ref: 'disabled@market', name: 'disabled', marketplace: 'market' },
      version: '1.0.0', enabled: false, root: path.join(root, 'disabled'), evidence: 'native',
    }] },
    codex: { status: 'ok', source: 'fixture', plugins: [] },
  };
  const result = collectCatalog({
    ...roots, cwd: root, nativePlugins, fsImpl: fixtureFs(root),
  });
  assert.ok(result.items.some((item) => item.kind === 'plugin' && item.name === 'disabled@market'));
  assert.equal(result.items.some((item) => item.kind === 'skill' && item.name === 'disabled:hidden'), false);
});

test('oversized skill entrypoints remain visible with unknown digest evidence', (t) => {
  const fixtureRoots = catalogFixture(t);
  const { root, ...roots } = fixtureRoots;
  write(path.join(roots.claudeRoot, 'skills', 'large', 'SKILL.md'), Buffer.alloc(1024 * 1024 + 1, 65));
  const result = collectCatalog({
    ...roots, cwd: root, includePluginSurfaces: false, fsImpl: fixtureFs(root),
  });
  const large = result.items.find((item) => item.kind === 'skill' && item.name === 'large');
  assert.ok(large, 'oversize is not omission');
  assert.equal(large.presence[0].digest.status, 'unknown');
  assert.match(large.presence[0].digest.reason, /exceeds/);
});

test('catalog source stamps expose likely cache drift without claiming nested content freshness', (t) => {
  const root = fixture(t, 'catalog-drift');
  const file = path.join(root, 'plugins.json');
  write(file, '{}\n');
  const baseline = buildCatalogSourceStamps({
    surfaces: [{ status: 'ok', path: file }], items: [], fsImpl: fixtureFs(root),
  });
  const unchanged = probeCatalogDrift(baseline, { fsImpl: fixtureFs(root), asOf: 10 });
  assert.equal(unchanged.status, 'unchanged-at-probes');
  assert.match(unchanged.reason, /nested content|deep rescan/);

  write(file, '{"plugin":true}\n');
  const changed = probeCatalogDrift(baseline, { fsImpl: fixtureFs(root), asOf: 20 });
  assert.equal(changed.status, 'changed');
  assert.deepEqual(changed.changed.map((entry) => entry.path), [file]);
  assert.match(changed.reason, /changed since the deep scan/);
});

test('codex MCP table names are read from config.toml without parsing values', () => {
  const source = [
    '[mcp_servers.ruflo]', 'command = "npx"',
    '[mcp_servers."with.dot"]',
    "[mcp_servers.'single']",
    '[other.section]',
  ].join('\n');
  assert.deepEqual(tomlTableNames(source, 'mcp_servers'), ['ruflo', 'with.dot', 'single']);
  assert.deepEqual(tomlTableNames('', 'mcp_servers'), []);
});

// ── session project labels ───────────────────────────────────────────────────
// A claude transcript directory encodes the project path with EVERY separator
// flattened to '-', so `-a-b-tub-vault` could be .../tub-vault or .../tub/vault
// and only the filesystem can say which. A consumer that split on the last
// hyphen would render `tub-vault` as `vault`, which is why the decode happens
// here rather than in a renderer.

test('a decoded project is reported by its basename, hyphens in the name intact', () => {
  // The case a string split gets wrong: the decoded path's LAST segment is
  // `tub-vault`, and splitting the encoded name on '-' would yield `vault`.
  // (decodeClaudeProjectDir itself is covered in footprint-projects; its stat
  // budget makes it unusable against a deep mkdtemp path, so the decode is
  // injected here and this test owns only what labelSessions does with it.)
  const decodeDir = () => '/repos/tub-vault';
  const [row] = labelSessions([{ session: 'a.jsonl', project: '-repos-tub-vault' }], { decodeDir });
  assert.equal(row.projectLabel, 'tub-vault');
  assert.equal(row.projectResolved, true);
  assert.equal(row.project, '-repos-tub-vault', 'the raw key is the tree join key and must survive untouched');
});

test('an undecodable project is FLAGGED, never guessed at', () => {
  // decodeClaudeProjectDir returns null for a directory that no longer exists.
  const encoded = '-repos-gone-for-ever';
  const [row] = labelSessions([{ session: 'a.jsonl', project: encoded }], { decodeDir: () => null });
  assert.equal(row.projectReason, 'gone', 'a POSIX-rooted name that will not resolve IS a deleted project');
  assert.equal(row.projectResolved, false, 'a deleted project cannot be decoded and must say so');
  assert.equal(row.projectLabel, encoded, 'falling back to the encoded name beats inventing one');
});

test('labelSessions leaves an unattributed row alone', () => {
  const [row] = labelSessions([{ session: 'rollout.jsonl', project: null }]);
  assert.equal(Object.hasOwn(row, 'projectLabel'), false);
  assert.equal(Object.hasOwn(row, 'projectResolved'), false);
});

test('labelSessions decodes each distinct project once', () => {
  let calls = 0;
  const decodeDir = (name) => { calls += 1; return `/x/${name}`; };
  const rows = [
    { session: 'a', project: '-p1' }, { session: 'b', project: '-p1' },
    { session: 'c', project: '-p2' }, { session: 'd', project: '-p1' },
  ];
  labelSessions(rows, { decodeDir });
  assert.equal(calls, 2, 'the decode is a filesystem walk; two projects means two walks');
});

test('a decoder that throws degrades that row rather than the whole panel', () => {
  const decodeDir = () => { throw new Error('permission denied'); };
  const [row] = labelSessions([{ session: 'a', project: '-p' }], { decodeDir });
  assert.equal(row.projectResolved, false);
});

test('collectStorage labels the sessions it returns', (t) => {
  const { root, now, roots } = storageFixture(t);
  const result = collectStorage({
    roots, projects: [], now: () => now, detectWorktrees: false, fsImpl: fixtureFs(root),
    decodeDir: (name) => (name === '-repos-keel' ? '/repos/keel' : null),
  });
  const attributed = result.topSessions.filter((s) => s.project);
  assert.ok(attributed.length > 0, 'anti-vacuity: the fixture must produce an attributed session');
  for (const s of attributed) {
    assert.equal(s.projectLabel, 'keel', 'the wiring must reach topSessions, not just exist');
    assert.equal(s.projectResolved, true);
  }
});

test('an undecodable name says WHICH reason — deleted, or never encodable', () => {
  // On Windows every transcript directory carries a drive prefix, which the
  // decoder refuses by design. Reporting those as "deleted" would be a false
  // claim about every row on that platform.
  const [win] = labelSessions([{ session: 'a', project: 'C:-Users-me-proj' }], { decodeDir: () => null });
  assert.equal(win.projectResolved, false);
  assert.equal(win.projectReason, 'encoding', 'nothing was deleted — the name was never decodable');
});

// ── the POSIX `blocks` field, and the platform that does not have it ────────
// `fs.Stats.blocks` is POSIX. On win32 Node reports 0 for every file, and two
// separate places read a zero as meaning something it does not. Both took
// Windows CI down or would have silently under-reported it, so both are pinned
// here rather than only at their shared predicate.

/** lstat that reports zero allocated blocks for every file — what win32 does. */
function zeroBlocksFs(root) {
  const base = fixtureFs(root);
  const zero = (st) => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { blocks: 0 });
  return { ...base, lstatSync: (target) => zero(base.lstatSync(target)) };
}

test('a git config reporting zero blocks is still read, not called a placeholder', (t) => {
  const root = fixture(t, 'remote-zero-blocks');
  const repo = path.join(root, 'repo');
  write(path.join(repo, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/pacphi/agentic-kit.git\n');

  // The bug: every .git/config on Windows stated as an unmaterialized cloud
  // placeholder, so every project reported status 'unknown' and no remote.
  const out = projectRemote(repo, { fsImpl: zeroBlocksFs(root), platform: 'win32' });
  assert.equal(out.status, 'linked', `zero blocks is not evidence of eviction; got ${out.reason}`);
  assert.equal(out.webUrl, 'https://github.com/pacphi/agentic-kit');

  // Anti-vacuity: the identical input on POSIX IS an evicted placeholder, so the
  // platform argument is doing the work rather than the shim being ignored.
  const posix = projectRemote(repo, { fsImpl: zeroBlocksFs(root), platform: 'darwin' });
  assert.equal(posix.status, 'unknown');
  assert.match(posix.reason, /placeholder/);
});

test('allocated size falls back to apparent size where blocks are unusable', (t) => {
  const root = fixture(t, 'alloc-zero-blocks');
  const dir = path.join(root, 'store');
  const bytes = write(path.join(dir, 'a.bin'), 'x'.repeat(4096));

  const desc = { id: 'store', label: 'store', path: dir, allocation: 'blocks' };
  const run = (platform) => collectConsumers({
    roots: [desc], now: () => 1, fsImpl: zeroBlocksFs(root), platform,
  }).rows.find((r) => r.id === 'store');

  // Without the fallback this is 0 bytes for an entire machine, sitting next to
  // a correct apparent total — a measured zero that is not true.
  const win = run('win32');
  assert.ok(win.bytes.value >= bytes, `allocated collapsed to ${win.bytes.value}`);

  // Anti-vacuity: on POSIX a genuine zero-block file really does allocate
  // nothing, so the platform argument is what changed the answer.
  assert.equal(run('darwin').bytes.value, 0);
});

// ── install: managed-tool npm root resolution ───────────────────────────────
// The registry schema permits host.install.npmPackage to be absent (only
// `bin` and `externalInstallPolicy` are required — see validateHostAdapter).
// managedTools() cannot inject a synthetic host into HOST_REGISTRY, so this
// exercises the exact guard it relies on: npmPackageRoot(globalRootDir, pkg)
// must return null instead of throwing when either operand is missing.

test('npmPackageRoot returns null, not a throw, for a host-like entry with no npmPackage', () => {
  assert.equal(npmPackageRoot('/opt/npm/global/node_modules', undefined), null);
  assert.equal(npmPackageRoot('/opt/npm/global/node_modules', null), null);
});

test('npmPackageRoot returns null when the global root itself is unknown', () => {
  assert.equal(npmPackageRoot(null, 'ruflo'), null);
});

test('npmPackageRoot joins the global root and package when both are known', () => {
  assert.equal(
    npmPackageRoot('/opt/npm/global/node_modules', 'ruflo'),
    path.join('/opt/npm/global/node_modules', 'ruflo'),
  );
});

test('managedTools resolves every real registry entry without throwing when a global root is known', () => {
  const tools = managedTools({ globalRootDir: '/opt/npm/global/node_modules' });
  assert.ok(tools.length > 0);
  // Anti-vacuity: real hosts DO carry npmPackage today, so this also proves
  // the guard did not regress the populated-pkg path.
  const ruflo = tools.find((tool) => tool.id === 'ruflo');
  assert.equal(ruflo.root, path.join('/opt/npm/global/node_modules', 'ruflo'));
});

test('managedTools derives npm-only companion footprints from the companion registry', () => {
  const globalRootDir = '/opt/npm/global/node_modules';
  const tools = managedTools({ globalRootDir });

  for (const companion of MANAGED_COMPANION_REGISTRY) {
    const tool = tools.find((candidate) => candidate.id === companion.id);
    assert.deepEqual(tool, {
      id: companion.id,
      label: companion.label,
      pkg: companion.install.npmPackage,
      bin: companion.install.bin,
      kind: 'npm',
      root: path.join(globalRootDir, companion.install.npmPackage),
    });
  }

  const dejaVu = tools.find((tool) => tool.id === 'deja-vu');
  assert.doesNotMatch(JSON.stringify(dejaVu),
    /\.cache[/\\]deja|\.claude|\.codex|\.jsonl\b|index\.db\b/,
    'the footprint measures the npm tree, never deja-vu data or source histories');
});

test('agent-browser is Kit-managed while Vibium remains an observed AQE-owned runtime', () => {
  const globalRootDir = '/opt/npm/global/node_modules';
  assert.deepEqual(observedRuntimeTools({ globalRootDir }), [
    {
      id: 'vibium', label: 'Vibium', pkg: 'vibium', bin: 'vibium', kind: 'npm',
      root: path.join(globalRootDir, 'vibium'), managed: false, updateOwner: 'agentic-qe',
    },
  ]);
  const managed = managedTools({ globalRootDir }).find((tool) => tool.id === 'agent-browser');
  assert.deepEqual(managed, {
    id: 'agent-browser', label: 'agent-browser', pkg: 'agent-browser', bin: 'agent-browser',
    kind: 'npm', root: path.join(globalRootDir, 'agent-browser'), updateOwner: 'agentic-kit',
    consumer: 'ruflo', upstreamOwner: 'vercel-labs',
  });
});

test('browser cache roots honor the two upstream platform contracts without running either CLI', () => {
  const mac = sharedCacheRoots({ env: {}, platform: 'darwin', fsImpl: fs });
  assert.equal(mac.find((row) => row.id === 'agent-browser')?.path,
    path.join(os.homedir(), '.agent-browser', 'browsers'));
  assert.equal(mac.find((row) => row.id === 'vibium')?.path,
    path.join(os.homedir(), 'Library', 'Caches', 'vibium'));

  const linux = sharedCacheRoots({
    env: { XDG_CACHE_HOME: '/cache', VIBIUM_CACHE_DIR: '/vibium-override' },
    platform: 'linux', fsImpl: fs,
  });
  assert.equal(linux.find((row) => row.id === 'vibium')?.path, '/vibium-override');
});

test('browser payload readiness is filesystem-only and Vibium requires a same-revision pair', (t) => {
  const root = fixture(t, 'browser-readiness');
  const fsImpl = fixtureFs(root);
  const agentCache = path.join(root, 'agent-browser');
  const vibiumCache = path.join(root, 'vibium');
  write(path.join(agentCache, 'chrome-152.0.1', 'chrome-linux64', 'chrome'), 'bin');
  write(path.join(vibiumCache, 'chrome-for-testing', '151.0.1', 'chrome'), 'bin');
  write(path.join(vibiumCache, 'chrome-for-testing', '152.0.1', 'chromedriver'), 'driver');

  const agent = browserPayloadReadiness({
    runtime: 'agent-browser', path: agentCache,
  }, { platform: 'linux', fsImpl });
  assert.equal(agent.status, 'ready');
  assert.equal(agent.revision, '152.0.1');

  const incomplete = browserPayloadReadiness({
    runtime: 'vibium', path: vibiumCache,
  }, { platform: 'linux', fsImpl });
  assert.equal(incomplete.status, 'incomplete');
  assert.match(incomplete.reason, /both Chrome and chromedriver/);

  write(path.join(vibiumCache, 'chrome-for-testing', '152.0.1', 'chrome'), 'bin');
  const ready = browserPayloadReadiness({
    runtime: 'vibium', path: vibiumCache,
  }, { platform: 'linux', fsImpl });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.revision, '152.0.1');
  assert.match(ready.driverPath, /chromedriver$/);
});
