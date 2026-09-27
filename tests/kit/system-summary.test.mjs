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
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { startDashboard } from '../../src/lib/dashboard-server.mjs';
import { systemSummaryPayload, SUMMARY_CATALOG_KEYS } from '../../src/lib/dashboard/system-summary.mjs';

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

test('the summary leaves every other section untouched and does not mutate its input', () => {
  const full = fullPayload();
  const before = structuredClone(full);
  const summary = systemSummaryPayload(full);
  assert.deepEqual(full, before, 'the collector payload is not mutated');
  const { catalog: _full, ...restFull } = full;
  const { catalog: _summary, ...restSummary } = summary;
  assert.deepEqual(restSummary, restFull);
  assert.deepEqual(systemSummaryPayload({ ...full, catalog: null }).catalog, null, 'never-scanned stays null');
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
    repositoryTree: () => ({ repositories: [], excludedDirectories: 0 }),
    SYSTEM: null, systemBusy: false, systemPollTimer: null, consMode: 'ranked', document, window,
    fetch: fetchImpl ?? (() => Promise.reject(new Error('no fetch in this test'))), setTimeout: () => 0, clearTimeout: () => {},
  }, ['renderSysCatalog', 'loadSystem']);
  return { document, readout, projects };
}

function catalogHtml(payload) {
  const client = systemClient();
  client.readout.renderSysKpis(payload);
  client.projects.renderSysCatalog(payload);
  return Object.fromEntries([...client.document.elements].map(([id, el]) => [id, { html: el.innerHTML, text: el.textContent }]));
}

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

test('loadSystem fetches /api/system/summary, deep refresh parameters included', async () => {
  const urls = [];
  const fetchImpl = (url) => { urls.push(url); return Promise.resolve({ json: () => Promise.resolve(systemSummaryPayload(fullPayload(1))) }); };
  const { projects } = systemClient({ fetchImpl });
  await projects.loadSystem();
  await projects.loadSystem(true, false);
  assert.deepEqual(urls, ['/api/system/summary', '/api/system/summary?refresh=deep&trees=0']);
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
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-system-summary-'));
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

test('GET /api/system/summary?refresh=deep starts the scan and answers with its running state', async (t) => {
  const collector = fakeCollector();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-system-summary-'));
  const server = await startDashboard({ port: 0, cwd, system: collector, usage: {}, ...hermeticMaintenance() });
  t.after(() => server.close());
  const r = await request(server, '/api/system/summary?refresh=deep&trees=0');
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(collector.calls.refreshDeep, [{ includeProjectTrees: false }]);
  assert.deepEqual(body.scan, { running: true, phase: 'catalog' });
  assert.equal('artifacts' in body.catalog, false);
});
