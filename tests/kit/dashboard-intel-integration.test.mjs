// dashboard-intel-integration.test.mjs — end-to-end coverage for the seam
// between dashboard-server.mjs's collectData() (served at GET /api/status)
// and dashboard/intel-history.mjs's readers. Boots the REAL HTTP server
// (startDashboard) over an isolated mkdtempSync() fixture dir shaped like a
// real project's .claude-flow/ tree — no real project files are ever
// touched — and asserts the four documented fields (`health`, `globalStats`,
// `patternStore`, `graph`) survive the collectData → JSON round trip exactly
// as intel-history.mjs's own readers would produce them, INCLUDING the
// file-does-not-exist-yet case, which must 200 rather than throw.
//
// fetchStatus is injected (a stub, never `ak status --json`) and its stub
// `drift` is always a real array so collectData takes the caller-supplied
// drift path and never falls through to the network-touching self-computed
// path (driftReport / the brain and ruvector drift folds) — see
// tests/dashboard.test.cjs's own comment on the same hazard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startDashboard } from '../../src/lib/dashboard-server.mjs';
import {
  readNeuralPatternStoreHistory,
  readGraphHistory,
  readGlobalStats,
  readHealthRing,
} from '../../src/lib/dashboard/intel-history.mjs';

const STUB_STATUS = { overall: 'ok', rows: [], drift: [] };

function mkFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-dash-intel-'));
  for (const [rel, data] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, typeof data === 'string' ? data : JSON.stringify(data));
  }
  return dir;
}

function get(url, token) {
  return new Promise((resolve, reject) => {
    const opts = token ? { headers: { 'x-dash-token': token } } : {};
    http.get(url, opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

test('GET /api/status assembles globalStats/patternStore/graph/health exactly as intel-history.mjs would read them off a full fixture', async () => {
  const fixture = mkFixture({
    '.claude-flow/neural/stats.json': {
      patternsLearned: 1337, trajectoriesRecorded: 1400, signalsProcessed: 1266, lastAdaptation: 1785915702033,
    },
    '.claude-flow/neural/patterns.json': [
      { id: 'a', type: 'action', createdAt: 1780024063013, embedding: [1, 2], content: 'x' },
      { id: 'b', type: 'result', createdAt: 1783106501523, embedding: [3, 4], content: 'y' },
    ],
    '.claude-flow/data/intelligence-snapshot.json': [
      { timestamp: 1785257673755, nodes: 110, edges: 1568, pageRankSum: 1, confidences: [0.5], topPatterns: [{ id: 'x' }] },
    ],
    '.claude-flow/health-history.json': [
      { ts: 1700000000, patternsLearned: 10, deltaPP: 5 },
      { ts: 1700000600, patternsLearned: 22, deltaPP: 18 },
    ],
  });

  const { url, close, token } = await startDashboard({
    port: 0, cwd: fixture, fetchStatus: async () => STUB_STATUS,
  });
  try {
    const r = await get(`${url}api/status`, token);
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const body = JSON.parse(r.body);

    // Cross-checked against the SAME readers intel-history.mjs's own unit
    // tests exercise directly, over the same fixture dir — the seam under
    // test is collectData()'s wiring, not the readers' own field logic
    // (that's intel-history.test.mjs's job).
    assert.deepEqual(body.globalStats, readGlobalStats(fixture));
    assert.deepEqual(body.patternStore, readNeuralPatternStoreHistory(fixture));
    assert.deepEqual(body.graph, readGraphHistory(fixture));
    assert.deepEqual(body.health, readHealthRing(fixture));

    // Field-by-field shape assertions per the frozen contract (dashboard-server.mjs's
    // own doc comments above collectData's return).
    assert.deepEqual(body.globalStats, {
      patternsLearned: 1337, trajectoriesRecorded: 1400, signalsProcessed: 1266, lastAdaptation: 1785915702033,
    });
    assert.deepEqual(body.patternStore, [
      { createdAt: new Date(1780024063013).toISOString(), type: 'action' },
      { createdAt: new Date(1783106501523).toISOString(), type: 'result' },
    ]);
    assert.deepEqual(body.graph, [
      { timestamp: 1785257673755, nodes: 110, edges: 1568, pageRankSum: 1 },
    ]);
    assert.equal(body.health.length, 2);

    // patternsLearned (a lifetime counter) and patternStore.length (entries
    // currently on disk) must remain independently reported, never collapsed
    // into one figure — the exact divergence intel-history.mjs's header
    // comment documents and this fixture deliberately exercises (1337 vs 2).
    assert.notEqual(body.globalStats.patternsLearned, body.patternStore.length);
  } finally {
    await close();
  }
});

test('GET /api/status does not throw when NONE of the intel-history sources exist yet — the fresh-project path', async () => {
  const fixture = mkFixture({}); // no .claude-flow/ at all
  const { url, close, token } = await startDashboard({
    port: 0, cwd: fixture, fetchStatus: async () => STUB_STATUS,
  });
  try {
    const r = await get(`${url}api/status`, token);
    assert.equal(r.status, 200, `expected 200 (never a throw), got ${r.status}`);
    const body = JSON.parse(r.body);
    assert.equal(body.health, null);
    assert.equal(body.globalStats, null);
    assert.deepEqual(body.patternStore, []);
    assert.equal(body.graph, null);
  } finally {
    await close();
  }
});

test('GET /api/status tolerates a partial fixture — health-history.json absent while the other three sources are present', async () => {
  // Exercises the exact "create fresh" path Module A's report called out:
  // health-history.json genuinely does not exist yet in a real project even
  // once neural/graph data does, and that must read as null, not a crash.
  const fixture = mkFixture({
    '.claude-flow/neural/stats.json': { patternsLearned: 5 },
    '.claude-flow/neural/patterns.json': [{ id: 'a', type: 'action', createdAt: 1 }],
    '.claude-flow/data/intelligence-snapshot.json': [{ timestamp: 1, nodes: 2, edges: 3, pageRankSum: 0.5 }],
  });
  assert.equal(fs.existsSync(path.join(fixture, '.claude-flow', 'health-history.json')), false);

  const { url, close, token } = await startDashboard({
    port: 0, cwd: fixture, fetchStatus: async () => STUB_STATUS,
  });
  try {
    const r = await get(`${url}api/status`, token);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.health, null, 'health-history.json absent -> null, not a throw');
    assert.deepEqual(body.globalStats, {
      patternsLearned: 5, trajectoriesRecorded: 0, signalsProcessed: 0, lastAdaptation: 0,
    });
    assert.equal(body.patternStore.length, 1);
    assert.equal(body.graph.length, 1);
  } finally {
    await close();
  }
});

test('GET /api/status tolerates malformed JSON in every intel source at once without a 500', async () => {
  const fixture = mkFixture({
    '.claude-flow/neural/stats.json': '{ not json',
    '.claude-flow/neural/patterns.json': 'not json at all',
    '.claude-flow/data/intelligence-snapshot.json': '[unterminated',
    '.claude-flow/health-history.json': 'also not json',
  });
  const { url, close, token } = await startDashboard({
    port: 0, cwd: fixture, fetchStatus: async () => STUB_STATUS,
  });
  try {
    const r = await get(`${url}api/status`, token);
    assert.equal(r.status, 200, 'malformed on-disk JSON must degrade gracefully, never 500');
    const body = JSON.parse(r.body);
    assert.equal(body.health, null);
    assert.equal(body.globalStats, null);
    assert.deepEqual(body.patternStore, []);
    assert.equal(body.graph, null);
  } finally {
    await close();
  }
});
