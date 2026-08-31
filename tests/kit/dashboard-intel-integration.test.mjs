// dashboard-intel-integration.test.mjs — end-to-end coverage for the seam
// between dashboard-server.mjs's machine-wide Intelligence plumbing
// (collectData()'s `intel` object, served at GET /api/status; the
// /api/live/intelligence watcher pool) and dashboard/project-discovery.mjs +
// dashboard/intel-history.mjs.
//
// REWRITTEN for the machine-wide Intelligence redesign. This file previously
// pinned the PRIOR alpha's single-project, top-level
// health/globalStats/patternStore/graph shape, hardcoded to the server's own
// launching cwd. That shape is now GONE — dashboard-server.mjs's own header
// comment above buildProjectSnapshotCache documents this as a deliberate
// clean break ("no relation to the prior alpha's flat ... top-level fields,
// which this supersedes and removes"); no backward compatibility was
// required or attempted. The four series now live under `body.intel.*`,
// keyed off a machine-wide, `?project=`-selectable project catalog rather
// than the server's cwd — so the old assertions (`body.health` etc.) simply
// no longer have anything to read and this file is rewritten to match, not
// patched around the old shape.
//
// Every project here is INJECTED via startDashboard's `discoverProjects`
// option (mirroring the file's other DI conventions — fetchStatus,
// intelWatch) so this suite never depends on this machine's real
// ~/.claude-flow/*.json registry or ~/.config/agentic-kit/observability-
// workspaces.json — the same real-machine-independence
// project-discovery.test.mjs and intel-history.test.mjs already rely on.
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
import { startDashboard as realStartDashboard } from '../../src/lib/dashboard-server.mjs';
import { readMachineWideIntel } from '../../src/lib/dashboard/intel-history.mjs';
import { resolveProjectIdentity } from '../../src/lib/live/project-label.mjs';

const STUB_STATUS = { overall: 'ok', rows: [], drift: [] };

// Fix round 1, I-3: every dashboard-server.mjs route computes coaching
// (dashboardCoachingPayload) and reads the persisted label store, both
// unconditionally, regardless of what this file actually asserts on — the
// same hazard tests/dashboard.test.cjs and dashboard-usage-telemetry.test.mjs
// already guard against. This file's own suites only touch /api/status
// today (latent, per the review), but wrapping startDashboard here too means
// no future call site — or a future route that also folds in coaching — can
// reintroduce a real-~/.config leak into this file by omission.
const NULL_COACHING_LEDGER = { loadLedger: () => ({ version: 1, records: [] }), ledgerPath: '/dev/null/unused' };
const NULL_LABEL_STORE = {
  loadLabelStore: () => ({ version: 1, labels: {}, cards: {} }), labelStorePath: '/dev/null/unused',
};
function startDashboard(opts = {}) {
  return realStartDashboard({ coachingLedger: NULL_COACHING_LEDGER, labelStore: NULL_LABEL_STORE, ...opts });
}

function writeFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
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

/** A bounded poll, not an arbitrary sleep — same house convention
 *  tests/dashboard.test.cjs already uses for SSE disconnect-cleanup
 *  assertions (e.g. `listeners.size === 0`). Deterministic outcome: passes
 *  reliably once the async condition becomes true, fails only if it never
 *  does within the window. */
function eventually(predicate, message, timeout = 1500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeout) return reject(new Error(message));
      setTimeout(check, 10);
    };
    check();
  });
}

/** Open a real SSE connection to /api/live/intelligence?project=<key>,
 *  mirroring tests/dashboard.test.cjs's own openSse helper for
 *  /api/live/events — same house convention, applied to the new pool route.
 *  `close()` destroys the client socket, the same real-disconnect signal
 *  dashboard-server.mjs's req/res 'close' handlers key their pool teardown
 *  off of. */
function openIntelSse(port, { project, token }) {
  let req;
  const opened = new Promise((resolve, reject) => {
    req = http.request({
      host: '127.0.0.1', port, method: 'GET',
      path: `/api/live/intelligence?project=${encodeURIComponent(project)}`,
      headers: { accept: 'text/event-stream', 'x-dash-token': token },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', () => {});
      resolve(res);
    });
    req.on('error', reject);
    req.end();
  });
  return { opened, close: () => req.destroy() };
}

/** A fixture "discovered project" — a plain directory with a .claude-flow
 *  tree, shaped exactly like discoverRuvfloProjects()'s own row contract
 *  ({ path, label, source }), suitable for direct injection via
 *  startDashboard's `discoverProjects` option (bypassing the real
 *  machine-wide scan entirely, same as project-discovery.test.mjs's own
 *  registryWorkspaces overrides do for that module). */
function fixtureProject(root, name, {
  lastAdaptation, patternsLearned, storeEntries, trajectoriesRecorded = 0,
}) {
  const dir = path.join(root, name);
  writeFile(path.join(dir, '.claude-flow', 'neural', 'stats.json'), {
    patternsLearned, trajectoriesRecorded, signalsProcessed: 0, lastAdaptation,
  });
  writeFile(path.join(dir, '.claude-flow', 'neural', 'patterns.json'), Array.from(
    { length: storeEntries }, (_, i) => ({ id: `${name}-${i}`, type: 'action', createdAt: i + 1 }),
  ));
  writeFile(path.join(dir, '.claude-flow', 'data', 'intelligence-snapshot.json'), [
    { timestamp: 1, nodes: storeEntries, edges: storeEntries * 2, pageRankSum: 0.1 },
  ]);
  writeFile(path.join(dir, '.claude-flow', 'health-history.json'), [{ ts: 1, ok: true }]);
  return { path: dir, label: name, source: 'registry' };
}

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ak-dash-intel-'));

// ── default selection (no ?project=) ────────────────────────────────────

test('GET /api/status with no ?project= defaults to the first discovered project (discoverRuvfloProjects\' own most-recently-active-first sort)', async () => {
  const root = tempRoot();
  const alpha = fixtureProject(root, 'alpha', { lastAdaptation: 5000, patternsLearned: 10, storeEntries: 2 });
  const beta = fixtureProject(root, 'beta', { lastAdaptation: 100, patternsLearned: 20, storeEntries: 1 });

  const { url, close, token } = await startDashboard({
    port: 0, cwd: root, fetchStatus: async () => STUB_STATUS,
    // discoverProjects' own contract (matching the real module's) is that
    // its result is ALREADY sorted most-recently-active first — alpha here.
    discoverProjects: () => [alpha, beta],
  });
  try {
    const r = await get(`${url}api/status`, token);
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const body = JSON.parse(r.body);

    const alphaKey = resolveProjectIdentity(alpha.path).key;
    assert.equal(body.intel.selectedProjectKey, alphaKey);
    assert.equal(body.intel.selectedProjectLabel, 'alpha');
    assert.equal(body.intel.globalStats.patternsLearned, 10);
    assert.equal(body.intel.patternStore.length, 2);
    // The full catalog is always present, most-recently-active first,
    // independent of which one is selected.
    assert.deepEqual(body.intel.projects.map((p) => p.label), ['alpha', 'beta']);
  } finally {
    await close();
  }
});

// ── explicit selection ───────────────────────────────────────────────────

test('GET /api/status?project=<key> scopes the detail series to that specific fixture project', async () => {
  const root = tempRoot();
  const alpha = fixtureProject(root, 'alpha', { lastAdaptation: 5000, patternsLearned: 10, storeEntries: 2 });
  const beta = fixtureProject(root, 'beta', { lastAdaptation: 100, patternsLearned: 20, storeEntries: 1 });

  const { url, close, token } = await startDashboard({
    port: 0, cwd: root, fetchStatus: async () => STUB_STATUS,
    discoverProjects: () => [alpha, beta],
  });
  try {
    const betaKey = resolveProjectIdentity(beta.path).key;
    const r = await get(`${url}api/status?project=${betaKey}`, token);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);

    assert.equal(body.intel.selectedProjectKey, betaKey);
    assert.equal(body.intel.selectedProjectLabel, 'beta');
    assert.equal(body.intel.globalStats.patternsLearned, 20);
    assert.equal(body.intel.patternStore.length, 1);
    // machineWide is ALWAYS the full rollup, independent of selection.
    assert.equal(body.intel.machineWide.totals.projectCount, 2);
  } finally {
    await close();
  }
});

// ── unresolvable key falls back to the documented default ──────────────

test('GET /api/status?project=<unresolvable key> falls back to the exact same default as no ?project= at all', async () => {
  const root = tempRoot();
  const alpha = fixtureProject(root, 'alpha', { lastAdaptation: 5000, patternsLearned: 10, storeEntries: 2 });
  const beta = fixtureProject(root, 'beta', { lastAdaptation: 100, patternsLearned: 20, storeEntries: 1 });

  const { url, close, token } = await startDashboard({
    port: 0, cwd: root, fetchStatus: async () => STUB_STATUS,
    discoverProjects: () => [alpha, beta],
  });
  try {
    const [noParam, bogusKey] = await Promise.all([
      get(`${url}api/status`, token),
      // A well-formed `project:<16-hex>` shape (passes safeProjectKey's own
      // round-trip shape check in validProjectKeyParam) that matches no
      // discovered project's real key.
      get(`${url}api/status?project=project:deadbeefdeadbeef`, token),
    ]);
    assert.equal(noParam.status, 200);
    assert.equal(bogusKey.status, 200);
    const a = JSON.parse(noParam.body);
    const b = JSON.parse(bogusKey.body);

    assert.equal(a.intel.selectedProjectKey, b.intel.selectedProjectKey);
    assert.equal(a.intel.selectedProjectLabel, 'alpha');
    assert.equal(b.intel.selectedProjectLabel, 'alpha');
  } finally {
    await close();
  }
});

// ── machine-wide aggregate ───────────────────────────────────────────────

test('intel.machineWide sums correctly across multiple fixture projects, keeping the lifetime-counter and store-entries sums distinct', async () => {
  const root = tempRoot();
  const alpha = fixtureProject(root, 'alpha', {
    lastAdaptation: 1000, patternsLearned: 500, storeEntries: 2, trajectoriesRecorded: 4,
  });
  const beta = fixtureProject(root, 'beta', {
    lastAdaptation: 2000, patternsLearned: 300, storeEntries: 1, trajectoriesRecorded: 6,
  });

  const { url, close, token } = await startDashboard({
    port: 0, cwd: root, fetchStatus: async () => STUB_STATUS,
    // Order deliberately not "most-recently-active first" here — machineWide
    // must sum correctly regardless of catalog order.
    discoverProjects: () => [beta, alpha],
  });
  try {
    const r = await get(`${url}api/status`, token);
    const body = JSON.parse(r.body);

    // Cross-checked against the same reader intel-history.test.mjs exercises
    // directly — the seam under test here is collectData()'s wiring/caching,
    // not readMachineWideIntel's own arithmetic.
    assert.deepEqual(body.intel.machineWide, readMachineWideIntel([beta, alpha]));

    assert.equal(body.intel.machineWide.totals.patternsLearnedLifetime, 800); // 500 + 300
    assert.equal(body.intel.machineWide.totals.patternStoreEntries, 3); // 2 + 1 entries on disk
    assert.notEqual(
      body.intel.machineWide.totals.patternsLearnedLifetime,
      body.intel.machineWide.totals.patternStoreEntries,
      'the lifetime counter and the on-disk store-entry count must never be conflated',
    );
    assert.equal(body.intel.machineWide.totals.trajectoriesRecorded, 10); // 4 + 6
    assert.equal(body.intel.machineWide.totals.projectCount, 2);
    assert.equal(body.intel.machineWide.totals.mostActiveProject, 'beta'); // higher lastAdaptation
  } finally {
    await close();
  }
});

// ── /api/live/intelligence pool ──────────────────────────────────────────
//
// create-on-subscribe and teardown-on-last-disconnect are both real,
// deterministic behaviors driven by socket 'close' events on a real HTTP
// server (there is no injectable clock/timer in this code path — unlike
// IntelligenceWatch's own debounce, which intelligence-watch.test.mjs
// already covers with a fake clock). `eventually()`'s bounded poll is the
// SAME convention tests/dashboard.test.cjs already uses for the equivalent
// /api/live/events disconnect-cleanup assertions (e.g. `listeners.size ===
// 0`), so this is not a novel or flaky pattern for this codebase.
//
// NOT separately asserted here: that a project's watcher survives a
// disconnect that ISN'T the last one for that project (e.g. one of two
// clients on the same project closing). Proving that specific absence
// deterministically would require either an injectable clock this code path
// doesn't have, or an arbitrary real-time grace window whose only job is to
// rule out a call that — if the implementation were buggy — would already
// have happened; that trade a real flakiness risk for a property this suite
// doesn't strictly need to assert. If that edge specifically needs
// verification: open two browser tabs against the same project, confirm
// both still receive SSE frames after closing one tab (Network tab, EventSource
// connection open), then close the last tab and confirm the connection this
// server made to that project's watcher stops (e.g. via a temporary console.log
// in createIntelPoolEntry's `stop`, or by observing the fake `intelWatch`
// hook's call count in a manual REPL session).
test('the /api/live/intelligence pool creates exactly one watcher per distinct project, reuses it across multiple clients, and stops each project\'s watcher independently once its own last client disconnects', async () => {
  const root = tempRoot();
  const alpha = fixtureProject(root, 'alpha', { lastAdaptation: 100, patternsLearned: 1, storeEntries: 0 });
  const beta = fixtureProject(root, 'beta', { lastAdaptation: 200, patternsLearned: 1, storeEntries: 0 });
  const alphaKey = resolveProjectIdentity(alpha.path).key;
  const betaKey = resolveProjectIdentity(beta.path).key;

  const watchCalls = [];
  const stopCalls = [];
  const fakeIntelWatch = (projectPath) => {
    watchCalls.push(projectPath);
    return { start: async () => {}, stop: async () => { stopCalls.push(projectPath); } };
  };

  const { port, close, token } = await startDashboard({
    port: 0, cwd: root, fetchStatus: async () => STUB_STATUS,
    discoverProjects: () => [beta, alpha],
    intelWatch: fakeIntelWatch,
  });
  try {
    const a1 = openIntelSse(port, { project: alphaKey, token });
    await a1.opened;
    // getWatch() is awaited before the response headers are sent, so this is
    // a deterministic checkpoint, not a race: exactly one watcher for alpha.
    assert.deepEqual(watchCalls, [alpha.path], 'first client on alpha creates exactly one watcher');

    const a2 = openIntelSse(port, { project: alphaKey, token });
    await a2.opened;
    assert.deepEqual(watchCalls, [alpha.path],
      'a second client on the SAME project must reuse the memoized watcher, not create a second one');

    const b1 = openIntelSse(port, { project: betaKey, token });
    await b1.opened;
    assert.deepEqual(watchCalls, [alpha.path, beta.path], 'a client on a DIFFERENT project gets its own watcher');

    // Close every alpha client. beta's client (b1) is left untouched.
    a1.close();
    a2.close();
    await eventually(() => stopCalls.includes(alpha.path), 'alpha watcher was never stopped after its last client disconnected');
    assert.equal(stopCalls.filter((p) => p === alpha.path).length, 1, 'alpha must be stopped exactly once, not once per client');
    // Deterministic (not timing-dependent): nothing above ever touched b1,
    // so beta's watcher cannot have been affected by alpha's teardown.
    assert.equal(stopCalls.includes(beta.path), false, 'closing alpha\'s clients must not affect beta\'s independent watcher');

    b1.close();
    await eventually(() => stopCalls.includes(beta.path), 'beta watcher was never stopped after its last client disconnected');
    assert.deepEqual(stopCalls.sort(), [alpha.path, beta.path].sort(), 'each distinct project\'s watcher is stopped exactly once');
  } finally {
    await close();
  }
});
