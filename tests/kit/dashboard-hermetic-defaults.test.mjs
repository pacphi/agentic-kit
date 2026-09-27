// tests/kit/dashboard-hermetic-defaults.test.mjs
// Audit Open item: the guard fired only for an injected maintenance service; a
// caller that injected only a System collector still got the default
// maintenance service and facade over the REAL control root (the
// system-summary incident, 259f075). The home is sandboxed so a regression
// writes the sandbox, and the test reads the sandbox to prove it did not.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { sandboxHome, assertSandboxed, rmrf } from './helpers/home-sandbox.mjs';
import { waitUntil } from './helpers/wait-until.mjs';

const home = sandboxHome('ak-dash-hermetic');
after(() => rmrf(home));
const paths = await import('../../src/lib/paths.mjs');
assertSandboxed(paths, home);
const { startDashboard } = await import('../../src/lib/dashboard-server.mjs');

function get(server, route) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, server.url), { headers: { 'x-dash-token': server.token } }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
}

const collector = () => ({
  async read() { return { runtime: {}, knownFiles: [], storage: {}, projects: [], snapshot: null, scan: { running: false } }; },
  async refreshDeep() { return { ok: true, persisted: { ok: true } }; },
  scanState() { return { running: true, phase: 'catalog' }; },
});

test('an injected System collector alone never builds the default maintenance service', async (t) => {
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  t.after(() => { console.error = realError; });
  const server = await startDashboard({ port: 0, cwd: home, system: collector(), usage: {} });
  t.after(() => server.close());

  const deep = await get(server, 'api/system?refresh=deep');
  assert.equal(deep.status, 200);
  await waitUntil(() => errors.some((e) => /maintenanceOptions\.controlRoot/.test(e)),
    'the refused default maintenance service must be logged', { timeout: 5000 });
  const maintenance = await get(server, 'api/maintenance');
  assert.equal(maintenance.status, 503);
  assert.equal(fs.existsSync(path.join(paths.maintenanceControlDir())), false,
    `nothing may be written under ${paths.maintenanceControlDir()}`);
  assert.equal(errors.filter((e) => /maintenanceOptions\.controlRoot/.test(e)).length, 1, 'logged once, not per request');
});

test('an explicit control root keeps the default maintenance service available to fakes', async (t) => {
  const controlRoot = fs.mkdtempSync(path.join(home, 'control-'));
  const server = await startDashboard({ port: 0, cwd: home, system: collector(), usage: {},
    maintenanceOptions: { controlRoot } });
  t.after(() => server.close());
  const maintenance = await get(server, 'api/maintenance');
  assert.equal(maintenance.status, 200, maintenance.body);
  assert.equal(fs.existsSync(paths.maintenanceControlDir()), false);
});

test('a server with no injected collector keeps its defaults (the real command)', async () => {
  const { __test } = await import('../../src/lib/dashboard-server.mjs');
  assert.equal(__test.refusesDefaultState({}), false);
  assert.equal(__test.refusesDefaultState({ liveOptions: {} }), false);
  assert.equal(__test.refusesDefaultState({ system: {} }), true);
  assert.equal(__test.refusesDefaultState({ fetchStatus: async () => ({}) }), true);
  assert.equal(__test.refusesDefaultState({ system: {}, maintenanceOptions: { controlRoot: '/x' } }), false);
  assert.equal(__test.refusesDefaultState({ system: {}, maintenance: {} }), false);
});
