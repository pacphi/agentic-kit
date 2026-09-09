// ADR-0048 scan orchestrator — J4 (resumable collection scan), J10 (incomplete
// source truth), and MNT-DSC-011/012/013/016/017/018/019/020.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCheckpointStore } from '../../src/lib/maintenance/discovery/checkpoint.mjs';
import {
  claimsAllowed, createLastGoodSnapshotStore, createProjectEvidenceStore,
} from '../../src/lib/maintenance/discovery/coverage.mjs';
import { createScanHistoryStore } from '../../src/lib/maintenance/discovery/history.mjs';
import { createScanOrchestrator } from '../../src/lib/maintenance/discovery/orchestrator.mjs';
import { walkTree } from '../../src/lib/footprint/walk.mjs';
import { isOpaqueId } from '../../src/lib/maintenance/management/model.mjs';

const INSTALLATION_KEY = 'test-installation-key-0123456789abcdef';
const SOURCE = { sourceId: 'src_collection', kind: 'collection-root', environmentId: 'env_mac', label: 'Collection root' };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-discovery-orchestrator-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A tree wide enough that a tiny work slice needs several partitions AND
 *  several checkpoints inside each partition-driven call to reach completion. */
function buildLargeTree(root, { dirs = 6, filesPerDir = 8 } = {}) {
  for (let d = 0; d < dirs; d += 1) {
    const dir = path.join(root, `dir-${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < filesPerDir; f += 1) fs.writeFileSync(path.join(dir, `file-${f}.txt`), 'x');
  }
  fs.writeFileSync(path.join(root, 'root-file.txt'), 'x');
}

function control(root, dir, overrides = {}) {
  const checkpointStore = createCheckpointStore(path.join(dir, 'checkpoints'), { fsImpl: fs, now: Date.now });
  const historyStore = createScanHistoryStore(path.join(dir, 'history'), { fsImpl: fs, now: Date.now });
  const lastGoodStore = createLastGoodSnapshotStore(path.join(dir, 'snapshot'), { fsImpl: fs, now: Date.now });
  const projectStore = createProjectEvidenceStore(path.join(dir, 'projects'), { fsImpl: fs, now: Date.now });
  const configuration = { listSources: () => [{ ...SOURCE, root }] };
  const events = [];
  const orchestrator = createScanOrchestrator({
    configuration, checkpointStore, historyStore, lastGoodStore, projectStore,
    walk: walkTree, fsImpl: fs, now: Date.now, installationKey: INSTALLATION_KEY,
    workSlice: { entries: 3, ms: 60_000 }, // tiny: forces a checkpoint after nearly every partition
    ceilings: { entries: Infinity, depth: 16 },
    retryPolicy: { maxRestarts: 3 },
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return {
    orchestrator, checkpointStore, historyStore, lastGoodStore, projectStore, events,
  };
}

test('J4: a large collection scan checkpoints, survives a simulated restart, and matches the reference walk', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  buildLargeTree(root);
  const reference = walkTree(root, { fsImpl: fs });

  const first = control(root, controlDir);
  const [afterOne] = await first.orchestrator.start({ sourceIds: [SOURCE.sourceId], maxSlices: 1 });
  assert.equal(afterOne.scanState, 'checkpointed');
  assert.ok(afterOne.visited > 0 && afterOne.visited < reference.entriesSeen, 'one slice should be a strict subset of the full walk');
  assert.deepEqual(first.checkpointStore.list().length, 1);

  // Simulate a process restart: a brand-new orchestrator instance, same
  // durable stores, no in-memory state carried over.
  const second = control(root, controlDir);
  const [published] = await second.orchestrator.resume({ sourceIds: [SOURCE.sourceId] });
  assert.equal(published.scanState, 'published');
  assert.equal(published.visited, reference.entriesSeen, 'resumed total must equal the direct reference walk');

  const coverage = second.orchestrator.coverage();
  assert.equal(coverage[0].state, 'complete');
  assert.equal(coverage[0].pendingPartitions, 0);
  assert.deepEqual(claimsAllowed(coverage), []);
  assert.ok(second.lastGoodStore.current().length === 1);
  // The previous complete inventory remains authoritative until every
  // partition and final validation complete — nothing was published early.
  assert.ok(second.events.some((event) => event.type === 'ScanCompleted'));
});

test('MNT-DSC-016: progress and coverage never carry the scanned root path', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  buildLargeTree(root, { dirs: 2, filesPerDir: 2 });
  const { orchestrator } = control(root, controlDir);
  await orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  const payload = JSON.stringify({ progress: orchestrator.progress(), coverage: orchestrator.coverage() });
  assert.ok(!payload.includes(root));
});

test('J10: a hard entry ceiling stops the source with the exact ceiling and visited count, no absence claim', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  buildLargeTree(root, { dirs: 8, filesPerDir: 10 }); // far more than the ceiling below
  const { orchestrator } = control(root, controlDir, { ceilings: { entries: 15, depth: 16 } });

  const [result] = await orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  assert.equal(result.scanState, 'stopped');
  assert.equal(result.limitingReason, 'safety-ceiling');
  assert.equal(result.ceiling, 'entries');
  assert.ok(result.visited > 0 && result.visited <= 15, `visited (${result.visited}) must not exceed the ceiling`);

  const coverage = orchestrator.coverage();
  assert.equal(coverage[0].state, 'stopped');
  assert.deepEqual(claimsAllowed(coverage), claimsAllowed([{ state: 'stopped' }]));
  assert.notEqual(claimsAllowed(coverage).length, 0, 'an incomplete source must forbid absence/total claims');
});

test('MNT-DSC-011: reaching the work-slice budget checkpoints and yields; it never ends a valid scan', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  buildLargeTree(root, { dirs: 5, filesPerDir: 4 });
  const { orchestrator, checkpointStore } = control(root, controlDir);
  let yields = 0;
  const patched = control(root, controlDir, {
    yieldFn: (cb) => { yields += 1; cb(); },
  });
  const [result] = await patched.orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  assert.equal(result.scanState, 'published');
  assert.ok(yields > 0, 'a multi-partition scan with a tiny work slice must yield at least once');
  assert.equal(checkpointStore.list().length, 0, 'the completed scan leaves no lingering checkpoint');
  void orchestrator;
});

test('pause and resume: a paused source keeps its checkpoint and completes once resumed', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  buildLargeTree(root, { dirs: 5, filesPerDir: 4 });
  const { orchestrator } = control(root, controlDir);
  const [checkpointed] = await orchestrator.start({ sourceIds: [SOURCE.sourceId], maxSlices: 1 });
  assert.equal(checkpointed.scanState, 'checkpointed');

  const paused = orchestrator.pause({ sourceId: SOURCE.sourceId });
  assert.equal(paused.state, 'paused');

  const [published] = await orchestrator.resume({ sourceIds: [SOURCE.sourceId] });
  assert.equal(published.scanState, 'published');
});

test('MNT-DSC-018: stop previews affected work before confirming, then removes the active scan and retains history', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  buildLargeTree(root, { dirs: 5, filesPerDir: 4 });
  const { orchestrator, historyStore } = control(root, controlDir);
  await orchestrator.start({ sourceIds: [SOURCE.sourceId], maxSlices: 1 });

  const unconfirmed = orchestrator.stop({ sourceId: SOURCE.sourceId, confirmed: false });
  assert.equal(unconfirmed.confirmed, false);
  assert.ok(unconfirmed.preview.visited > 0);

  const confirmed = orchestrator.stop({ sourceId: SOURCE.sourceId, confirmed: true });
  assert.equal(confirmed.confirmed, true);
  assert.equal(orchestrator.coverage()[0].state, 'stopped');
  assert.ok(historyStore.list().some((entry) => entry.sourceId === SOURCE.sourceId));
});

test('cancellation is responsive: stop takes effect without waiting for the whole scan', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  buildLargeTree(root, { dirs: 30, filesPerDir: 40 }); // large enough that a full scan is not instantaneous
  const { orchestrator } = control(root, controlDir, { workSlice: { entries: 5, ms: 60_000 } });
  await orchestrator.start({ sourceIds: [SOURCE.sourceId], maxSlices: 2 });
  const before = orchestrator.coverage()[0];
  assert.ok(before.completedPartitions < before.completedPartitions + before.pendingPartitions, 'still mid-scan');
  const result = orchestrator.stop({ sourceId: SOURCE.sourceId, confirmed: true });
  assert.equal(result.confirmed, true);
  assert.equal(orchestrator.coverage()[0].state, 'stopped');
});

test('MNT-DSC-017/020: a source that keeps changing underneath the scan stops after bounded retries, never infinitely', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  buildLargeTree(root, { dirs: 4, filesPerDir: 3 });
  const flakyTarget = path.join(root, 'dir-0');
  let tick = 0;
  const flakyFs = {
    ...fs,
    lstatSync(target, ...rest) {
      const stat = fs.lstatSync(target, ...rest);
      if (path.resolve(target) === path.resolve(flakyTarget)) {
        tick += 1;
        return { ...stat, mtimeMs: stat.mtimeMs + tick, isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile(), isSymbolicLink: () => stat.isSymbolicLink() };
      }
      return stat;
    },
  };
  const { orchestrator, events } = control(root, controlDir, { fsImpl: flakyFs, retryPolicy: { maxRestarts: 1 } });
  const [result] = await orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  assert.equal(result.scanState, 'stopped');
  assert.equal(result.limitingReason, 'source-changed');
  assert.ok(events.some((event) => event.type === 'DiscoverySourceStopped' && event.limitingReason === 'source-changed'));
});

test('MNT-DSC-019: no timer or handle is left running after a scan completes', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  buildLargeTree(root, { dirs: 3, filesPerDir: 3 });
  const before = process._getActiveHandles?.().length ?? 0;
  const { orchestrator } = control(root, controlDir);
  await orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  await new Promise((resolve) => setImmediate(resolve));
  const after = process._getActiveHandles?.().length ?? 0;
  assert.ok(after <= before + 1, 'a completed scan must not leave a watcher or interval running');
});

test('createScanOrchestrator requires an installationKey', () => {
  assert.throws(() => createScanOrchestrator({
    configuration: { listSources: () => [] }, checkpointStore: {}, installationKey: 'short',
  }), /installationKey/);
});

function gitDir(root) { fs.mkdirSync(path.join(root, '.git'), { recursive: true }); }
function gitFile(root, gitdirLine) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitdirLine}\n`);
}

test('the real scan finds git projects per partition using the same detector as preview', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  gitDir(path.join(root, 'alpha'));
  gitDir(path.join(root, 'beta', 'nested-repo'));
  const { orchestrator } = control(root, controlDir);
  const [result] = await orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  assert.equal(result.scanState, 'published');

  const projects = orchestrator.projects({ sourceId: SOURCE.sourceId });
  assert.equal(projects.length, 2);
  assert.ok(projects.every((project) => isOpaqueId(project.projectId, 'prj')));
  assert.ok(projects.every((project) => project.complete === true));
  const breadcrumbs = projects.map((project) => project.breadcrumb.join('/')).sort();
  assert.deepEqual(breadcrumbs, ['alpha', 'nested-repo']);

  const payload = JSON.stringify({ progress: orchestrator.progress(), coverage: orchestrator.coverage(), projects });
  assert.ok(!payload.includes(root), 'the public projects() list must never carry a local path');
});

test('MNT-INV-010/011: same-basename projects get the shortest distinguishing breadcrumb; others just their name', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  gitDir(path.join(root, 'group-a', 'agentic-kit'));
  gitDir(path.join(root, 'group-b', 'agentic-kit'));
  gitDir(path.join(root, 'unrelated', 'deeply', 'nested', 'solo-project'));
  const { orchestrator } = control(root, controlDir);
  await orchestrator.start({ sourceIds: [SOURCE.sourceId] });

  const byBreadcrumb = Object.fromEntries(orchestrator.projects({ sourceId: SOURCE.sourceId })
    .map((project) => [project.breadcrumb.join('/'), project]));
  assert.ok(byBreadcrumb['group-a/agentic-kit']);
  assert.ok(byBreadcrumb['group-b/agentic-kit']);
  // A unique basename needs no path context at all — just its own name.
  assert.ok(byBreadcrumb['solo-project']);
});

test('repository identity: a linked worktree shares a repositoryKey with its main checkout', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  gitDir(path.join(root, 'main-repo'));
  gitFile(path.join(root, 'worktree-checkout'), path.join(root, 'main-repo', '.git', 'worktrees', 'feature'));
  const { orchestrator } = control(root, controlDir);
  await orchestrator.start({ sourceIds: [SOURCE.sourceId] });

  const projects = orchestrator.projects({ sourceId: SOURCE.sourceId });
  const main = projects.find((p) => p.breadcrumb.join('/') === 'main-repo');
  const worktree = projects.find((p) => p.breadcrumb.join('/') === 'worktree-checkout');
  assert.ok(main && worktree);
  assert.equal(worktree.worktree, true);
  assert.equal(main.repositoryKey, worktree.repositoryKey);
  assert.ok(!main.worktree);
});

test('an exact-project source whose root is ITSELF a git checkout is discovered', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  gitDir(root);
  fs.writeFileSync(path.join(root, 'README.md'), 'hi');
  const { orchestrator } = control(root, controlDir, {
    configuration: { listSources: () => [{ ...SOURCE, kind: 'exact-project', root }] },
  });
  await orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  const [project] = orchestrator.projects({ sourceId: SOURCE.sourceId });
  assert.ok(project, 'the source root itself must be recorded as a project');
  assert.deepEqual(project.breadcrumb, []);
});

test('projectRoots() is owner-private and returns the real absolute paths', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  gitDir(path.join(root, 'alpha'));
  const { orchestrator } = control(root, controlDir);
  await orchestrator.start({ sourceIds: [SOURCE.sourceId] });

  const roots = orchestrator.projectRoots({ sourceId: SOURCE.sourceId });
  const [projectId] = roots.keys();
  assert.ok(isOpaqueId(projectId, 'prj'));
  assert.equal(roots.get(projectId), path.join(root, 'alpha'));
});

test('a partial (stopped) source reports its projects as non-exhaustive and never overwrites persisted complete evidence', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  gitDir(path.join(root, 'alpha'));
  gitDir(path.join(root, 'beta'));

  // First: a clean full scan publishes and persists two complete projects.
  const first = control(root, controlDir);
  await first.orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  assert.equal(first.orchestrator.projects({ sourceId: SOURCE.sourceId }).length, 2);

  // Second run on the SAME durable stores, but forced to stop mid-scan.
  gitDir(path.join(root, 'gamma'));
  const second = control(root, controlDir);
  await second.orchestrator.start({ sourceIds: [SOURCE.sourceId], maxSlices: 1 });
  const live = second.orchestrator.projects({ sourceId: SOURCE.sourceId });
  assert.equal(live.every((project) => project.complete === false), true, 'a still-scanning source is never claimed complete');
  second.orchestrator.stop({ sourceId: SOURCE.sourceId, confirmed: true });

  // The persisted evidence store must still hold the LAST COMPLETE list —
  // the interrupted second run never got to publish, so it never wrote.
  const persisted = second.projectStore.readProjects(SOURCE.sourceId);
  assert.equal(persisted.length, 2);
  assert.ok(persisted.every((project) => project.complete === true));
});

test('projects()/projectRoots() fall back to persisted evidence with no in-memory record', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  gitDir(path.join(root, 'alpha'));
  const first = control(root, controlDir);
  await first.orchestrator.start({ sourceIds: [SOURCE.sourceId] });

  // A brand-new orchestrator instance that has never touched this source.
  const second = control(root, controlDir);
  const projects = second.orchestrator.projects({ sourceId: SOURCE.sourceId });
  assert.equal(projects.length, 1);
  const roots = second.orchestrator.projectRoots({ sourceId: SOURCE.sourceId });
  assert.equal(roots.size, 1);
});

test('projects() reports present instruction files with a digest, omitting absent candidates and content', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  const projectRoot = path.join(root, 'alpha');
  gitDir(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '# hello\n');
  fs.mkdirSync(path.join(projectRoot, '.claude'));
  fs.writeFileSync(path.join(projectRoot, '.claude', 'CLAUDE.md'), '# nested\n');
  // AGENTS.md, CLAUDE.local.md, .codex/AGENTS.md are all intentionally absent.

  const { orchestrator } = control(root, controlDir);
  await orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  const [project] = orchestrator.projects({ sourceId: SOURCE.sourceId });

  const byName = Object.fromEntries(project.instructionFiles.map((f) => [f.name, f]));
  assert.equal(project.instructionFiles.length, 2);
  assert.equal(byName['CLAUDE.md'].host, 'claude');
  assert.equal(byName['CLAUDE.md'].digest, createHash('sha256').update('# hello\n').digest('hex'));
  assert.equal(byName['.claude/CLAUDE.md'].digest, createHash('sha256').update('# nested\n').digest('hex'));
  assert.ok(!('AGENTS.md' in byName), 'an absent candidate must not appear at all');
  const payload = JSON.stringify(project);
  assert.ok(!payload.includes('# hello'), 'raw content must never be retained, only its digest');
});

test('projects() omits the digest for an instruction file over the 256 KiB ceiling but still reports it present', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  const projectRoot = path.join(root, 'alpha');
  gitDir(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'x'.repeat(300 * 1024));

  const { orchestrator } = control(root, controlDir);
  await orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  const [project] = orchestrator.projects({ sourceId: SOURCE.sourceId });
  const [file] = project.instructionFiles;
  assert.equal(file.name, 'AGENTS.md');
  assert.equal(file.host, 'codex');
  assert.ok(!('digest' in file));
});

test('submodules are excluded by default and included with submoduleOfProjectId only when opted in', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  gitDir(path.join(root, 'main-repo'));
  gitFile(
    path.join(root, 'main-repo', 'libs', 'sub'),
    path.join(root, 'main-repo', '.git', 'modules', 'sub'),
  );

  const excluded = control(root, controlDir);
  await excluded.orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  const withoutOptIn = excluded.orchestrator.projects({ sourceId: SOURCE.sourceId });
  assert.equal(withoutOptIn.length, 1, 'a submodule is not a project by default');

  const included = control(root, path.join(controlDir, 'second'), { includeSubmodules: true });
  await included.orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  const withOptIn = included.orchestrator.projects({ sourceId: SOURCE.sourceId });
  const main = withOptIn.find((p) => p.breadcrumb.join('/') === 'main-repo');
  const sub = withOptIn.find((p) => p.breadcrumb.join('/').endsWith('sub'));
  assert.equal(withOptIn.length, 2);
  assert.equal(sub.submoduleOfProjectId, main.projectId);
  assert.ok(!sub.worktree);
  assert.ok(!sub.repositoryKey);
});

test('QE D3: coverage() enumerates every configured source, marking an untouched one not-scanned rather than scanning', async (t) => {
  const controlDir = fixture(t);
  const rootA = fixture(t);
  const rootB = fixture(t);
  buildLargeTree(rootA, { dirs: 1, filesPerDir: 1 });
  const SOURCE_B = { sourceId: 'src_other', kind: 'collection-root', environmentId: 'env_mac', label: 'Other source' };
  const configuration = { listSources: () => [{ ...SOURCE, root: rootA }, { ...SOURCE_B, root: rootB }] };
  const { orchestrator } = control(rootA, controlDir, { configuration });

  // Only source A is ever driven; source B is configured but never touched.
  await orchestrator.start({ sourceIds: [SOURCE.sourceId] });

  const coverage = orchestrator.coverage();
  assert.equal(coverage.length, 2, 'every configured source must appear, not only the ones touched');
  const byId = Object.fromEntries(coverage.map((entry) => [entry.sourceId, entry]));
  assert.equal(byId[SOURCE.sourceId].state, 'complete');
  assert.deepEqual(byId[SOURCE_B.sourceId], {
    sourceId: SOURCE_B.sourceId, environmentId: SOURCE_B.environmentId, state: 'not-scanned',
    visited: 0, estimated: null, completedPartitions: 0, pendingPartitions: 0,
    limitingReason: null, lastCompletedAt: null, label: SOURCE_B.label,
  });

  // A brand-new orchestrator instance, same durable stores, touches nothing:
  // source A's COMPLETE state must survive from the last-good snapshot, and
  // source B still reports not-scanned rather than being silently dropped.
  const fresh = control(rootA, controlDir, { configuration });
  const freshCoverage = fresh.orchestrator.coverage();
  const freshById = Object.fromEntries(freshCoverage.map((entry) => [entry.sourceId, entry]));
  assert.equal(freshById[SOURCE.sourceId].state, 'complete');
  assert.equal(freshById[SOURCE_B.sourceId].state, 'not-scanned');
});


test('MNT-DSC-003/D9b: a curated skip policy keeps a host source out of its transcript trees and it still completes', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'skills', 'clarity'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'clarity', 'SKILL.md'), '# skill');
  let deep = path.join(root, 'projects');
  for (let level = 0; level < 12; level += 1) {
    deep = path.join(deep, `level-${level}`);
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, `transcript-${level}.jsonl`), '{}');
  }
  const source = { ...SOURCE, root, kind: 'automatic', label: 'Claude user configuration', skipDirs: ['projects'], maxDepth: 6 };
  const { orchestrator } = control(root, controlDir, {
    configuration: { listSources: () => [source] },
    ceilings: { entries: 40, depth: 4 },
  });
  await orchestrator.start({ sourceIds: [source.sourceId] });
  const [coverage] = orchestrator.coverage();
  assert.equal(coverage.state, 'complete', `expected complete, got ${coverage.state} (${coverage.limitingReason})`);
  assert.deepEqual(coverage.curatedSkips, ['projects']);
  assert.ok(coverage.visited < 10, `the transcript tree must not be walked (visited ${coverage.visited})`);
});

test('D9b: a per-source depth bound is coverage evidence, never a safety-ceiling stop', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  let deep = root;
  for (let level = 0; level < 8; level += 1) {
    deep = path.join(deep, `d${level}`);
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'f.txt'), 'x');
  }
  const source = { ...SOURCE, root, kind: 'automatic', label: 'Codex user configuration', skipDirs: [], maxDepth: 3 };
  const { orchestrator } = control(root, controlDir, {
    configuration: { listSources: () => [source] },
    ceilings: { entries: Infinity, depth: 16 },
  });
  await orchestrator.start({ sourceIds: [source.sourceId] });
  const [coverage] = orchestrator.coverage();
  assert.equal(coverage.state, 'complete', `expected complete, got ${coverage.state} (${coverage.limitingReason})`);
  assert.equal(coverage.curatedDepthBounded, true);
  assert.equal(coverage.limitingReason, null);
});

test('a missing source root finalizes as failed with io-failure, never stalling in scanning', async (t) => {
  const controlDir = fixture(t);
  const parent = fixture(t);
  const missingRoot = path.join(parent, 'does-not-exist');
  const { orchestrator } = control(missingRoot, controlDir);
  const [result] = await orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  assert.equal(result.scanState, 'failed');
  assert.equal(result.limitingReason, 'io-failure');
  assert.equal(orchestrator.coverage()[0].state, 'failed');
});

test('an unreadable source root finalizes as failed with permission-denied', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  const deniedFs = {
    ...fs,
    readdirSync(target, ...rest) {
      if (path.resolve(target) === path.resolve(root)) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return fs.readdirSync(target, ...rest);
    },
  };
  const { orchestrator } = control(root, controlDir, { fsImpl: deniedFs });
  const [result] = await orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  assert.equal(result.scanState, 'failed');
  assert.equal(result.limitingReason, 'permission-denied');
});

test('an empty-but-readable source root reaches complete with visited 0, not a stall', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t); // mkdtemp'd, exists, and is empty
  const { orchestrator } = control(root, controlDir);
  const [result] = await orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  assert.equal(result.scanState, 'published');
  assert.equal(result.visited, 0);
  assert.equal(orchestrator.coverage()[0].state, 'complete');
});

test('a failed source can be retried: a later successful drive still reaches complete', async (t) => {
  const controlDir = fixture(t);
  const parent = fixture(t);
  const root = path.join(parent, 'appears-later');
  const { orchestrator } = control(root, controlDir);
  const [failed] = await orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  assert.equal(failed.scanState, 'failed');

  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  const [retried] = await orchestrator.start({ sourceIds: [SOURCE.sourceId] });
  assert.equal(retried.scanState, 'published');
});

test('pause() on a non-pausable source throws with code SOURCE_NOT_PAUSABLE', async (t) => {
  const controlDir = fixture(t);
  const root = fixture(t);
  buildLargeTree(root, { dirs: 1, filesPerDir: 1 });
  const { orchestrator } = control(root, controlDir);
  await orchestrator.start({ sourceIds: [SOURCE.sourceId] }); // reaches published/complete

  assert.throws(
    () => orchestrator.pause({ sourceId: SOURCE.sourceId }),
    (error) => error.code === 'SOURCE_NOT_PAUSABLE',
  );
});

test('scan history rolls over independently at ten records per source and survives reopening', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-history-window-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.parse('2026-09-08T12:00:00Z');
  const store = createScanHistoryStore(dir, { now: () => now });
  for (let round = 0; round < 12; round++) {
    for (const sourceId of ['claude', 'codex']) {
      store.recordSummary({ sourceId, environmentId: 'local', state: 'published', visited: round,
        completedAt: new Date(now - (12 - round) * 60000).toISOString() });
    }
  }
  const reopened = createScanHistoryStore(dir, { now: () => now });
  for (const sourceId of ['claude', 'codex']) {
    assert.deepEqual(reopened.list().filter((row) => row.sourceId === sourceId).map((row) => row.visited),
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  }
});
