import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxHome, sandboxProject, rmrf } from './helpers/home-sandbox.mjs';

const home = sandboxHome('ak-dashboard-refresh');
const project = sandboxProject('ak-dashboard-refresh');
const controlRoot = fs.mkdtempSync(path.join(home, 'control-'));
after(() => rmrf(home, project));
const { startDashboard } = await import('../../src/lib/dashboard-server.mjs');

function request(server, method, route, body, headers = {}) {
  const url = new URL(route, server.url);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: {
      'content-type': 'application/json', 'x-dash-token': server.token,
      origin: url.origin, 'sec-fetch-site': 'same-origin', ...headers,
    } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = null; }
        resolve({ status: res.statusCode, json, body: data });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function stages(overrides = {}) {
  return Object.fromEntries(['machine', 'maintenance', 'inventory', 'live', 'local'].map(id =>
    [id, overrides[id] ?? (async () => ({ ok: true }))]));
}

async function serverWith(stagesMap) {
  return startDashboard({ port: 0, cwd: project,
    fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    hostReadiness: async () => ({ hosts: {} }),
    system: { read: async () => ({}), refreshDeep: async () => ({ ok: true }) },
    maintenance: { report: async () => ({}), scan: async () => ({}), plan: async () => ({}) },
    management: { refreshInventory: async () => ({ ok: true }) },
    maintenanceOptions: { controlRoot }, usage: {}, discoverProjects: () => [],
    refreshStages: stagesMap,
  });
}

async function finished(server) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const latest = await request(server, 'GET', '/api/refresh');
    if (latest.json.running === false && latest.json.lastRun !== null) return latest.json;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('refresh did not finish');
}

test('refresh POST needs the header capability and same origin, and validates its bounded body', async t => {
  const server = await serverWith(stages());
  t.after(() => server.close());
  assert.deepEqual((await request(server, 'GET', '/api/refresh')).json, { running: false, lastRun: null });
  const valid = { strength: 'local' };
  assert.equal((await request(server, 'POST', '/api/refresh', valid, { 'x-dash-token': '' })).status, 401);
  assert.equal((await request(server, 'POST', `/api/refresh?token=${server.token}`, valid, { 'x-dash-token': '' })).status, 401);
  assert.equal((await request(server, 'POST', '/api/refresh', valid, { origin: 'http://evil.test' })).status, 403);
  for (const body of [{ strength: 'other' }, { strength: 'local', extra: true },
    { strength: 'local', projectTrees: true }, { strength: 'machine', projectTrees: 'yes' }, {}]) {
    assert.equal((await request(server, 'POST', '/api/refresh', body)).status, 400, JSON.stringify(body));
  }
});

test('refresh POST starts ordered local work once and GET exposes progress and completion', async t => {
  const calls = [];
  const server = await serverWith(stages(Object.fromEntries(['maintenance', 'inventory', 'local'].map(id =>
    [id, async () => { calls.push(id); return { ok: true }; }]))));
  t.after(() => server.close());
  const post = await request(server, 'POST', '/api/refresh', { strength: 'local' });
  assert.equal(post.status, 202);
  assert.equal(post.json.started, true);
  const state = await finished(server);
  assert.equal(state.ok, true);
  assert.equal(state.strength, 'local');
  assert.deepEqual(state.stages.map(({ id, state: stageState }) => [id, stageState]),
    [['maintenance', 'done'], ['inventory', 'done'], ['local', 'done']]);
  assert.deepEqual(calls, ['maintenance', 'inventory', 'local']);
  assert.ok(state.startedAt && state.finishedAt);
});

test('successive refreshes expose distinct stable operation identities', async t => {
  const server = await serverWith(stages());
  t.after(() => server.close());
  const firstPost = await request(server, 'POST', '/api/refresh', { strength: 'local' });
  const first = await finished(server);
  const secondPost = await request(server, 'POST', '/api/refresh', { strength: 'local' });
  const second = await finished(server);
  assert.equal(firstPost.status, 202);
  assert.equal(secondPost.status, 202);
  assert.match(first.operationId, /^[0-9a-f-]{36}$/);
  assert.equal(firstPost.json.state.operationId, first.operationId);
  assert.equal(secondPost.json.state.operationId, second.operationId);
  assert.notEqual(first.operationId, second.operationId);
});

test('a second POST cannot start work while the operation is in flight', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const server = await serverWith(stages({ maintenance: async () => { await held; return { ok: true }; } }));
  t.after(() => { release(); return server.close(); });
  assert.equal((await request(server, 'POST', '/api/refresh', { strength: 'local' })).status, 202);
  const conflict = await request(server, 'POST', '/api/refresh', { strength: 'machine' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, 'a refresh is already running');
  assert.equal(conflict.json.state.running, true);
  release();
  await finished(server);
});

test('a failed machine measurement skips dependent stages and still performs local refresh', async t => {
  const called = [];
  const server = await serverWith(stages({
    machine: async () => ({ ok: false, detail: 'measurement failed' }),
    maintenance: async () => { called.push('maintenance'); return { ok: true }; },
    inventory: async () => { called.push('inventory'); return { ok: true }; },
    local: async () => { called.push('local'); return { ok: true }; },
  }));
  t.after(() => server.close());
  assert.equal((await request(server, 'POST', '/api/refresh', { strength: 'machine', projectTrees: true })).status, 202);
  const state = await finished(server);
  assert.deepEqual(state.stages.map(({ id, state: stageState }) => [id, stageState]),
    [['machine', 'failed'], ['maintenance', 'skipped'], ['inventory', 'skipped'], ['local', 'done']]);
  assert.deepEqual(called, ['local']);
  assert.equal(state.ok, false);
});

test('dashboard local stage forces host readiness after collecting status', async () => {
  const { dashboardRefreshStages } = await import('../../src/lib/dashboard/refresh-api.mjs');
  const calls = [];
  const actual = dashboardRefreshStages({ cwd: project, pkgRoot: project,
    getSystem: async () => ({ refreshDeep: async () => ({ ok: true }) }),
    getMaintenance: async () => ({ scan: async () => ({}) }),
    refreshInventoryAfterProviderScan: async () => ({}),
    statusCollect: async () => { calls.push('status'); return { rows: [] }; },
    getHostReadiness: async options => { calls.push(options); return { hosts: {} }; },
    loadConfig: () => ({}),
  });
  assert.equal((await actual.local()).ok, true);
  assert.deepEqual(calls, ['status', { force: true }]);
});

test('an inventory rebuild that the server reports unavailable fails its stage', async () => {
  const { dashboardRefreshStages } = await import('../../src/lib/dashboard/refresh-api.mjs');
  const actual = dashboardRefreshStages({ cwd: project,
    getSystem: async () => ({}), getMaintenance: async () => ({}),
    refreshInventoryAfterProviderScan: async () => null,
    statusCollect: async () => ({}), getHostReadiness: async () => ({}), loadConfig: () => ({}),
  });
  assert.equal((await actual.inventory({ strength: 'local' })).ok, false);
});
