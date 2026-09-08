import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { catalogSurfaceSpecs } from '../../src/lib/footprint/catalog-surfaces.mjs';
import { JS } from '../../src/lib/dashboard/client.mjs';
import { collectDiscoveryProjects } from '../../src/lib/maintenance/management/service-inventory.mjs';
import { scanProgress } from '../../src/lib/maintenance/management/service-discovery.mjs';
import { hermesDir } from '../../src/lib/paths.mjs';
import { runInventoryQuery } from '../../src/lib/maintenance/management/query.mjs';
import { SENTINEL_FIXTURES } from '../fixtures/maintenance/management-fixtures.mjs';

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function client(file, deps, bindings) {
  const source = fs.readFileSync(new URL(`../../src/lib/dashboard/client/${file}.mjs`, import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?from ['"][^'"]+['"];\s*$/gm, '')
    .replace(/\bexport (?=(?:function|var)\b)/g, '');
  return new Function(...Object.keys(deps), `${source}\nreturn {${bindings.join(',')}};`)(...Object.values(deps));
}
function cards(state) {
  return client('maintenance-cards', { MNT: state, esc, mntKindLabel: (s) => s, sessionStorage: { getItem: () => null } }, ['renderMntGroups']);
}
function row(id, projectId = null) {
  return { placementId: id, projectId, displayName: 'a11y-ally', kind: 'skill', scope: { value: projectId ? 'project' : 'user', label: projectId ? 'Projects' : 'User' }, breadcrumb: projectId ? ['agentic-kit', 'Skills'] : ['Codex', 'Skills'], consumerHosts: ['Codex'], versions: {}, guidanceLane: null };
}
function group(id, placements) { return { resourceId: id, displayName: 'a11y-ally', kind: 'skill', placementCount: placements.length, placements }; }

test('dashboard bundle remains valid classic JavaScript', () => { assert.doesNotThrow(() => new vm.Script(JS)); });
test('singleton card has one visible name, neutral action, and escapes metadata', () => {
  const state = { scope: 'user', facets: {}, plc: null };
  const item = { ...row('p1'), displayName: '<script>name</script>' };
  const html = cards(state).renderMntGroups([group('r1', [item])], { value: 0 });
  assert.ok(html.includes('&lt;script&gt;name&lt;/script&gt;'));
  assert.equal((html.match(/class="mnt-row-name"/g) || []).length, 1);
  assert.match(html, /data-mnt-plc="p1"/);
  assert.match(html, /View details/);
  assert.doesNotMatch(html, /<script>|Remove registration|Variant|ContentDigest/);
});
test('project sections remove inherited project text without merging same-name resources', () => {
  const state = { scope: 'project', facets: { kind: ['skill'] }, query: { facetLabels: { project: { pr1: 'agentic-kit' } } } };
  const html = cards(state).renderMntGroups([group('r1', [row('p1', 'pr1')]), group('r2', [row('p2', 'pr1')])], { value: 0 });
  assert.equal((html.match(/class="mnt-project-section"/g) || []).length, 1);
  assert.equal((html.match(/agentic-kit/g) || []).length, 1);
  assert.equal((html.match(/class="mnt-group mnt-group-single"/g) || []).length, 2);
  assert.match(html, /Used by Codex/);
  assert.doesNotMatch(html, /mnt-group-kind/);
});
test('query rows carry opaque project identity for context grouping', () => {
  const inventory = SENTINEL_FIXTURES.projects();
  const page = runInventoryQuery(inventory, { scope: 'project' });
  for (const item of page.groups.flatMap((g) => g.placements)) {
    assert.equal(item.projectId, inventory.placements.find((p) => p.placementId === item.placementId).projectId);
  }
});
test('a project filter never strips context from a user placement', () => {
  const state = { scope: 'across', facets: { project: ['pr1'] } };
  const html = cards(state).renderMntGroups([group('r1', [row('p1')])], { value: 0 });
  assert.match(html, /User · Codex › Skills/);
});
function operation(get) {
  const state = {};
  const nodes = Object.fromEntries(['mnt-check-providers', 'mnt-remeasure', 'mnt-check-providers-status', 'mnt-operation-elapsed'].map((id) => [id, { textContent: '', dataset: {} }]));
  const api = client('maintenance-operation', { MNT: state, mntGet: get, mntRefreshActiveDestination() {}, loadSystem: async () => {}, SYSTEM: {}, systemBusy: false, document: { getElementById: (id) => nodes[id], addEventListener() {} }, setInterval: () => 1, clearInterval() {}, setTimeout: (fn) => queueMicrotask(fn) }, ['mntCheckProviders', 'mntBuildStatusOf', 'mntAwaitInventoryBuild']);
  return { state, nodes, ...api };
}
test('an existing inventory does not mask a running or failed refresh', () => {
  const api = operation(() => {});
  assert.equal(api.mntBuildStatusOf({ scanRequired: false, lastRefresh: { status: 'running' } }), 'running');
  assert.equal(api.mntBuildStatusOf({ scanRequired: false, lastRefresh: { status: 'failed' } }), 'failed');
});
test('refresh keeps both buttons disabled until a fresh inventory is published', async () => {
  let inventoryCalls = 0, providerCalls = 0, release;
  const publication = new Promise((resolve) => { release = resolve; });
  let signalWaiting;
  const waiting = new Promise((resolve) => { signalWaiting = resolve; });
  const api = operation(async (url) => {
    if (url.includes('/v2/inventory')) {
      inventoryCalls++;
      if (inventoryCalls === 1) return { scanRequired: false, lastRefresh: { at: 'old', status: 'ok' } };
      signalWaiting();return publication;
    }
    if (url.includes('?refresh=scan')) return {};
    providerCalls++;
    return { activity: { status: 'idle' }, scan: { status: 'complete', checkedAt: providerCalls === 1 ? 'old' : 'new', coverage: 'complete' } };
  });
  const run = api.mntCheckProviders();
  await waiting;
  assert.equal(api.nodes['mnt-check-providers'].disabled, true);
  assert.equal(api.nodes['mnt-remeasure'].disabled, true);
  assert.match(api.state.operation.message, /Updating inventory/);
  release({ scanRequired: false, lastRefresh: { at: 'new', status: 'ok' }, partialSources: { total: 1 } });
  await run;
  assert.equal(api.nodes['mnt-remeasure'].disabled, false);
  assert.match(api.state.operation.message, /coverage gaps/);
});
test('provider failure is visible and releases the busy state', async () => {
  const api = operation(async (url) => {
    if (url.includes('/v2/inventory')) return { lastRefresh: { at: 'old' } };
    if (url.includes('?refresh=scan')) throw new Error('Evidence request failed.');
    return { scan: { checkedAt: 'old' } };
  });
  await api.mntCheckProviders();
  assert.equal(api.state.operation.failed, true);
  assert.match(api.state.operation.message, /Evidence request failed/);
  assert.equal(api.nodes['mnt-remeasure'].disabled, false);
});
test('filesystem completion excludes provider checks without inventing their success', () => {
  const ctx = { state: {}, orchestrator: () => ({ coverage: () => [{ sourceId: 'files', state: 'complete', visited: 4 }], progress: () => [] }), lastGoodDiscoveryStore: { current: () => [] }, listSources: () => [{ sourceId: 'files', filesystem: true }, { sourceId: 'providers', filesystem: false, label: 'Providers' }] };
  const result = scanProgress(ctx)();
  assert.match(result.narrative, /1 of 1/);
  assert.equal(result.coverage.find((c) => c.sourceId === 'providers').state, 'not-scanned');
  assert.equal(result.evidenceChecks[0].method, 'Refresh evidence');
});
test('Hermes path honors HERMES_HOME and otherwise resolves the user configuration', () => {
  const previous = process.env.HERMES_HOME;
  try {
    process.env.HERMES_HOME = '/tmp/maintenance-hermes-test';
    assert.equal(hermesDir(), '/tmp/maintenance-hermes-test');
    delete process.env.HERMES_HOME;
    assert.ok(hermesDir().endsWith('/.hermes'));
  } finally { if (previous === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = previous; }
});

test('a delayed path reveal cannot populate a different selection', async () => {
  let finish;
  const reply = new Promise((resolve) => { finish = resolve; });
  const state = { plc: 'p1' };
  const api = client('maintenance-inspector', { MNT: state, mntPost: () => reply }, ['mntBeginReveal', 'getRevealed:()=>mntRevealed']);
  const pending = api.mntBeginReveal();
  state.plc = 'p2';
  finish({ exactPath: '/private/original' });
  await pending;
  assert.equal(api.getRevealed(), null);
});
test('closing an inspector invalidates a pending path reveal and restores the row', async () => {
  let finish, focused = false;
  const reply = new Promise((resolve) => { finish = resolve; });
  const state = { plc: 'p1' }, panel = { hidden: false, innerHTML: '' };
  const api = client('maintenance-inspector', { MNT: state, mntPost: () => reply, document: { getElementById: () => panel, querySelectorAll: () => [], querySelector: () => ({ focus() { focused = true; } }) }, mntPopEscapable() {}, mntSyncHash() {} }, ['mntBeginReveal', 'mntCloseInspector', 'getRevealed:()=>mntRevealed', 'setOrigin:(id)=>{mntInspectorOriginPlc=id}']);
  api.setOrigin('p1');
  const pending = api.mntBeginReveal();
  api.mntCloseInspector();
  finish({ exactPath: '/private/original' });
  await pending;
  assert.equal(api.getRevealed(), null);
  assert.equal(panel.hidden, true);
  assert.equal(focused, true);
});
test('advanced facets remain available, and selected values survive option search', () => {
  const state = { facets: { environment: ['env1'] }, query: { facetLabels: { environment: { env1: 'This Mac' } } } };
  const api = client('maintenance-filters', { MNT: state, esc, mntProjectDesignation: () => '', mntHumanize: (s) => s, MNT_CURATED_VIEW_LABELS: {} }, ['renderMntFacetGroup', 'setNeedle:(name,value)=>{mntFacetNeedles[name]=value}']);
  api.setNeedle('environment', 'another');
  const html = api.renderMntFacetGroup('environment', { env1: 42 });
  assert.match(html, /data-mnt-disclosure="environment" open/);
  assert.match(html, /value="env1" checked/);
  assert.doesNotMatch(html, /class="mnt-facet-opt" hidden/);
});
test('a narrowed facet preserves the control for clearing its active search', () => {
  const state = { facets: {}, query: { facetLabels: { project: { p1: 'agentic-kit' } } } };
  const api = client('maintenance-filters', { MNT: state, esc, mntProjectDesignation: () => '', mntHumanize: (s) => s, MNT_CURATED_VIEW_LABELS: {} }, ['renderMntFacetGroup', 'setNeedle:(name,value)=>{mntFacetNeedles[name]=value}']);
  api.setNeedle('project', 'another');
  assert.match(api.renderMntFacetGroup('project', { p1: 1 }), /data-mnt-facet-search="project"/);
});
test('resource disclosure keys distinguish project sections', () => {
  const placements = ['pr1', 'pr2'].flatMap((projectId) => [1, 2, 3, 4].map((i) => row(`${projectId}-${i}`, projectId)));
  const state = { scope: 'project', facets: {}, query: { facetLabels: { project: { pr1: 'First project', pr2: 'Second project' } } } };
  const html = cards(state).renderMntGroups([group('resource1', placements)], { value: 0 });
  assert.match(html, /data-mnt-group-toggle="resource1:pr1"/);
  assert.match(html, /data-mnt-group-toggle="resource1:pr2"/);
});


test('Hosts and external Adapters are separate filter axes', () => {
  const fixture=structuredClone(SENTINEL_FIXTURES.base());
  const item=fixture.placements[0];item.consumerHosts=['claude','codex','opencode','hermes','agentic-kit'];
  const page=runInventoryQuery(fixture,{});
  assert.equal(page.facetCounts.consumer.hermes,undefined);
  assert.equal(page.facetCounts.consumer['agentic-kit'],undefined);
  assert.ok(page.facetCounts.adapter.hermes>0);
  assert.equal(page.facetCounts.adapter.codex,undefined);
});
test('implicit managed host directories do not become catalog projects', () => {
  const roots={claudeRoot:'/fixture/.claude',claudeMcpFile:'/fixture/.claude.json',codexRoot:'/fixture/.codex',codexConfigFile:'/fixture/.codex/config.toml',opencodeRoot:'/fixture/.config/opencode',opencodeConfigFile:'/fixture/.config/opencode/opencode.json',agentsRoot:'/fixture/.agents',cwd:process.cwd(),projects:['/fixture/.codex/plugins/example/1.2.0','/fixture/work/non-git','/fixture/work/1.2.0'],env:{}};
  const readers={marker:()=>({}),markdown:()=>({}),stems:()=>({}),manifest:()=>({}),toml:()=>({})};
  const surfaces=catalogSurfaceSpecs(roots,readers,{fsImpl:{readFileSync:()=> '{}'}}).specs;
  assert.equal(surfaces.some((s)=>s.project==='/fixture/.codex/plugins/example/1.2.0'),false);
  assert.ok(surfaces.some((s)=>s.project==='/fixture/work/non-git'));
  assert.ok(surfaces.some((s)=>s.project==='/fixture/work/1.2.0'));
  roots.projects=[{path:'/fixture/.codex/projects/explicit',configured:true}];
  assert.ok(catalogSurfaceSpecs(roots,readers,{fsImpl:{readFileSync:()=> '{}'}}).specs.some((s)=>s.project==='/fixture/.codex/projects/explicit'));
});

test('automatic host plugin repositories do not become projects; explicit sources retain them', () => {
  const row = { projectId: 'project', label: '1.12.0' };
  const calls = [];
  const ctx = { listSources: () => [{ sourceId: 'host', kind: 'automatic' }, { sourceId: 'explicit', kind: 'exact-project' }], orchestrator: () => ({
    projectRoots: ({ sourceId }) => { calls.push(sourceId); return new Map([['project', '/host/plugins/1.12.0']]); },
    projects: () => [row],
  }) };
  assert.deepEqual(collectDiscoveryProjects(ctx, ['host', 'explicit']), [{ ...row, path: '/host/plugins/1.12.0' }]);
  assert.deepEqual(calls, ['explicit']);
});
test('path reveal failures show a recoverable message instead of silently doing nothing', async () => {
  const panel = { innerHTML: '' };
  const api = client('maintenance-inspector', { MNT: { plc: 'p1', inspector: {} }, esc, mntIcon: () => '', document: { getElementById: (id) => id === 'mnt-inspector' ? panel : null }, mntKindLabel: () => '', mntPost: () => Promise.reject(new Error('missing')) }, ['mntBeginReveal', 'mntRevealHtml']);
  await api.mntBeginReveal();
  assert.match(api.mntRevealHtml(), /could not be revealed/);
  assert.match(api.mntRevealHtml(), /Reveal exact path/);
});

test('procedure opens outside hidden destination panels and reports request failures', async () => {
  const panel = { open: false, innerHTML: '', showModal() { this.open = true; }, querySelector: () => ({ focus() {} }) };
  const api = client('maintenance-guidance', { MNT: {}, mntRegisterDestination() {}, document: { getElementById: () => panel }, mntGet: () => Promise.reject(new Error('unavailable')) }, ['mntOpenProcedure']);
  await api.mntOpenProcedure('g1');
  assert.equal(panel.open, true);
  assert.match(panel.innerHTML, /could not be loaded/);
});
test('closing a loading procedure discards its delayed response', async () => {
  let finish;
  const panel = { open: false, innerHTML: '', showModal() { this.open = true; }, close() { this.open = false; } };
  const state = {};
  const api = client('maintenance-guidance', { MNT: state, mntRegisterDestination() {}, document: { getElementById: () => panel }, mntGet: () => new Promise((resolve) => { finish = resolve; }) }, ['mntOpenProcedure', 'mntCloseProcedure']);
  const pending = api.mntOpenProcedure('g1');
  api.mntCloseProcedure();finish({ outcome: 'obsolete' });await pending;
  assert.equal(panel.open, false);
  assert.equal(state.procedure, null);
});

test('a valid procedure renders commands and verification inside the open dialog', async () => {
  const panel = { open: false, innerHTML: '', showModal() { this.open = true; }, querySelector: () => ({ focus() {} }) };
  const data = { outcome: 'Install a dependency', source: { publisher: 'fixture', recipeVersion: '1' }, command: { shell: 'bash', shellLabel: 'Bash', text: "'npm' 'install' '--global' 'lightpanda'" }, verification: { text: 'lightpanda --version' }, checklist: [], nextStepLabel: 'Verify installation' };
  const api = client('maintenance-guidance', { MNT: {}, esc, mntRegisterDestination() {}, document: { getElementById: () => panel }, mntGet: () => Promise.resolve(data) }, ['mntOpenProcedure']);
  await api.mntOpenProcedure('g1');
  assert.equal(panel.open, true);
  assert.match(panel.innerHTML, /Copy command/);
  assert.match(panel.innerHTML, /lightpanda --version/);
});

test('loading another page extends a family without repeating its heading or placements', () => {
  const api = client('maintenance-inventory', { mntRegisterDestination() {}, mntDebounce: (fn) => fn }, ['mntMergeGroups']);
  const groups = api.mntMergeGroups([{ resourceId: 'r1', presentationKey: 'family', placements: [{ placementId: 'p1' }] }], [{ resourceId: 'r2', presentationKey: 'family', placements: [{ placementId: 'p1' }, { placementId: 'p2' }] }]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].placements.map((p) => p.placementId), ['p1', 'p2']);
});
