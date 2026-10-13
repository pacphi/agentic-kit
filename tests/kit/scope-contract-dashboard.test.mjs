// Scope contract (P0-08, design #289 "Making it stick", part 3.2): the dashboard, started from a
// folder that has not opted in, serves every GET and SSE route without writing anything outside
// the cache. The real default collectors run; only HOME, XDG_* and PATH are sandboxed. "Outside
// the cache" uses the scope gate's own rule (isInside / cacheDir), so a write is a user-level
// write here exactly when checkWrite() would report it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { sandboxHome, sandboxProject, rmrf, snapshot } from './helpers/home-sandbox.mjs';
import { changedPaths, compareToBaseline, explain, loadBaseline, note } from './helpers/user-level-writes.mjs';

const home = sandboxHome('ak-scope-dash');
const project = sandboxProject('ak-scope-dash'); // a git folder that never ran `ak init`
after(() => rmrf(home, project));
const paths = await import('../../src/lib/paths.mjs');
const { assertSandboxed } = await import('./helpers/home-sandbox.mjs');
const { cacheDir } = await import('../../src/lib/cache-dir.mjs');
const { isInside } = await import('../../src/lib/scope-gate.mjs');
const { startDashboard } = await import('../../src/lib/dashboard-server.mjs');
assertSandboxed(paths, home);

const SOURCE = fs.readFileSync(new URL('../../src/lib/dashboard-server.mjs', import.meta.url), 'utf8');
const exactRoutes = () => [...(SOURCE.match(/const ROUTES = \{([\s\S]*?)\n {4}\};/)?.[1] ?? '')
  .matchAll(/^ {6}'([^']+)':/gm)].map((m) => m[1]);
const paramPatterns = () => [...(SOURCE.match(/const PARAM_ROUTES = \[([\s\S]*?)\n {4}\];/)?.[1] ?? '')
  .matchAll(/^ {6}\[(\/.+?\/),/gm)].map((m) => m[1]);

// One concrete path per PARAM_ROUTES pattern, in source order. A new pattern fails the count
// check below until a sample is added, so no route goes unserved by this test.
const PARAM_SAMPLES = [
  '/api/maintenance/v2/inventory', '/api/hooks/source/bad', '/api/live/playback/bad/bad',
  '/api/live/transcripts/bad/bad/events', '/api/session/bad',
];

function request(server, route) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, server.url), { headers: {
      'x-dash-token': server.token, origin: server.url.replace(/\/$/, ''), 'sec-fetch-site': 'same-origin',
    } }, (res) => {
      // An SSE route stays open: its headers prove dispatch ran, so close the reader.
      if (res.headers['content-type']?.includes('text/event-stream')) {
        res.destroy(); resolve({ status: res.statusCode, sse: true }); return;
      }
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, sse: false }));
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error(`timed out: ${route}`)));
    req.end();
  });
}

/** The cache, the folders above it, and the sandbox's temp folder are not user-level writes. */
const isAllowed = (absolute, isFolder) => {
  const cache = cacheDir();
  return isInside(cache, absolute) || (isFolder && isInside(absolute, cache)) || isInside(path.join(home, 'tmp'), absolute);
};

test('the route lists parsed from the server match the samples this test serves', () => {
  assert.ok(exactRoutes().length >= 16, `parsed ${exactRoutes().length} exact routes`);
  assert.equal(paramPatterns().length, PARAM_SAMPLES.length,
    'a parameterized dashboard route was added or removed: update PARAM_SAMPLES');
});

test('every dashboard GET and SSE route from a folder that has not opted in: only baseline user-level writes', async (t) => {
  const server = await startDashboard({ port: 0, cwd: project });
  t.after(() => server.close());
  const homeBefore = snapshot(home);
  const projectBefore = snapshot(project);
  const served = [];
  for (const route of ['/', '/index.html', ...exactRoutes(), ...PARAM_SAMPLES]) {
    const res = await request(server, route);
    served.push({ route, status: res.status, sse: res.sse });
    assert.ok(res.status > 0, route);
  }
  assert.ok(served.some((r) => r.sse), 'at least one SSE route was served');
  assert.ok(served.filter((r) => r.status === 200).length >= 3, `too few routes answered 200: ${JSON.stringify(served)}`);
  await server.close();

  assert.deepEqual(changedPaths(projectBefore, project, () => false), [], 'the un-opted-in folder changed');
  const observed = new Map();
  for (const rel of changedPaths(homeBefore, home, isAllowed)) note(observed, rel, 'dashboard');
  const result = compareToBaseline(observed, loadBaseline().dashboard, 'path');
  assert.deepEqual(result, { added: [], stale: [] }, explain('dashboard write', result));
});
