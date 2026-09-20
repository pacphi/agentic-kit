import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startDashboard } from '../../src/lib/dashboard-server.mjs';

function request(server, method, route, body, headers = {}) {
  const url = new URL(route, server.url);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { 'content-type': 'application/json',
      'x-dash-token': server.token, origin: url.origin, 'sec-fetch-site': 'same-origin', ...headers } }, res => {
      let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('connection route requires same-origin header auth, explicit consent, and bounded fixed inputs', async t => {
  let reads = 0, connections = 0, closed = false;
  const read = async () => { reads++; return { hosts: { codex: { status: 'ok' } } }; };
  read.checkConnection = async body => { connections++; assert.equal(body.confirm, true); return read(); };
  read.close = () => { closed = true; };
  const server = await startDashboard({ port: 0, cwd: process.cwd(),
    fetchStatus: async () => ({ overall: 'ok', rows: [], drift: [] }), hostReadiness: read,
    discoverProjects: () => [],
  });
  t.after(() => server.close());
  const body = { host: 'codex', confirm: true, evidenceKey: 'a'.repeat(64) };
  assert.equal((await request(server, 'GET', '/api/host-health')).status, 200);
  assert.equal(connections, 0);
  assert.equal((await request(server, 'POST', '/api/host-health/connection', { ...body, confirm: false })).status, 400);
  assert.equal((await request(server, 'POST', '/api/host-health/connection', { ...body, cwd: '/other' })).status, 400);
  assert.equal((await request(server, 'POST', '/api/host-health/connection', body, { origin: 'http://evil.test' })).status, 403);
  assert.equal((await request(server, 'POST', '/api/host-health/connection?token='+server.token, body, { 'x-dash-token': '' })).status, 401);
  assert.equal(connections, 0);
  assert.equal((await request(server, 'POST', '/api/host-health/connection', {host:'codex',extra:'x'.repeat(5000)})).status, 413);
  assert.equal((await request(server, 'POST', '/api/host-health/connection', body, {'content-type':'text/plain'})).status, 415);
  assert.equal((await request(server, 'POST', '/api/host-health/connection', [])).status, 400);
  assert.equal((await request(server, 'POST', '/api/host-health/connection', body)).status, 200);
  assert.equal(connections, 1);
  assert.equal((await request(server, 'POST', '/api/host-health/local', { host: 'codex' })).status, 200);
  assert.equal(connections, 1);
  assert.ok(reads >= 3);
  await server.close();
  assert.equal(closed, true);
});
