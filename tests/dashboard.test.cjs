#!/usr/bin/env node
//
// dashboard.test.cjs — unit tests for the read-only local web dashboard server
// (src/lib/dashboard-server.mjs). Zero-dep: boots the server on an ephemeral
// port over a fixture project dir, exercises both routes over real HTTP, and
// asserts the shapes the browser client depends on.
//
// The status collector is INJECTED (fetchStatus) so the test never shells out
// to the global `ak status --json` (which would hit the network via driftReport
// and make this flaky). The server still reads improvement.json / the health
// ring off the fixture itself — that path is exercised for real.
//
// Run: node tests/dashboard.test.cjs   (exit 0 = pass, 1 = fail)

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const MOD = path.join(ROOT, 'src', 'lib', 'dashboard-server.mjs');

// ── tiny harness ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('  \x1b[32m✓\x1b[0m ' + name); passed++; })
    .catch((e) => { console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + (e && e.message)); failed++; });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function contains(hay, needle) {
  assert(String(hay).includes(needle), `expected output to contain ${JSON.stringify(needle)}`);
}

function mkFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-'));
  for (const [rel, data] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, typeof data === 'string' ? data : JSON.stringify(data));
  }
  return dir;
}

// GET helper → { status, headers, body }
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

async function main() {
  const { startDashboard } = await import('file://' + MOD);

  const STUB_STATUS = {
    overall: 'warn',
    rows: [
      { subsystem: 'versions', level: 'ok', message: 'ruflo 4.0.0 (latest)', fix: null },
      { subsystem: 'natives', level: 'fail', message: 'WASM fallback', fix: 'sync installs native better-sqlite3' },
      { subsystem: 'learning', level: 'warn', message: 'no patterns yet', fix: null },
    ],
    drift: [{ pkg: 'ruflo', installed: '4.0.0', latest: '4.0.0', outdated: false }],
  };

  const fixture = mkFixture({
    '.claude-flow/improvement.json': { verdict: 'PASS', deltaPP: 33, ci95: 5, pValue: 0.001, cohensD: 1.2, ts: 1700000000 },
    '.claude-flow/health-history.json': [
      { ts: 1700000000, patternsLearned: 10, deltaPP: 5 },
      { ts: 1700000600, patternsLearned: 22, deltaPP: 18 },
      { ts: 1700001200, patternsLearned: 40, deltaPP: 33 },
    ],
  });

  const { url, close } = await startDashboard({
    port: 0,
    cwd: fixture,
    fetchStatus: async () => STUB_STATUS,
  });

  try {
    assert(/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url), 'url must be a 127.0.0.1 loopback URL, got ' + url);

    await test('GET / → 200 text/html with the header band', async () => {
      const r = await get(url);
      assert(r.status === 200, 'expected 200, got ' + r.status);
      contains(r.headers['content-type'] || '', 'text/html');
      contains(r.body, 'agentic-kit');          // kit name in the header band
      contains(r.body, 'class="band"');          // the header band itself
      contains(r.body, '/api/status');           // client polls the JSON endpoint
    });

    await test('GET / is self-contained — no external fetches', async () => {
      const r = await get(url);
      assert(!/https?:\/\/(?!127\.0\.0\.1)/.test(r.body.replace(/https?:\/\/[^"'\s]*w3\.org/g, '')),
        'page must not reference external http(s) hosts');
      assert(!/<link[^>]+stylesheet/i.test(r.body), 'no external stylesheet links');
      assert(!/<script[^>]+src=/i.test(r.body), 'no external script src');
    });

    await test('GET /api/status → 200 valid JSON with rows + overall', async () => {
      const r = await get(url + 'api/status');
      assert(r.status === 200, 'expected 200, got ' + r.status);
      contains(r.headers['content-type'] || '', 'application/json');
      const j = JSON.parse(r.body);
      assert(Array.isArray(j.rows), 'rows must be an array');
      assert(j.overall === 'warn', 'overall must pass through, got ' + j.overall);
      assert(j.rows.length === 3, 'expected 3 rows, got ' + j.rows.length);
    });

    await test('GET /api/status embeds improvement.json read off the fixture', async () => {
      const r = await get(url + 'api/status');
      const j = JSON.parse(r.body);
      assert(j.improvement && j.improvement.verdict === 'PASS', 'improvement.json must be embedded');
      assert(j.improvement.deltaPP === 33, 'improvement fields must survive');
    });

    await test('GET /api/status embeds the health-history ring', async () => {
      const r = await get(url + 'api/status');
      const j = JSON.parse(r.body);
      assert(Array.isArray(j.health) && j.health.length === 3, 'health ring must be embedded as an array');
    });

    await test('unknown route → 404', async () => {
      const r = await get(url + 'nope');
      assert(r.status === 404, 'expected 404, got ' + r.status);
    });
  } finally {
    await close();
  }

  // A second fixture WITHOUT improvement.json / health ring: those keys must be
  // null/absent, never a crash.
  const bare = mkFixture({});
  const srv2 = await startDashboard({ port: 0, cwd: bare, fetchStatus: async () => ({ overall: 'ok', rows: [] }) });
  try {
    await test('missing improvement.json / health ring → null, no crash', async () => {
      const r = await get(srv2.url + 'api/status');
      const j = JSON.parse(r.body);
      assert(j.improvement === null, 'improvement must be null when absent');
      assert(j.health === null, 'health must be null when absent');
    });
  } finally {
    await srv2.close();
  }

  // ── foldBrainDrift: the brain joins the npm drift array (banner covers ALL managed tools) ──
  const { foldBrainDrift } = await import('file://' + MOD);
  const npmDrift = [{ pkg: 'ruflo', installed: '4.0.0', latest: '4.1.0', outdated: true }];

  await test('foldBrainDrift appends an outdated brain in renderDrift shape', async () => {
    const out = foldBrainDrift(npmDrift, { present: true, installedRelease: '3.3.1', latest: '3.4.0', outdated: true });
    assert(out.length === 2, 'brain entry must be appended');
    const b = out[1];
    assert(b.pkg === 'ruvnet-brain' && b.installed === '3.3.1' && b.latest === '3.4.0' && b.outdated === true,
      'entry must carry {pkg, installed, latest, outdated}: ' + JSON.stringify(b));
    assert(out[0] === npmDrift[0], 'npm entries pass through untouched');
  });

  await test('foldBrainDrift: absent brain → array unchanged; null drift → brain-only array', async () => {
    assert(foldBrainDrift(npmDrift, { present: false }) === npmDrift, 'absent brain must not add an entry');
    assert(foldBrainDrift(npmDrift, null) === npmDrift, 'null drift result must be a no-op');
    const solo = foldBrainDrift(null, { present: true, installedRelease: '3.3.1', latest: '3.3.1', outdated: false });
    assert(Array.isArray(solo) && solo.length === 1 && solo[0].outdated === false, 'null npm drift still yields the brain entry');
  });

  await test('foldBrainDrift labels a pre-stamping install honestly (unversioned, never fabricated)', async () => {
    const out = foldBrainDrift([], { present: true, installedRelease: null, latest: '3.4.0', outdated: true });
    assert(out[0].installed === '(unversioned)', 'no release known → "(unversioned)", got ' + out[0].installed);
  });

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
