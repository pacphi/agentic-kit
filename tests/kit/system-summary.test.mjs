// GET /api/system/summary (#237 M4, decision 8). The System page drew from
// GET /api/system, which ships the whole persisted catalog: every presence
// fact repeated in item.presence, item.consumerBindings, item.artifacts and
// again in top-level artifacts/consumerBindings — tens of MB on a real
// machine, re-fetched every 30 s by the Runtime poll. The page reads a sliver
// of it. The slim endpoint serves exactly what the page draws; GET /api/system
// and `ak system --json` stay complete (UPGRADING documents that shape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';

import { startDashboard } from '../../src/lib/dashboard-server.mjs';
import { systemSummaryPayload, SUMMARY_CATALOG_KEYS } from '../../src/lib/dashboard/system-summary.mjs';
import { repositoryTree } from '../../src/lib/dashboard/project-groups.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

// ── A catalog in the persisted CatalogInventory v4 shape ────────────────────

const HOSTS = ['claude', 'codex', 'opencode'];
const meas = (value) => ({ value, status: 'carried-forward', reason: null, asOf: 1785000000000, partial: false });

function presenceRow(item, host, project, provider = null) {
  const itemPath = `/Users/someone/Code/project-${project}/.${host}/skills/${item}/SKILL.md`;
  return {
    host, surface: `${host}-project-skills:${project}`, path: path.dirname(itemPath), itemPath, sourceFile: null,
    scope: provider ? 'plugin' : 'project', project: `/Users/someone/Code/project-${project}`,
    description: 'A reusable skill description of typical frontmatter length. '.repeat(3),
    provider, plugin: null,
    digest: { algorithm: 'sha256', value: 'a'.repeat(64), bytes: 1234 },
    definition: { algorithm: 'sha256', value: 'a'.repeat(64), bytes: 1234 },
    artifactId: `art_${item}_${project}_${host}`,
    consumer: { host, mechanism: `${host}-project-skill-dir`, configuredBy: null, configScope: 'project',
      configProject: `/Users/someone/Code/project-${project}`, enabled: true, resolution: 'not-reported' },
  };
}

/** Ten logical items, each present in `projects` projects × three hosts; one
 *  plugin-provided agent (provider on its presence) and one skill with two
 *  body variants, so every field the matrix draws is exercised. */
function fullCatalog(projects) {
  const items = []; const artifacts = []; const consumerBindings = [];
  const specs = [
    ...Array.from({ length: 8 }, (_, i) => ({ kind: 'skill', name: `skill-${i}`, provider: null })),
    { kind: 'agent', name: 'gamma:reviewer', provider: { ref: 'gamma@market', name: 'gamma', marketplace: 'market',
      version: '1.2.3', cacheGeneration: 7, enabled: true, evidence: { source: 'installed_plugins.json' } } },
    { kind: 'command', name: 'delta-command', provider: null },
  ];
  specs.forEach((spec, i) => {
    const presence = [];
    for (let p = 0; p < projects; p += 1) for (const h of HOSTS) presence.push(presenceRow(spec.name, h, p, spec.provider));
    const bindings = presence.map((pr) => ({ artifactId: pr.artifactId, host: pr.host, scope: pr.scope, project: pr.project,
      mechanism: pr.consumer.mechanism, configuredBy: null, configScope: 'project', configProject: pr.project,
      enabled: true, resolution: 'not-reported' }));
    const itemArtifacts = presence.map((pr, k) => ({ id: pr.artifactId, definition: pr.definition, entrypoint: pr.digest,
      sourceScopes: [pr.scope], consumers: [bindings[k]] }));
    const key = `${spec.kind}::${spec.name}`;
    items.push({
      key, canonicalId: key, kind: spec.kind, name: spec.name, capabilityName: spec.name,
      pluginRef: spec.provider?.ref ?? null, hosts: i === 9 ? ['codex'] : HOSTS,
      sourceScopes: spec.provider ? ['plugin'] : ['project', 'user'],
      presence, consumerBindings: bindings, artifacts: itemArtifacts,
      digestCoverage: { measured: presence.length, unknown: 0, unique: i === 1 ? 2 : 1, exactMatch: i !== 1 },
      variantCount: i === 1 ? 2 : 1,
    });
    artifacts.push(...itemArtifacts.map((a) => ({ ...a, logicalItemKeys: [key] })));
    consumerBindings.push(...bindings.map((b) => ({ ...b, logicalItemKey: key })));
  });
  return {
    schemaVersion: 4, asOf: 1785000000000, hosts: HOSTS, kinds: ['skill', 'agent', 'command'],
    scopes: ['user', 'project', 'plugin'], items, artifacts, consumerBindings,
    counts: { skill: meas(8), agent: meas(1), command: meas(1) },
    perHost: Object.fromEntries(HOSTS.map((h) => [h, { skill: meas(8), agent: meas(h === 'codex' ? 0 : 1), command: meas(1) }])),
    surfaces: HOSTS.map((h) => ({ id: `${h}-user-skills`, host: h, kind: 'skill', scope: 'user', project: null,
      provider: null, path: `/Users/someone/.${h}/skills`, status: 'measured', reason: null, partial: false, truncated: false, count: 8 })),
    pluginSources: [{ ref: 'gamma@market', path: '/Users/someone/.claude/plugins/cache/gamma' }],
    projectMetadata: [{ path: '/Users/someone/Code/project-0', projectKind: 'git' }],
    sourceStamps: [{ path: '/Users/someone/.claude/skills', mtimeMs: 1, size: 2 }],
    overlaps: { names: [], digests: [] },
    projects: [{
      project: '/repo/example', label: 'example', complete: true, launching: true,
      guidance: [{ host: 'codex', message: '1 project-scoped skill observed', nextCommand: 'ak x skills plan --project "/repo/example"' }],
      byHost: Object.fromEntries(HOSTS.map((h) => [h, {
        sources: { project: { skill: meas(h === 'codex' ? 1 : 0) }, user: { skill: meas(8) }, plugin: { skill: meas(0) } },
        overlaps: { skillNames: meas(h === 'codex' ? 1 : 0), skillDigests: meas(0) },
      }])),
    }],
    config: { asOf: 1785000000000, surfaces: [] },
    complete: true, degraded: [], truncated: [], partial: [],
  };
}

function fullPayload(projects = 5) {
  return {
    generatedAt: '2026-09-26T00:00:00.000Z', platform: 'darwin',
    runtime: { totals: { processCount: meas(1), rssBytes: meas(1024), cpuPercent: meas(0.5) }, processes: meas([]) },
    knownFiles: { asOf: 1785000000000, nodes: [{ path: '/Users/someone/.claude.json', bytes: meas(10) }] },
    install: null, storage: null, projects: null, consumers: null,
    catalog: fullCatalog(projects),
    snapshot: { present: true, file: '/Users/someone/.config/agentic-kit/footprint-snapshot.json', reason: null,
      completeness: null, asOf: 1785000000000, ageMs: 1000, stale: false, catalogDrift: { status: 'unchanged' } },
    cheapTier: { asOf: 1785000000000, ttlMs: 60000 }, scan: { running: false, phase: 'idle' },
  };
}
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

// ── The projection ──────────────────────────────────────────────────────────

test('the summary drops the repeated catalog copies and every per-presence detail', () => {
  const summary = systemSummaryPayload(fullPayload());
  for (const dropped of ['artifacts', 'consumerBindings', 'surfaces', 'pluginSources', 'projectMetadata',
    'sourceStamps', 'overlaps', 'config']) {
    assert.equal(dropped in summary.catalog, false, `catalog.${dropped} must not ship to the page`);
  }
  for (const item of summary.catalog.items) {
    assert.deepEqual(Object.keys(item).sort(),
      ['digestCoverage', 'hosts', 'key', 'kind', 'name', 'presence', 'sourceScopes'].sort());
    for (const p of item.presence) assert.deepEqual(Object.keys(p), ['provider']);
  }
  assert.equal(JSON.stringify(summary.catalog).includes('/Users/someone/Code/project-'), false,
    'no presence path survives the projection');
});

test('the summary keeps every catalog field the page reads, including presence[].provider', () => {
  const full = fullPayload();
  const summary = systemSummaryPayload(full);
  for (const key of ['schemaVersion', 'asOf', 'hosts', 'kinds', 'scopes', 'counts', 'perHost', 'projects',
    'complete', 'degraded', 'truncated', 'partial']) {
    assert.ok(SUMMARY_CATALOG_KEYS.includes(key), `${key} is on the allow-list`);
    assert.deepEqual(summary.catalog[key], full.catalog[key], `catalog.${key} passes through unchanged`);
  }
  const agent = summary.catalog.items.find((i) => i.kind === 'agent');
  assert.deepEqual(agent.presence, [{ provider: { ref: 'gamma@market', version: '1.2.3' } }],
    'one entry per distinct provider, reduced to what paintCatalogMatrix prints');
  assert.deepEqual(summary.catalog.items.find((i) => i.name === 'skill-0').presence, []);
  assert.equal(summary.catalog.items[1].digestCoverage.unique, 2);
});

test('the summary leaves runtime/knownFiles/snapshot/cheapTier/scan untouched and does not mutate its input', () => {
  const full = fullPayload();
  const before = structuredClone(full);
  const summary = systemSummaryPayload(full);
  assert.deepEqual(full, before, 'the collector payload is not mutated');
  for (const key of ['generatedAt', 'platform', 'runtime', 'knownFiles', 'snapshot', 'cheapTier', 'scan']) {
    assert.deepEqual(summary[key], full[key], `${key} passes through unchanged`);
  }
  assert.deepEqual(systemSummaryPayload({ ...full, catalog: null }).catalog, null, 'never-scanned catalog stays null');
  for (const key of ['storage', 'install', 'projects', 'consumers']) {
    assert.equal(systemSummaryPayload({ ...full, [key]: null })[key], null, `never-scanned ${key} stays null`);
  }
});

// ── storage, install, projects, consumers ───────────────────────────────────
// Each fixture below carries the real collector's excess fields (kind, path,
// attribution, presence, files, newestMtimeMs on a storage node; a full stack
// detection on a project row; a nativeAddons array on a tool; matchedPaths on
// a consumer row) alongside the handful of fields the page actually reads, so
// the "keeps"/"drops" tests below exercise the same allow-list discipline the
// catalog tests already do.

function storageFixture() {
  const hostNode = (host, value) => ({
    key: host, kind: 'host', label: host, path: `/Users/someone/.${host}`, host, attribution: null,
    presence: 'present', bytes: meas(value), files: meas(5), newestMtimeMs: 1785000000000,
    children: [{
      key: `${host}-project`, kind: 'project', label: `${host} project`,
      path: `/Users/someone/.${host}/projects/p1`, host, attribution: 'catalog', presence: 'present',
      bytes: meas(value), files: meas(5), newestMtimeMs: 1785000000000, children: [],
    }],
  });
  return {
    asOf: 1785000000000,
    categories: [
      { key: 'transcripts', kind: 'category', label: 'transcripts', path: null, host: null, attribution: null,
        presence: 'present', bytes: meas(300000), files: meas(50), newestMtimeMs: 1785000000000,
        children: HOSTS.map((h) => hostNode(h, 100000)) },
      { key: 'kit-caches', kind: 'category', label: 'kit-caches', path: null, host: null, attribution: null,
        presence: 'present', bytes: meas(50000), files: meas(10), newestMtimeMs: 1785000000000,
        children: [hostNode('agentic-kit', 50000)] },
    ],
    totals: { bytes: meas(350000), files: meas(60) },
    growth: {
      windowDays: 30, approximate: true,
      basis: 'file mtime + size; a rewritten file counts its whole size on its mtime day',
      hosts: HOSTS.map((h) => ({
        host: h, totalBytes: meas(1000), perDayAvgBytes: meas(33),
        days: Array.from({ length: 30 }, (_, i) => (
          { day: `2026-08-${String(i + 1).padStart(2, '0')}`, bytes: 10 + i, files: 1 }
        )),
      })),
    },
    topSessions: [{
      session: 'abc123.jsonl', host: 'claude', category: 'transcripts', project: 'proj-0', attribution: 'catalog',
      path: '/Users/someone/.claude/projects/proj-0/abc123.jsonl', bytes: 99999, mtimeMs: 1785000000000,
      identity: { original: 'abc123.jsonl', nativeId: 'abc123', startedAt: '2026-08-01T00:00:00.000Z',
        lastModifiedAt: '2026-08-02T00:00:00.000Z', timeBasis: 'started', provenance: {} },
      context: { kind: 'repository', label: 'proj-0', path: '/repo/proj-0' },
      projectPath: '/repo/proj-0', projectResolved: true, projectLabel: 'proj-0',
    }],
    topFiles: [{ path: '/Users/someone/.claude/big.jsonl', name: 'big.jsonl', host: 'claude',
      category: 'transcripts', bytes: 99999, mtimeMs: 1785000000000 }],
    reclaimables: [{
      id: 'npx-stale-1', kind: 'npx-env', label: 'stale npx env', path: '/Users/someone/.npm/_npx/abc',
      samplePaths: ['/Users/someone/.npm/_npx/abc/x'], matchedCount: 3, bytes: meas(4096), files: meas(12),
      safety: 'regenerable', bytesMeaning: 'candidate', keeps: [], rationale: 'idle for 90+ days',
      cleanupHint: 'npx cache clean', advisory: true,
    }],
    reclaimSummary: {
      tiers: [
        { safety: 'regenerable', meaning: 'refetched', rowCount: 1, bytes: meas(4096), summedRows: 1, contextOnlyRows: 0 },
        { safety: 'review', meaning: 'review', rowCount: 0, bytes: meas(0), summedRows: 0, contextOnlyRows: 0 },
      ],
      combined: null, combinedNote: 'never summed',
    },
    complete: true,
  };
}

function installFixture() {
  const tool = (id, present) => ({
    tool: id, label: id, package: `@agentic-kit/${id}`, present, version: present ? '1.2.3' : null,
    root: present ? `/opt/${id}` : null, executablePath: present ? `/usr/local/bin/${id}` : null,
    linkedFrom: null, rootReason: null, components: [{ name: 'core', bytes: meas(100) }],
    nativeAddons: present ? [{ name: 'native.node', bytes: meas(2048), path: `/opt/${id}/native.node` }] : [],
    nativeAddonCount: present ? 1 : 0, nativeAddonsTruncated: false, newestMtimeMs: 1785000000000, degraded: [],
    managed: true, updateOwner: 'agentic-kit', consumer: null, upstreamOwner: null,
    installMethod: present ? 'npm-global' : 'absent', bytes: meas(present ? 50000 : 0),
    files: meas(present ? 40 : 0), complete: true,
  });
  return {
    asOf: 1785000000000, globalRoot: '/opt/global', globalRootReason: null,
    tools: [tool('agent-browser', true), tool('vibium', true), tool('ruflo', true)],
    sharedCaches: [{
      id: 'npm-cache', label: 'npm content cache', path: '/Users/someone/.npm/_cacache', runtime: null,
      bytes: meas(200000), files: meas(500), presence: 'present', complete: true,
      payload: { status: 'ready', revision: null, reason: null },
    }],
    npxEnvs: { root: '/Users/someone/.npm/_npx', presence: 'present', reason: null, envs: [] },
    duplicateNatives: [],
    totals: { installBytes: meas(150000), cacheBytes: meas(200000), nativeAddons: meas(2), toolsPresent: meas(3) },
    disk: { path: '/Users/someone', totalBytes: meas(1e12), freeBytes: meas(5e11) },
    complete: true,
  };
}

function projectsFixture() {
  const stack = {
    registryVersion: 3, status: 'measured', reason: null,
    languagePresence: [{ id: 'ts', name: 'TypeScript' }],
    items: [{ id: 'react', kind: 'framework', name: 'React' }],
    manifests: [{ manifest: 'package.json', dependencies: 40 }],
    nonSource: { files: meas(10), bytes: meas(1000) },
    unrecognized: { extensions: [{ ext: '.foo', files: 3, bytes: 100 }], extensionsTotal: 1,
      dependencies: [{ manifest: 'package.json', name: 'left-pad' }], dependenciesTotal: 1 },
    complete: true, degraded: [],
  };
  const row = (i) => ({
    path: `/repo/proj-${i}`, projectKind: 'git', label: `proj-${i}`, source: 'transcript-cwd',
    repository: { repositoryId: `repo-${i}`, kind: 'git', root: `/repo/proj-${i}` },
    sessionOrigins: null, hosts: ['claude', 'codex'],
    remote: { status: 'linked', name: 'origin', raw: `git@github.com:me/proj-${i}.git`, hostname: 'github.com',
      host: 'github', slug: `me/proj-${i}`, webUrl: `https://github.com/me/proj-${i}`, reason: null },
    loc: {
      approximate: true, exclusions: ['.git', 'node_modules'], registryVersion: 3,
      total: meas(12345), byLanguage: { ts: 10000, js: 2345 },
      languages: [{ id: 'ts', name: 'TypeScript', lines: 10000 }, { id: 'js', name: 'JavaScript', lines: 2345 }],
      files: meas(400), skipped: 0, complete: true, degraded: [],
    },
    stack,
    presence: 'present', treeBytes: meas(500000), treeFiles: meas(400), gitBytes: meas(20000),
    nodeModulesBytes: meas(300000), nodeModulesRoots: [`/repo/proj-${i}/node_modules`],
    totalBytes: meas(820000), totalFiles: meas(500),
    footprintMtime: meas(1785000000000), lastActivity: meas(1785000000000),
    treeExclusions: ['.git', 'node_modules'], complete: true,
  });
  const discovery = (i) => ({
    path: `/repo/proj-${i}`, label: `proj-${i}`, hosts: ['claude', 'codex'], origins: ['cwd'], exists: true,
    isGitRepo: true, lastSeenMs: 1785000000000, sessions: 4,
    sessionOrigins: [{ origin: 'unknown', sessions: 4, evidence: [], countBasis: 'transcript-files' }],
    repository: { repositoryId: `repo-${i}`, kind: 'git', root: `/repo/proj-${i}` },
  });
  return {
    asOf: 1785000000000, projects: [row(0), row(1)],
    discoveryProjects: [discovery(0), discovery(1), discovery(2)],
    count: meas(3), everSeen: meas(3), onDisk: meas(2), gitRepos: meas(2), unresolved: 0, importedExcluded: 0,
    method: 'cross-host-census', sources: { claude: {}, codex: {}, opencode: {} }, scanned: 2, truncated: false,
    population: { kind: 'hosted-repositories-with-recorded-session', eligible: 2, measured: 2, excluded: { total: 1 } },
    locMeasured: true, registryVersion: 3,
    unrecognized: { projectsMeasured: 2, extensions: [], extensionsTotal: 0, dependencies: [], dependenciesTotal: 0 },
    complete: true,
  };
}

function consumersFixture() {
  const row = (id, group, containedBy = null) => ({
    id, label: id, path: `/Users/someone/.cache/${id}`, pathPattern: null,
    matchedPaths: [`/Users/someone/.cache/${id}`], matchedCount: 1, group,
    kind: containedBy ? 'breakdown' : 'root', containedBy, presence: 'present',
    bytes: meas(10000), files: meas(20), basis: 'apparent-size', apparentBytes: 12000,
    newestMtimeMs: 1785000000000, accountingNote: null, source: 'registry', measuredBy: 'consumers',
    residual: false, complete: true,
  });
  const rows = [row('brain-cache', 'ai-toolchain'), row('brain-models', 'ai-toolchain', 'brain-cache')];
  return {
    asOf: 1785000000000, includeProjectTrees: false, topN: 20, rows, top: [rows[0]],
    groups: [{ id: 'ai-toolchain', label: 'AI toolchain', note: 'Local model weights, agent CLIs, their transcripts, caches and knowledge bases.',
      rowCount: 1, bytes: meas(10000), files: meas(20), largest: 'brain-cache' }],
    totals: { bytes: meas(10000), files: meas(20), rootCount: meas(1), breakdownCount: meas(1), rankedCount: meas(1) },
    absent: [], unmeasured: [],
    projectTrees: { included: false, candidates: 0,
      reason: 'Project working trees are excluded by default: a single large repository can outweigh every shared cache combined and flatten the ranking.' },
    accounting: {
      basis: 'One bounded walk per root (symlinks never followed, so a symlinked tree is counted where it really lives), or the figure the Install/Projects scan already measured for that exact path.',
      containment: 'Nested roots are counted once, at the outermost row. Rows inside another row are breakdowns and are excluded from the ranking and the group totals.',
      residuals: 'Every row with breakdowns also carries an "everything else" row, so a breakdown always sums to its parent.',
      absent: 'Roots that do not exist on this machine are listed as absent, not ranked as zero-byte consumers.',
      projectTrees: 'Project working trees join the ranking only when the toggle is on.',
    },
    complete: true,
  };
}

test('the storage summary drops the deep-tree noise and every advisory/session field the page never reads', () => {
  const summary = systemSummaryPayload({ ...fullPayload(), storage: storageFixture() });
  assert.equal('topFiles' in summary.storage, false, 'topFiles never renders');
  assert.equal('complete' in summary.storage, false);
  assert.deepEqual(Object.keys(summary.storage.totals), ['bytes']);
  const walk = (node) => {
    assert.deepEqual(Object.keys(node).sort(), ['bytes', 'children', 'key', 'label'].sort());
    node.children.forEach(walk);
  };
  summary.storage.categories.forEach(walk);
  assert.deepEqual(Object.keys(summary.storage.growth).sort(), ['basis', 'hosts', 'windowDays'].sort());
  assert.deepEqual(Object.keys(summary.storage.growth.hosts[0]).sort(),
    ['days', 'host', 'perDayAvgBytes', 'totalBytes'].sort());
  assert.deepEqual(Object.keys(summary.storage.growth.hosts[0].days[0]), ['day', 'bytes']);
  const session = summary.storage.topSessions[0];
  for (const dropped of ['category', 'path', 'attribution']) assert.equal(dropped in session, false);
  const reclaim = summary.storage.reclaimables[0];
  assert.deepEqual(Object.keys(reclaim).sort(),
    ['label', 'path', 'safety', 'bytesMeaning', 'rationale', 'cleanupHint', 'bytes'].sort());
  assert.deepEqual(Object.keys(summary.storage.reclaimSummary), ['tiers']);
  assert.deepEqual(Object.keys(summary.storage.reclaimSummary.tiers[0]).sort(), ['safety', 'bytes', 'rowCount'].sort());
});

test('the install summary drops native-addon lists and package/build metadata', () => {
  const summary = systemSummaryPayload({ ...fullPayload(), install: installFixture() });
  for (const key of ['globalRoot', 'globalRootReason', 'npxEnvs', 'duplicateNatives', 'complete']) {
    assert.equal(key in summary.install, false, `install.${key} never renders`);
  }
  assert.deepEqual(Object.keys(summary.install.tools[0]).sort(),
    ['tool', 'label', 'installMethod', 'updateOwner', 'present', 'version', 'root', 'bytes'].sort());
  assert.equal('nativeAddons' in summary.install.tools[0], false);
  assert.deepEqual(Object.keys(summary.install.sharedCaches[0]).sort(),
    ['runtime', 'label', 'path', 'bytes', 'payload'].sort());
  assert.deepEqual(Object.keys(summary.install.totals).sort(), ['installBytes', 'toolsPresent', 'nativeAddons'].sort());
  assert.deepEqual(summary.install.disk, installFixture().disk, 'disk is already small; passed through as-is');
});

test('the projects summary drops per-project stack detection and node_modules roots', () => {
  const summary = systemSummaryPayload({ ...fullPayload(), projects: projectsFixture() });
  for (const key of ['sources', 'locMeasured', 'registryVersion', 'unrecognized', 'population', 'scanned', 'complete']) {
    assert.equal(key in summary.projects, false, `projects.${key} never renders`);
  }
  const row = summary.projects.projects[0];
  assert.deepEqual(Object.keys(row).sort(),
    ['path', 'label', 'hosts', 'totalBytes', 'lastActivity', 'loc', 'remote', 'repository'].sort());
  assert.equal('stack' in row, false, 'framework/manifest detection is not rendered (system-projects.mjs langCell)');
  assert.equal('nodeModulesRoots' in row, false);
  assert.deepEqual(Object.keys(row.loc).sort(), ['total', 'languages', 'byLanguage'].sort());
  assert.deepEqual(row.loc.byLanguage, { ts: 10000, js: 2345 }, 'kept: a pre-languages carried-forward snapshot needs it');
  assert.deepEqual(Object.keys(row.repository).sort(), ['repositoryId', 'kind', 'root'].sort());
  assert.deepEqual(Object.keys(row.remote).sort(), ['status', 'webUrl', 'raw'].sort());
  const discovery = summary.projects.discoveryProjects[0];
  assert.deepEqual(Object.keys(discovery).sort(), ['path', 'label', 'hosts', 'repository'].sort());
});

test('the projects summary keeps byLanguage for a pre-languages loc, so an old carried-forward snapshot still renders bars', () => {
  const projects = projectsFixture();
  projects.projects[0].loc = { total: meas(500), byLanguage: { py: 500 }, languages: null };
  const summary = systemSummaryPayload({ ...fullPayload(), projects });
  assert.deepEqual(summary.projects.projects[0].loc, { total: meas(500), languages: null, byLanguage: { py: 500 } });
});

test('the consumers summary drops matchedPaths and the redundant absent list', () => {
  const summary = systemSummaryPayload({ ...fullPayload(), consumers: consumersFixture() });
  assert.equal('absent' in summary.consumers, false, 'absent never renders (consumerLiner reads unmeasured only)');
  assert.deepEqual(Object.keys(summary.consumers.rows[0]).sort(),
    ['id', 'label', 'path', 'pathPattern', 'group', 'containedBy', 'bytes', 'apparentBytes', 'accountingNote'].sort());
  assert.equal('matchedPaths' in summary.consumers.rows[0], false);
  assert.deepEqual(Object.keys(summary.consumers.groups[0]).sort(), ['id', 'label', 'note', 'bytes', 'rowCount'].sort());
  assert.deepEqual(Object.keys(summary.consumers.totals), ['rankedCount']);
  assert.deepEqual(Object.keys(summary.consumers.accounting).sort(), ['basis', 'containment', 'residuals', 'absent'].sort());
  assert.deepEqual(Object.keys(summary.consumers.projectTrees).sort(), ['included', 'reason'].sort());
});

test('the summary size does not grow with the number of presence rows', () => {
  const small = systemSummaryPayload(fullPayload(5));
  const large = systemSummaryPayload(fullPayload(40));
  // Eight times the presence rows; only digestCoverage's counters get wider.
  assert.ok(bytes(large.catalog) - bytes(small.catalog) <= large.catalog.items.length * 4,
    `presence rows are per project × host and the page needs none of them (${bytes(small.catalog)} → ${bytes(large.catalog)} B)`);
  const full = fullPayload(40);
  assert.ok(bytes(large) * 20 < bytes(full),
    `summary ${bytes(large)} B must be under 5% of the full ${bytes(full)} B payload`);
});

test('a realistic multi-section payload (catalog + storage + install + projects + consumers) stays under the byte budget', () => {
  const bigStorage = () => {
    const storage = storageFixture();
    const codexHost = storage.categories[0].children.find((c) => c.key === 'codex');
    codexHost.children = Array.from({ length: 150 }, (_, i) => ({
      key: `session-${i}`, kind: 'session', label: `session-${i}`,
      path: `/Users/someone/.codex/sessions/rollout-${i}.jsonl`, host: 'codex', attribution: 'none',
      presence: 'present', bytes: meas(4096 + i), files: meas(1), newestMtimeMs: 1785000000000, children: [],
    }));
    storage.topSessions = Array.from({ length: 10 }, (_, i) => ({ ...storageFixture().topSessions[0], session: `s${i}.jsonl` }));
    storage.reclaimables = Array.from({ length: 20 }, (_, i) => (
      { ...storageFixture().reclaimables[0], id: `r${i}`, label: `reclaimable ${i}` }
    ));
    return storage;
  };
  const bigInstall = () => {
    const install = installFixture();
    install.tools = Array.from({ length: 15 }, (_, n) => ({
      ...install.tools[0], tool: `tool-${n}`, label: `tool-${n}`,
      nativeAddons: Array.from({ length: 5 }, (_, a) => (
        { name: `addon-${a}.node`, bytes: meas(2048), path: `/opt/tool-${n}/addon-${a}.node` }
      )),
    }));
    return install;
  };
  const bigProjects = () => {
    const projects = projectsFixture();
    const row = projects.projects[0];
    projects.projects = Array.from({ length: 60 }, (_, n) => ({ ...row, path: `/repo/proj-${n}`, label: `proj-${n}` }));
    const discovery = projects.discoveryProjects[0];
    projects.discoveryProjects = Array.from({ length: 200 }, (_, n) => (
      { ...discovery, path: `/repo/disc-${n}`, label: `disc-${n}` }
    ));
    return projects;
  };
  const bigConsumers = () => {
    const consumers = consumersFixture();
    const row = consumers.rows[0];
    consumers.rows = Array.from({ length: 100 }, (_, n) => ({ ...row, id: `consumer-${n}`, label: `consumer-${n}` }));
    consumers.top = consumers.rows.slice(0, 20);
    return consumers;
  };
  const full = {
    ...fullPayload(40),
    storage: bigStorage(), install: bigInstall(), projects: bigProjects(), consumers: bigConsumers(),
  };
  const summary = systemSummaryPayload(full);
  const fullBytes = bytes(full);
  const summaryBytes = bytes(summary);
  assert.ok(fullBytes > 300_000, `fixture should be realistically large (${fullBytes} B)`);
  // Comfortably under the ~2.26 MB progress.md recorded on the real machine
  // before this projection, with headroom above what this fixture's own fix
  // achieves so small, legitimate future growth does not immediately trip the
  // gate.
  assert.ok(summaryBytes < 500_000,
    `summary must stay under the 500 KB budget (${summaryBytes} B of ${fullBytes} B full)`);
});

// ── Render parity: the page draws the same thing from either payload ───────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fakeDocument() {
  const elements = new Map();
  const element = () => {
    const attrs = new Map();
    return {
      innerHTML: '', textContent: '', title: '', hidden: false, disabled: false, style: {},
      setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => attrs.get(k) ?? null,
      removeAttribute: (k) => attrs.delete(k), hasAttribute: (k) => attrs.has(k),
      classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [], appendChild() {},
    };
  };
  return {
    elements,
    getElementById: (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelectorAll: () => [], dispatchEvent() {}, addEventListener() {}, createElement: element,
  };
}

function usageHelpers() {
  const source = fs.readFileSync(new URL('../../src/lib/dashboard/client/usage.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/\bexport /g, '');
  const context = vm.createContext({ window: {}, document: { getElementById: () => null }, esc, formatLocalDateTime: () => null });
  vm.runInContext(source, context);
  return { fmtNum: context.fmtNum, fmtTok: context.fmtTok, limAge: context.limAge, pct: context.pct };
}

function load(name, deps, exports) {
  const source = fs.readFileSync(new URL(`../../src/lib/dashboard/client/${name}.mjs`, import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?from ['"][^'"]+['"];\s*$/gm, '').replace(/\bexport (?=(?:function|var)\b)/g, '');
  return new Function(...Object.keys(deps), `${source}\nreturn {${exports.join(',')}};`)(...Object.values(deps));
}

function systemClient({ fetchImpl } = {}) {
  const document = fakeDocument();
  const window = { requestAnimationFrame: null, innerWidth: 1200, innerHeight: 800 };
  const { fmtNum, fmtTok, limAge, pct } = usageHelpers();
  const readoutExports = ['mval', 'unkHtml', 'mhtml', 'fmtBytes', 'bytesPair', 'fmtDur', 'SERIES', 'dayTick', 'KIND_LABEL',
    'KIND_PLURAL', 'hostColor', 'catColor', 'sysEmpty', 'NOT_SCANNED', 'svgDonut', 'svgArea', 'svgRadar',
    'storageHostTotals', 'renderSysSummary', 'renderSysConsumers', 'renderSysReclaim', 'CHART_EXCLUDED_CATEGORIES',
    'transcriptIdOf', 'renderSysKpis'];
  const readout = load('system-readout', { esc, fmtNum, fmtTok, document, window }, readoutExports);
  const projects = load('system-projects', {
    ...readout, esc, authHeaders: () => ({}), formatLocalDateTime: () => null, formatLocalDateTimeLong: () => null,
    shortSessionId: (s) => s, ago: () => 'just now', fmtNum, fmtTok, limAge, pct,
    repositoryTree,
    SYSTEM: null, systemBusy: false, systemPollTimer: null, consMode: 'ranked', document, window,
    fetch: fetchImpl ?? (() => Promise.reject(new Error('no fetch in this test'))), setTimeout: () => 0, clearTimeout: () => {},
  }, ['renderSysCatalog', 'loadSystem', 'renderSysStorage', 'renderSysProjects', 'renderSysRuntime']);
  return { document, readout, projects };
}

function catalogHtml(payload) {
  const client = systemClient();
  client.readout.renderSysKpis(payload);
  client.projects.renderSysCatalog(payload);
  return Object.fromEntries([...client.document.elements].map(([id, el]) => [id, { html: el.innerHTML, text: el.textContent }]));
}

test('Runtime process renderer names desktop applications separately from coding-agent hosts', () => {
  const client = systemClient();
  const row = (pid, host, application, source) => ({ pid, host, application, source,
    uptimeMs: meas(2000), cpuPercent: meas(2), rssBytes: meas(1000) });
  client.projects.renderSysRuntime({ runtime: { processes: meas([
    row(1, null, 'Claude Desktop', meas({ kind: 'desktop-app', label: 'Claude Desktop' })),
    row(2, 'claude', null, meas({ kind: 'repository', label: 'work' })),
    row(3, null, 'ChatGPT desktop app', meas({ kind: 'desktop-app', label: 'ChatGPT desktop app' })),
    row(4, 'codex', null, meas({ kind: 'host-service', label: 'Codex app service' })),
    row(5, null, '<unknown>', { status: 'unknown', reason: 'not attributable — <denied>' }),
  ]) } });
  const html = client.document.getElementById('sys-procs').innerHTML;
  assert.match(html, /Coding-agent host \/ desktop application/);
  assert.match(html, /Claude Desktop/);
  assert.match(html, /ChatGPT desktop app/);
  assert.match(html, /Codex app service/);
  assert.match(html, /work/);
  assert.match(html, /not attributable/);
  assert.match(html, /&lt;unknown&gt;/);
  assert.match(html, /&lt;denied&gt;/);
  assert.doesNotMatch(html, /<unknown>|<denied>/);
});

test('the KPI band and every catalog card render identically from the summary and the full payload', () => {
  const full = fullPayload(6);
  const fromFull = catalogHtml(full);
  const fromSummary = catalogHtml(systemSummaryPayload(full));
  assert.ok(Object.keys(fromFull).includes('sys-matrix') && fromFull['sys-matrix'].html.includes('gamma@market v1.2.3'),
    'the fixture exercises the provider meta the matrix prints');
  assert.ok(fromFull['sys-matrix'].html.includes('2 body variants'), 'and the digest-variant meta');
  assert.ok(fromFull['sys-pressure'].html.includes('example'), 'and the project pressure card');
  assert.deepEqual(fromSummary, fromFull);
});

test('storage, install and project views render identically from the summary and the full payload', () => {
  const full = {
    ...fullPayload(3),
    storage: storageFixture(), install: installFixture(), projects: projectsFixture(), consumers: consumersFixture(),
  };
  const render = (payload) => {
    const client = systemClient();
    client.readout.renderSysSummary(payload);
    client.projects.renderSysStorage(payload);
    client.projects.renderSysProjects(payload);
    return Object.fromEntries([...client.document.elements].map(([id, el]) => [id, el.innerHTML]));
  };
  const fromFull = render(full);
  const fromSummary = render(systemSummaryPayload(full));
  assert.ok(fromFull['sys-donut'] && fromFull['sys-donut'].length, 'the fixture exercises the storage donut');
  assert.ok(fromFull['sys-projects'] && fromFull['sys-projects'].includes('proj-0'), 'and the projects table');
  assert.ok(fromFull['sys-consumers'] && fromFull['sys-consumers'].length, 'and the largest-consumers strip');
  assert.deepEqual(fromSummary, fromFull);

  // No `consumers` section: renderSysConsumers falls back to topConsumers(d, 20),
  // which reads storage/install rows through a DIFFERENT path (kids[j].host,
  // tools[i].bytes, caches[i].label) than the assertions above exercise.
  const noConsumers = { ...full, consumers: null };
  const fromFullNoConsumers = render(noConsumers);
  const fromSummaryNoConsumers = render(systemSummaryPayload(noConsumers));
  assert.ok(fromFullNoConsumers['sys-consumers'] && fromFullNoConsumers['sys-consumers'].length,
    'the fallback ranking still renders something from storage/install alone');
  assert.deepEqual(fromSummaryNoConsumers, fromFullNoConsumers);
});

test('the projects note says how many imported copies discovery set aside, and nothing when there are none', () => {
  const noteFor = (extra) => {
    const client = systemClient();
    const projects = { everSeen: { value: 114 }, onDisk: { value: 90 }, gitRepos: { value: 60 }, unresolved: 0,
      method: 'm', projects: [], ...extra };
    client.readout.renderSysKpis({ ...fullPayload(1), projects });
    return client.document.getElementById('sys-kpis-note').innerHTML;
  };
  const note = noteFor({ importedExcluded: 924 });
  assert.match(note, /924 Codex copies of Claude Code sessions, imported by the ChatGPT desktop app, are not counted/);
  assert.match(note, /are not counted; they are copies, and the original Claude Code session is counted where its transcript still exists\./);
  const one = noteFor({ importedExcluded: 1 });
  assert.match(one, /1 Codex copy of a Claude Code session, imported by the ChatGPT desktop app, is not counted; it is a copy, and the original Claude Code session is counted where its transcript still exists\./);
  for (const text of [note, one]) {
    assert.doesNotMatch(text, /already names its folder/, 'an import-only folder has no Claude transcript naming it');
  }
  for (const extra of [{}, { importedExcluded: 0 }]) {
    const plain = noteFor(extra);
    assert.doesNotMatch(plain, /imported|undefined/, 'an old snapshot or a zero renders exactly as before');
  }
});

// ── The page reads the slim endpoint ────────────────────────────────────────

test('loadSystem only re-reads /api/system/summary', async () => {
  const urls = [];
  const fetchImpl = (url) => { urls.push(url); return Promise.resolve({ json: () => Promise.resolve(systemSummaryPayload(fullPayload(1))) }); };
  const { projects } = systemClient({ fetchImpl });
  await projects.loadSystem();
  await projects.loadSystem(true, false);
  assert.deepEqual(urls, ['/api/system/summary', '/api/system/summary']);
});

// ── The routes ──────────────────────────────────────────────────────────────

function request(server, route, token = server.token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { 'x-dash-token': token } : {};
    const req = http.request({ host: '127.0.0.1', port: server.port, path: route, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function fakeCollector() {
  const calls = { read: 0, refreshDeep: [] };
  return {
    calls,
    async read() { calls.read += 1; return fullPayload(3); },
    async refreshDeep(opts) { calls.refreshDeep.push(opts); return { ok: true, persisted: { ok: true } }; },
    scanState() { return { running: true, phase: 'catalog' }; },
  };
}

// A successful deep refresh makes the server re-scan maintenance and rebuild
// the ADR-0048 inventory over the injected collector. Left to the defaults,
// both write into the real state directory (~/.local/state/agentic-kit/
// maintenance) and the facade walks the real home folder, so these fakes keep
// the server hermetic. Same pattern as maintenance-dashboard-api.test.mjs.
function hermeticMaintenance() {
  return {
    maintenance: { report() { return null; }, async scan() { return {}; }, plan() { return null; } },
    management: { async rebuildAfterMeasurement() { return null; }, async refreshInventory() { return null; } },
  };
}

test('GET /api/system/summary serves the projection; GET /api/system stays complete', async (t) => {
  const collector = fakeCollector();
  const cwd = tempDir('ak-system-summary');
  const server = await startDashboard({ port: 0, cwd, system: collector, usage: {}, ...hermeticMaintenance() });
  t.after(() => server.close());

  const refused = await request(server, '/api/system/summary', null);
  assert.equal(refused.status, 401);
  assert.equal(collector.calls.read, 0, 'an unauthenticated request never reaches the collector');

  const slim = await request(server, '/api/system/summary');
  assert.equal(slim.status, 200);
  assert.equal(slim.headers['cache-control'], 'no-store');
  const summary = JSON.parse(slim.body);
  assert.deepEqual(summary, JSON.parse(JSON.stringify(systemSummaryPayload(fullPayload(3)))));

  const complete = JSON.parse((await request(server, '/api/system')).body);
  assert.ok(Array.isArray(complete.catalog.artifacts) && complete.catalog.artifacts.length > 0,
    '/api/system keeps the documented `ak system --json` shape');
  assert.ok(complete.catalog.items[0].presence[0].itemPath);
});

test('GET /api/system/summary rejects measurement queries before reading the collector', async (t) => {
  const collector = fakeCollector();
  const cwd = tempDir('ak-system-summary');
  const server = await startDashboard({ port: 0, cwd, system: collector, usage: {}, ...hermeticMaintenance() });
  t.after(() => server.close());
  const r = await request(server, '/api/system/summary?refresh=deep&trees=0');
  assert.equal(r.status, 400);
  const body = JSON.parse(r.body);
  assert.deepEqual(body, { error: 'start a refresh with POST /api/refresh' });
  assert.deepEqual(collector.calls.refreshDeep, []);
});
