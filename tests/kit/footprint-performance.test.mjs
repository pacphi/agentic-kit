import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectConsumers } from '../../src/lib/footprint/consumers.mjs';
import { npxEnvNodes } from '../../src/lib/footprint/install.mjs';
import { collectProjects } from '../../src/lib/footprint/projects.mjs';
import {
  adoptedConsumerFigures, collectStorage, STORAGE_DEFAULTS, worktreeReclaimables,
} from '../../src/lib/footprint/storage.mjs';
import { runtimeVersionReclaimables } from '../../src/lib/footprint/storage-reclaim-detectors.mjs';
import { measured, walkTree } from '../../src/lib/footprint/walk.mjs';

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ak-footprint-perf-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('allocated-size consumers reuse the walker stat instead of lstatting every file twice', (t) => {
  const root = fixture(t, 'allocated');
  fs.writeFileSync(path.join(root, 'one.bin'), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(root, 'two.bin'), Buffer.alloc(8192, 2));

  let lstats = 0;
  const fsImpl = {
    ...fs,
    lstatSync(target, options) {
      lstats += 1;
      return fs.lstatSync(target, options);
    },
  };
  const expectedAllocated = ['one.bin', 'two.bin']
    .map((name) => fs.lstatSync(path.join(root, name)).blocks * 512)
    .reduce((total, bytes) => total + bytes, 0);

  const result = collectConsumers({
    roots: [{ id: 'allocated', label: 'allocated', path: root, allocation: 'blocks' }],
    fsImpl,
    platform: 'darwin',
    now: () => 1,
  });
  const row = result.rows.find((candidate) => candidate.id === 'allocated');

  assert.equal(row.bytes.value, expectedAllocated);
  assert.equal(row.basis, 'allocated-blocks');
  assert.equal(lstats, 3, 'one root and two files should each be lstatted exactly once');
});

test('consumers derive exact nested rows from one complete parent observation', (t) => {
  const root = fixture(t, 'consumer-containment');
  const child = path.join(root, 'runtime');
  const nested = path.join(child, 'lib', 'node_modules');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, 'root.txt'), 'root');
  fs.writeFileSync(path.join(child, 'runtime.txt'), 'runtime');
  fs.writeFileSync(path.join(nested, 'package.js'), 'package');
  let walks = 0;

  const result = collectConsumers({
    roots: [
      { id: 'root', label: 'root', group: 'system', path: root, note: 'fixture root' },
      { id: 'runtime', label: 'runtime', group: 'system', path: child, note: 'fixture child' },
      { id: 'packages', label: 'packages', group: 'system', path: nested, note: 'fixture grandchild' },
    ],
    walk(target, options) {
      walks += 1;
      return walkTree(target, options);
    },
    now: () => 1,
  });

  assert.equal(walks, 1, 'a complete root walk supplies every exact nested breakdown');
  assert.equal(result.rows.find((row) => row.id === 'runtime')?.bytes.value,
    Buffer.byteLength('runtime') + Buffer.byteLength('package'));
  assert.equal(result.rows.find((row) => row.id === 'packages')?.bytes.value,
    Buffer.byteLength('package'));
  assert.equal(result.rows.find((row) => row.id === 'packages')?.measuredBy,
    'parent-observation');
});

test('consumers remeasure nested rows when a parent observation is incomplete', (t) => {
  const root = fixture(t, 'consumer-containment-fallback');
  const child = path.join(root, 'child');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(root, 'root.txt'), 'root');
  fs.writeFileSync(path.join(child, 'child.txt'), 'child');
  let walks = 0;

  collectConsumers({
    roots: [
      { id: 'root', label: 'root', group: 'system', path: root, note: 'fixture root' },
      { id: 'child', label: 'child', group: 'system', path: child, note: 'fixture child' },
    ],
    walk(target, options) {
      walks += 1;
      return walkTree(target, target === root ? { ...options, maxEntries: 1 } : options);
    },
    now: () => 1,
  });

  assert.equal(walks, 2,
    'a partial parent is a lower bound and cannot replace the narrower child measurement');
});

test('storage reuses same-scan Install npx facts instead of walking every environment again', (t) => {
  const root = fixture(t, 'npx-adoption');
  const cache = path.join(root, 'npm-cache');
  const npxRoot = path.join(cache, '_npx');
  const env = path.join(npxRoot, 'fixture-env');
  const now = Date.now();
  fs.mkdirSync(path.join(env, 'node_modules', 'example'), { recursive: true });
  fs.writeFileSync(path.join(env, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }));
  fs.writeFileSync(path.join(env, 'node_modules', 'example', 'index.js'), 'module.exports = 1;\n');
  for (const file of [path.join(env, 'package.json'), path.join(env, 'node_modules', 'example', 'index.js')]) {
    fs.utimesSync(file, new Date(now - 120 * 86_400_000), new Date(now - 120 * 86_400_000));
  }

  const previousCache = process.env.npm_config_cache;
  process.env.npm_config_cache = cache;
  t.after(() => {
    if (previousCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = previousCache;
  });

  let installWalks = 0;
  const install = {
    asOf: now,
    npxEnvs: npxEnvNodes({
      root: npxRoot,
      asOf: now,
      walk(target, options) {
        installWalks += 1;
        return walkTree(target, options);
      },
    }),
  };
  let storageWalks = 0;
  const result = collectStorage({
    roots: [],
    projects: [],
    install,
    now: () => now,
    reclaim: { ...STORAGE_DEFAULTS },
    detectCaches: false,
    detectWorktrees: false,
    detectOrphanedTranscripts: false,
    walk(target, options) {
      storageWalks += 1;
      return walkTree(target, options);
    },
  });

  assert.equal(installWalks, 1, 'Install measures the one npx environment once');
  assert.equal(storageWalks, 0, 'Storage must consume Install evidence without a second tree walk');
  assert.equal(result.reclaimables.length, 1);
  assert.equal(result.reclaimables[0].path, env);
  assert.equal(result.reclaimables[0].basis.idle, true);
});

test('npx environments reuse one complete parent-cache observation', (t) => {
  const root = fixture(t, 'npx-parent-observation');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(first, 'package.json'), JSON.stringify({ dependencies: { alpha: '1' } }));
  fs.writeFileSync(path.join(second, 'package.json'), JSON.stringify({ dependencies: { beta: '1' } }));

  let walks = 0;
  const result = npxEnvNodes({
    root,
    asOf: 7,
    parentObservation: {
      root,
      complete: true,
      children: new Map([
        ['first', { bytes: 101, files: 3, newestMtimeMs: 5 }],
        ['second', { bytes: 202, files: 4, newestMtimeMs: 6 }],
      ]),
    },
    walk() { walks += 1; throw new Error('complete parent evidence should be reused'); },
  });

  assert.equal(walks, 0);
  assert.deepEqual(result.envs.map((env) => ({
    id: env.id, bytes: env.bytes.value, files: env.files.value, measuredBy: env.measuredBy,
  })), [
    { id: 'second', bytes: 202, files: 4, measuredBy: 'parent-observation' },
    { id: 'first', bytes: 101, files: 3, measuredBy: 'parent-observation' },
  ]);
});

test('npx environments reject an incomplete parent-cache observation', (t) => {
  const root = fixture(t, 'npx-parent-fallback');
  const env = path.join(root, 'env');
  fs.mkdirSync(env, { recursive: true });
  fs.writeFileSync(path.join(env, 'package.json'), JSON.stringify({ dependencies: { alpha: '1' } }));

  let walks = 0;
  const result = npxEnvNodes({
    root,
    parentObservation: { root, complete: false, children: new Map() },
    walk(target, options) { walks += 1; return walkTree(target, options); },
  });

  assert.equal(walks, 1);
  assert.equal(result.envs[0]?.measuredBy, 'direct');
  assert.ok((result.envs[0]?.bytes.value ?? 0) > 0);
});

test('storage rejects npx evidence that is stale or not rooted at an immediate cache child', (t) => {
  const root = fixture(t, 'npx-fallback');
  const cache = path.join(root, 'npm-cache');
  const npxRoot = path.join(cache, '_npx');
  const env = path.join(npxRoot, 'fixture-env');
  const now = Date.now();
  fs.mkdirSync(env, { recursive: true });
  fs.writeFileSync(path.join(env, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }));
  fs.utimesSync(path.join(env, 'package.json'), new Date(now - 120 * 86_400_000), new Date(now - 120 * 86_400_000));

  const previousCache = process.env.npm_config_cache;
  process.env.npm_config_cache = cache;
  t.after(() => {
    if (previousCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = previousCache;
  });

  const facts = npxEnvNodes({ root: npxRoot, asOf: now });
  facts.envs[0] = { ...facts.envs[0], path: path.join(root, 'outside', facts.envs[0].id) };
  let fallbackWalks = 0;
  const result = collectStorage({
    roots: [],
    projects: [],
    install: { asOf: now, npxEnvs: facts },
    now: () => now,
    detectCaches: false,
    detectWorktrees: false,
    detectOrphanedTranscripts: false,
    walk(target, options) {
      fallbackWalks += 1;
      return walkTree(target, options);
    },
  });

  assert.equal(fallbackWalks, 1, 'untrusted reuse evidence must fall back to a fresh bounded walk');
  assert.equal(result.reclaimables[0].path, env);
});

test('runtime review reuses a complete same-scan Consumers tool aggregate', (t) => {
  const root = fixture(t, 'runtime-consumer-adoption');
  const installs = path.join(root, 'installs');
  const tool = path.join(installs, 'node');
  const first = path.join(tool, '20.0.0');
  const second = path.join(tool, '22.0.0');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(first, 'node'), 'first');
  fs.writeFileSync(path.join(second, 'node'), 'second');
  fs.writeFileSync(path.join(tool, '.backend'), 'meta');
  const asOf = 11;
  const consumers = {
    asOf,
    rows: [{
      path: tool,
      residual: false,
      presence: 'present',
      complete: true,
      bytes: measured(15, { asOf }),
      files: measured(3, { asOf }),
      newestMtimeMs: 10,
    }],
  };
  let walks = 0;
  const ctx = {
    asOf,
    opts: { maxFamilyWalks: 8, samplePaths: 4 },
    walk(target, options) { walks += 1; return walkTree(target, options); },
    limits: {},
    fsImpl: fs,
    adopt: adoptedConsumerFigures(consumers),
  };
  const roots = [{
    id: 'mise-installs', kind: 'installed-runtime-versions', label: 'mise',
    path: installs, manager: 'mise', cleanupHint: 'review',
  }];

  const adopted = runtimeVersionReclaimables(ctx, roots);
  assert.equal(walks, 0);
  assert.equal(adopted[0]?.bytes.value, 11);
  assert.equal(adopted[0]?.files.value, 2);
  assert.equal(adopted[0]?.measuredBy, 'consumers');

  fs.mkdirSync(path.join(tool, '.metadata'), { recursive: true });
  fs.writeFileSync(path.join(tool, '.metadata', 'state'), 'not part of a version');
  const fallback = runtimeVersionReclaimables(ctx, roots);
  assert.equal(walks, 2, 'a hidden directory makes the aggregate scope incompatible');
  assert.equal(fallback[0]?.measuredBy, 'storage');
});

test('worktree review reuses a complete same-scan Project footprint', (t) => {
  const root = fixture(t, 'worktree-project-adoption');
  const now = Date.now();
  const project = path.join(root, 'repo');
  const checkout = path.join(root, 'checkout');
  const record = path.join(project, '.git', 'worktrees', 'feature');
  fs.mkdirSync(checkout, { recursive: true });
  fs.mkdirSync(record, { recursive: true });
  fs.writeFileSync(path.join(record, 'gitdir'), `${path.join(checkout, '.git')}\n`);
  let walks = 0;
  const rows = worktreeReclaimables({
    asOf: now,
    projects: [project],
    projectFootprints: [{
      path: checkout,
      totalBytes: measured(4096, { asOf: now }),
      totalFiles: measured(3, { asOf: now }),
      footprintMtime: measured(now - 200 * 86_400_000, { asOf: now }),
      complete: true,
    }],
    opts: { ...STORAGE_DEFAULTS },
    walk() { walks += 1; throw new Error('same-scan Project evidence should be reused'); },
    limits: {},
    fsImpl: fs,
  });

  assert.equal(walks, 0);
  assert.equal(rows[0]?.bytes.value, 4096);
  assert.equal(rows[0]?.files.value, 3);
  assert.match(rows[0]?.rationale ?? '', /200d/);

  walks = 0;
  worktreeReclaimables({
    asOf: now,
    projects: [project],
    projectFootprints: [{
      path: checkout,
      totalBytes: measured(4096, { asOf: now }),
      totalFiles: measured(3, { asOf: now }),
      footprintMtime: measured(now - 200 * 86_400_000, { asOf: now }),
      complete: false,
    }],
    opts: { ...STORAGE_DEFAULTS },
    walk(target, options) { walks += 1; return walkTree(target, options); },
    limits: {},
    fsImpl: fs,
  });
  assert.equal(walks, 1, 'partial Project evidence must fall back to the checkout walk');
});

test('projects measure only hosted repositories with recorded sessions and count every exclusion', (t) => {
  const root = fixture(t, 'project-population');
  const make = (name, remote) => {
    const project = path.join(root, name);
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    fs.writeFileSync(path.join(project, 'index.js'), 'export default 1;\n');
    if (remote !== null) {
      fs.writeFileSync(path.join(project, '.git', 'config'),
        remote === '' ? '[core]\n\trepositoryformatversion = 0\n'
          : `[remote "origin"]\n\turl = ${remote}\n`);
    }
    return project;
  };
  const eligible = make('eligible', 'git@github.com:pacphi/eligible.git');
  const localOnly = make('local-only', '');
  const insecure = make('http-only', 'http://git.example.test/team/repo.git');
  const unrecognized = make('unrecognized', 'file:///srv/git/repo.git');
  const unknown = make('unknown', null);
  const noSession = make('no-session', 'https://gitlab.com/team/no-session.git');
  const projects = [
    { path: eligible, label: 'eligible', hosts: ['claude'], exists: true },
    { path: localOnly, label: 'local-only', hosts: ['codex'], exists: true },
    { path: insecure, label: 'http-only', hosts: ['claude'], exists: true },
    { path: unrecognized, label: 'unrecognized', hosts: ['opencode'], exists: true },
    { path: unknown, label: 'unknown', hosts: ['claude'], exists: true },
    { path: noSession, label: 'no-session', hosts: [], exists: true },
  ];
  const walked = [];
  const unknownConfig = path.join(unknown, '.git', 'config');
  const fsImpl = {
    ...fs,
    lstatSync(target, options) {
      if (path.resolve(target) === path.resolve(unknownConfig)) {
        throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
      }
      return fs.lstatSync(target, options);
    },
    readFileSync(target, options) {
      if (path.resolve(target) === path.resolve(unknownConfig)) {
        throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
      }
      return fs.readFileSync(target, options);
    },
  };
  const result = collectProjects({
    sources: {
      projects,
      everSeen: projects.length,
      onDisk: projects.length,
      gitRepos: projects.length,
      unresolved: 0,
      complete: true,
      method: 'fixture discovery',
      sources: {},
    },
    loc: false,
    walk(target, options) {
      walked.push(target);
      return walkTree(target, options);
    },
    fsImpl,
    now: () => 1,
  });

  assert.deepEqual(result.projects.map((project) => project.path), [eligible]);
  assert.equal(walked.some((target) => target.startsWith(localOnly)), false);
  assert.equal(walked.some((target) => target.startsWith(insecure)), false);
  assert.equal(result.everSeen.value, 6);
  assert.equal(result.onDisk.value, 6);
  assert.equal(result.gitRepos.value, 6);
  assert.deepEqual(result.population, {
    kind: 'hosted-repositories-with-recorded-session',
    eligible: 1,
    measured: 1,
    excluded: {
      total: 5,
      noRecordedSession: 1,
      noHttpsRemote: 4,
      byRemoteStatus: { localOnly: 1, insecureHttp: 1, unrecognized: 1, unknown: 1 },
    },
  });
});

test('project measurement reuses node_modules roots observed by its complete working-tree walk', (t) => {
  const root = fixture(t, 'project-node-modules-reuse');
  const project = path.join(root, 'repo');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.writeFileSync(path.join(project, 'index.mjs'), 'export default 1;\n');
  fs.writeFileSync(path.join(project, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/pacphi/repo.git\n');
  fs.mkdirSync(path.join(project, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(project, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');

  const walked = [];
  const result = collectProjects({
    projects: [{ path: project, label: 'repo', hosts: ['codex'] }],
    walk(target, options) {
      walked.push(target);
      return walkTree(target, options);
    },
    fsImpl: fs,
    loc: true,
    now: () => 1,
  });

  assert.equal(result.projects[0].nodeModulesBytes.value,
    fs.statSync(path.join(project, 'node_modules', 'pkg', 'index.js')).size);
  assert.equal(walked.filter((target) => target === project).length, 2,
    'working-tree bytes and stack detection are the only full project-root walks');
  assert.equal(walked.length, 4,
    'tree, .git, one node_modules payload, and stack are the complete walk budget');
});

test('project measurement falls back to bounded dependency discovery after a degraded tree walk', (t) => {
  const root = fixture(t, 'project-node-modules-fallback');
  const project = path.join(root, 'repo');
  const packages = path.join(project, 'packages');
  const dependencyFile = path.join(packages, 'app', 'node_modules', 'pkg', 'index.js');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(path.dirname(dependencyFile), { recursive: true });
  fs.writeFileSync(path.join(project, 'index.mjs'), 'export default 1;\n');
  fs.writeFileSync(path.join(project, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/pacphi/repo.git\n');
  fs.writeFileSync(dependencyFile, 'module.exports = 1;\n');
  let packagesReads = 0;
  const fsImpl = {
    ...fs,
    readdirSync(target, options) {
      if (path.resolve(target) === path.resolve(packages) && packagesReads++ === 0) {
        throw Object.assign(new Error('transient fixture denial'), { code: 'EACCES' });
      }
      return fs.readdirSync(target, options);
    },
  };

  const row = collectProjects({
    projects: [{ path: project, label: 'repo', hosts: ['codex'] }],
    fsImpl,
    loc: false,
    now: () => 1,
  }).projects[0];

  assert.equal(row.treeBytes.partial, true, 'the initial degradation remains disclosed');
  assert.deepEqual(row.nodeModulesRoots, [path.join(packages, 'app', 'node_modules')]);
  assert.equal(row.nodeModulesBytes.value, fs.statSync(dependencyFile).size,
    'a degraded observation never authorizes treating unseen dependencies as absent');
});

test('project dependency reuse preserves the hidden-ancestor exclusion', (t) => {
  const root = fixture(t, 'project-node-modules-hidden');
  const project = path.join(root, 'repo');
  const hiddenDependency = path.join(project, '.cache', 'node_modules', 'pkg', 'index.js');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(path.dirname(hiddenDependency), { recursive: true });
  fs.writeFileSync(path.join(project, 'index.mjs'), 'export default 1;\n');
  fs.writeFileSync(path.join(project, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/pacphi/repo.git\n');
  fs.writeFileSync(hiddenDependency, 'module.exports = 1;\n');

  const row = collectProjects({
    projects: [{ path: project, label: 'repo', hosts: ['codex'] }],
    fsImpl: fs,
    loc: false,
    now: () => 1,
  }).projects[0];

  assert.deepEqual(row.nodeModulesRoots, []);
  assert.equal(row.nodeModulesBytes.value, 0);
});
