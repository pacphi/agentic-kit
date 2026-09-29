import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { sandboxHome, sandboxProject, rmrf } from './helpers/home-sandbox.mjs';

const home = sandboxHome('ak-dashboard-read-only');
const project = sandboxProject('ak-dashboard-read-only');
after(() => rmrf(home, project));
const { startDashboard } = await import('../../src/lib/dashboard-server.mjs');

const EXACT = [
  '/api/status', '/api/refresh', '/api/host-health', '/api/live', '/api/live/history',
  '/api/live/events', '/api/live/intelligence', '/api/models', '/api/ruflo-components',
  '/api/usage', '/api/hooks', '/api/limits', '/api/system', '/api/system/summary',
  '/api/maintenance', '/api/sessions',
];
const PARAMETERIZED = [
  '/api/maintenance/v2/inventory', '/api/hooks/source/bad',
  '/api/live/playback/bad/bad', '/api/live/transcripts/bad/bad/events', '/api/session/bad',
];
const ERROR = { error: 'start a refresh with POST /api/refresh' };

function request(server, route, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, server.url), { method, headers: {
      'x-dash-token': server.token, origin: server.url.replace(/\/$/, ''),
      'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    } }, res => {
      // SSE endpoints intentionally stay open. Their response headers are enough
      // to prove that route dispatch has happened; close the reader promptly.
      if (res.headers['content-type']?.includes('text/event-stream')) {
        res.destroy(); resolve({ status: res.statusCode, body: '' }); return;
      }
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error(`timed out: ${route}`)));
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

test('GET route inventory stays aligned with the server dispatch table', () => {
  const source = fs.readFileSync(new URL('../../src/lib/dashboard-server.mjs', import.meta.url), 'utf8');
  const exact = source.match(/const ROUTES = \{([\s\S]*?)\n {4}\};/)?.[1] ?? '';
  const parameterized = source.match(/const PARAM_ROUTES = \[([\s\S]*?)\n {4}\];/)?.[1] ?? '';
  assert.deepEqual([...exact.matchAll(/^ {6}'([^']+)':/gm)].map(match => match[1]), EXACT);
  assert.deepEqual([...parameterized.matchAll(/^ {6}\[(\/.+?\/),/gm)].map(match => match[1]), [
    String.raw`/^\/api\/maintenance\/v2\/.*$/`,
    String.raw`/^\/api\/hooks\/source\/([^/]+)$/`,
    String.raw`/^\/api\/live\/playback\/([^/]+)\/([^/]+)$/`,
    String.raw`/^\/api\/live\/transcripts\/([^/]+)\/([^/]+)\/events$/`,
    String.raw`/^\/api\/session\/(.*)$/`,
  ]);
});

test('all GET routes, including root, cannot start measurement or provider work through scan queries', async t => {
  const calls = { system: 0, maintenance: 0, inventory: 0, rebuild: 0, provider: 0 };
  const hostReadiness = async () => ({ hosts: {} });
  hostReadiness.checkConnection = async () => { calls.provider++; return {}; };
  const server = await startDashboard({ port: 0, cwd: project,
    fetchStatus: async () => ({ overall: 'ok', rows: [], drift: [] }),
    hostReadiness, discoverProjects: () => [],
    system: { read: async () => ({ runtime: {}, knownFiles: [], storage: {}, projects: [], scan: {} }),
      refreshDeep: async () => { calls.system++; return { ok: true }; } },
    maintenance: { report: async () => ({}), scan: async () => { calls.maintenance++; return {}; },
      plan: async () => ({}) },
    management: { refreshInventory: async () => { calls.inventory++; },
      rebuildAfterMeasurement: async () => { calls.rebuild++; } },
    usage: { readIndex: async () => ({ sessions: [] }), readSession: async () => null,
      masker: async () => value => value }, live: { snapshot: async () => ({}), replay: async () => ({ events: [] }),
      subscribe: () => () => {} }, models: async () => ({ status: 'empty' }),
    limits: async () => ({}), hooks: {}, transcripts: {},
  });
  t.after(() => server.close());
  for (const route of ['/', '/index.html', ...EXACT, ...PARAMETERIZED]) {
    for (const suffix of ['?refresh=deep', '?refresh=scan&refresh=deep&trees=1', '?trees=1']) {
      await request(server, route + suffix);
      assert.deepEqual(calls, { system: 0, maintenance: 0, inventory: 0, rebuild: 0, provider: 0 }, route + suffix);
    }
  }
  for (const route of ['/api/system', '/api/system/summary', '/api/maintenance']) {
    for (const suffix of ['?refresh=deep', '?refresh=scan&refresh=deep&trees=1', '?trees=1']) {
      const response = await request(server, route + suffix);
      assert.equal(response.status, 400, route + suffix);
      assert.deepEqual(JSON.parse(response.body), ERROR);
    }
  }
  assert.equal((await request(server, '/api/host-health/local', 'POST')).status, 405);
});
