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

// Raw-path GET: `http.get(url)` runs the string through WHATWG URL parsing, which
// COLLAPSES `..` segments client-side — so a traversal test written with get()
// would never put the hostile path on the wire. This puts the bytes through
// verbatim, which is what a real attacker's client does.
function getRaw(port, rawPath) {
  return new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject).end();
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
  // null/absent, never a crash. `drift: []` is REQUIRED to keep this suite
  // network-free: without it collectData takes the self-computed path
  // (driftReport's npm views + the brain fold-in's GitHub fetch), and the
  // fetch's undici keep-alive handle trips libuv's
  // `!(handle->flags & UV_HANDLE_CLOSING)` assert (win/async.c:94) at process
  // exit on Windows CI — every test passed, then the exit code was 1.
  const bare = mkFixture({});
  const srv2 = await startDashboard({ port: 0, cwd: bare, fetchStatus: async () => ({ overall: 'ok', rows: [], drift: [] }) });
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

  // ══════════════════════════════════════════════════════════════════════════
  // Usage tab (ADR-0009 / spec §6): three routes, a path-traversal guard, the
  // sixth segment, and the panel-wide poll control.
  //
  // usage-index.mjs is INJECTED the same way fetchStatus is — the routes must be
  // testable without a 1.3 GB transcript corpus on disk, and the traversal tests
  // need a spy that PROVES no file read was attempted.
  // ══════════════════════════════════════════════════════════════════════════
  const { parseSessionId, resolvesInsideRoot, maskTurns } = await import('file://' + MOD);

  // ── the guard, as pure functions (no server, no I/O) ──
  await test('parseSessionId accepts a plain session id and decodes percent-encoding', async () => {
    assert(parseSessionId('fc8c05e0-c311-456e-a226-6dac4279199b') === 'fc8c05e0-c311-456e-a226-6dac4279199b',
      'a uuid-shaped id must pass');
    assert(parseSessionId('rollout-2026-07-25T10_00_00.jsonl') === 'rollout-2026-07-25T10_00_00.jsonl',
      'dots, dashes and underscores are legal');
    assert(parseSessionId('%66oo') === 'foo', 'percent-encoding is decoded BEFORE validation, never after');
  });

  await test('parseSessionId rejects traversal, separators, absolutes, over-long and empty ids', async () => {
    const bad = [
      '../../etc/passwd', '..%2f..%2fetc%2fpasswd', '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '..', '.', '/etc/passwd', '%2Fetc%2Fpasswd', 'C:%5CWindows%5Csystem32',
      'a/b', 'a\\b', '', 'x'.repeat(129), 'has space', 'semi;colon', '%ZZ',
    ];
    for (const b of bad) {
      assert(parseSessionId(b) === null, 'must reject ' + JSON.stringify(b) + ', got ' + JSON.stringify(parseSessionId(b)));
    }
    assert(parseSessionId('x'.repeat(128)) !== null, '128 chars is the inclusive upper bound');
  });

  await test('resolvesInsideRoot keeps an id pinned to its transcript root', async () => {
    const root = path.join(os.tmpdir(), 'ak-usage-root');
    assert(resolvesInsideRoot(root, 'abc.jsonl') === true, 'a plain id resolves inside the root');
    assert(resolvesInsideRoot(root, '../abc') === false, 'a parent hop escapes the root');
    assert(resolvesInsideRoot(root, path.join('sub', 'abc')) === false, 'a nested path is not a bare id');
    assert(resolvesInsideRoot(root, path.resolve(path.sep, 'etc', 'passwd')) === false, 'an absolute path escapes the root');
  });

  await test('maskTurns runs every turn body through the masker (and fails closed without one)', async () => {
    const turns = [{ role: 'user', text: 'key sk-live-AAAABBBBCCCC here' }, { role: 'assistant', text: 'ok' }];
    const out = maskTurns(turns, (s) => s.replace(/sk-[A-Za-z0-9-]+/g, 'sk-••••'));
    assert(!JSON.stringify(out).includes('sk-live-AAAABBBBCCCC'), 'the secret must not survive masking');
    assert(out[1].text === 'ok', 'ordinary prose passes through untouched');
    assert(turns[0].text.includes('sk-live-AAAABBBBCCCC'), 'masking must not mutate the caller input');
    let threw = false;
    try { maskTurns(turns, null); } catch { threw = true; }
    assert(threw, 'no masker → throw (fail closed); silently skipping masking is the bug this guards');
  });

  await test('maskTurns preserves the non-string attribution fields (kind, prompt)', async () => {
    // The transcript renderer labels turns from tn.kind / tn.prompt, so the
    // masking gate must pass those through untouched — it rewrites strings
    // only. If this ever fails, every tool result renders as "you" again.
    const turns = [
      { role: 'user', text: '[tool result] ok', prompt: false, kind: 'tool-result' },
      { role: 'user', text: 'do the thing', prompt: true, kind: 'prompt' },
    ];
    const out = maskTurns(turns, (s) => s);
    assert(out[0].kind === 'tool-result' && out[0].prompt === false, 'tool-result attribution survives masking');
    assert(out[1].kind === 'prompt' && out[1].prompt === true, 'prompt attribution survives masking');
  });

  // ── the routes, over real HTTP, with a spying usage module ──
  const AGG = {
    generatedAt: '2026-07-25T00:00:00.000Z', windowDays: 14, pricesAsOf: '2026-07-01',
    totals: { sessions: 2, responses: 9, input: 100, output: 200, cacheRead: 900, cacheWrite: 50, tokens: 1250, cost: 12.5, spanMinutes: 90, engagedSeconds: 3600 },
    byDay: { '2026-07-24': { tokens: 1000, cost: 10, sessions: 1 } },
    byModel: { 'claude-opus-5': { cost: 12.5, tokens: 1250, responses: 9 } },
    byProvider: { claude: { cost: 12.5, sessions: 2 } },
    byProject: { demo: { cost: 12.5, sessions: 2 } },
    byCategory: { 'Security review': { cost: 12.5, sessions: 2, confidence: 0.8 } },
    punchcard: { '0-13': 4 },
    // rows MUST be populated and MUST exceed USAGE_TREE_PREVIEW (25): with
    // `rows: []` the payload-trim assertion was vacuous — it passed whether or
    // not the route trimmed anything, which is how the "sessions are stripped"
    // claim survived while projectTree shipped every session by reference.
    projectTree: [{
      project: 'demo', sessions: 40, cost: 12.5, tokens: 1250, minutes: 90,
      categories: [{ category: 'Security review', sessions: 2, cost: 12.5 }],
      rows: Array.from({ length: 40 }, (_, i) => ({
        id: `row-${i}`, provider: 'claude', title: `session ${i}`, project: 'demo',
        category: 'Security review', cost: 0.25, minutes: 2, tokens: 100,
      })),
    }],
    sessions: [
      { id: 'aaa', provider: 'claude', title: 'one', project: 'demo', category: 'Security review', cost: 10 },
      { id: 'bbb', provider: 'codex', title: 'two', project: 'other', category: 'Refactor', cost: 2.5 },
    ],
    insights: [{ id: 'context-tax', kind: 'coach', severity: 'warn', title: 't', finding: 'f', evidence: 'e', action: 'a', command: null, impact: 3.5 }],
  };

  function spyUsage(over = {}) {
    const calls = { readIndex: [], readSession: [] };
    return {
      calls,
      api: {
        readIndex: async (opts) => { calls.readIndex.push(opts); return JSON.parse(JSON.stringify(AGG)); },
        readSession: async (id) => {
          calls.readSession.push(id);
          return { meta: { id, title: 'one', project: 'demo' }, turns: [{ role: 'user', text: 'token sk-live-DEADBEEF01234 pasted' }] };
        },
        maskSecrets: (s) => String(s).replace(/sk-[A-Za-z0-9-]+/g, 'sk-***'),
        ...over,
      },
    };
  }

  const spy = spyUsage();
  const usageSrv = await startDashboard({
    port: 0, cwd: fixture, fetchStatus: async () => STUB_STATUS, usage: spy.api,
  });
  try {
    await test('GET /api/usage?days=N → Aggregate rollups WITHOUT sessions[]', async () => {
      const r = await get(usageSrv.url + 'api/usage?days=7');
      assert(r.status === 200, 'expected 200, got ' + r.status);
      contains(r.headers['content-type'] || '', 'application/json');
      const j = JSON.parse(r.body);
      assert(!('sessions' in j), 'sessions[] must be stripped — that is what /api/sessions is for');
      assert(j.totals && j.totals.cost === 12.5, 'totals must survive');
      assert(j.projectTree && j.projectTree.length === 1, 'projectTree must survive');
      assert(Array.isArray(j.insights) && j.insights.length === 1, 'insights must survive');
      assert(spy.calls.readIndex.some((o) => o && o.days === 7), 'days must reach readIndex, got ' + JSON.stringify(spy.calls.readIndex));
    });

    await test('GET /api/sessions → { sessions }, filtered by project/category and paginated', async () => {
      const all = JSON.parse((await get(usageSrv.url + 'api/sessions?days=14')).body);
      assert(Array.isArray(all.sessions) && all.sessions.length === 2, 'both sessions with no filter');
      assert(all.total === 2, 'total must report the pre-pagination count, got ' + all.total);

      const byProject = JSON.parse((await get(usageSrv.url + 'api/sessions?project=demo')).body);
      assert(byProject.sessions.length === 1 && byProject.sessions[0].id === 'aaa', 'project filter must apply');

      const byCat = JSON.parse((await get(usageSrv.url + 'api/sessions?category=Refactor')).body);
      assert(byCat.sessions.length === 1 && byCat.sessions[0].id === 'bbb', 'category filter must apply');

      const paged = JSON.parse((await get(usageSrv.url + 'api/sessions?limit=1&offset=1')).body);
      assert(paged.sessions.length === 1 && paged.sessions[0].id === 'bbb', 'limit/offset must page');
      assert(paged.total === 2, 'total stays the unpaged count');
    });

    await test('GET /api/session/:id → { meta, turns } with secrets masked SERVER-side', async () => {
      const r = await get(usageSrv.url + 'api/session/aaa');
      assert(r.status === 200, 'expected 200, got ' + r.status);
      const j = JSON.parse(r.body);
      assert(j.meta && j.meta.id === 'aaa', 'meta must carry the session');
      assert(Array.isArray(j.turns) && j.turns.length === 1, 'turns must be an array');
      assert(!r.body.includes('sk-live-DEADBEEF01234'), 'the raw secret must never reach the wire');
      contains(r.body, 'sk-***');
      assert(spy.calls.readSession.length === 1 && spy.calls.readSession[0] === 'aaa', 'readSession gets the bare id');
    });

    // ── THE traversal guard: 400, and PROVABLY no file read ──
    await test('GET /api/session/:id traversal → 400 and readSession is never reached', async () => {
      const before = spy.calls.readSession.length;
      const hostile = [
        '/api/session/../../etc/passwd',
        '/api/session/..%2f..%2fetc%2fpasswd',
        '/api/session/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
        '/api/session/%2Fetc%2Fpasswd',
        '/api/session/' + encodeURIComponent(path.resolve(path.sep, 'etc', 'passwd')),
        '/api/session/' + 'x'.repeat(129),
        '/api/session/',
        '/api/session/..',
      ];
      for (const p of hostile) {
        const r = await getRaw(usageSrv.port, p);
        assert(r.status === 400, 'expected 400 for ' + p + ', got ' + r.status);
        assert(!/root:|passwd/i.test(r.body), 'a rejected request must not echo file content: ' + p);
      }
      assert(spy.calls.readSession.length === before,
        'readSession must NOT be called for any hostile id — got ' + (spy.calls.readSession.length - before) + ' call(s)');
    });
  } finally {
    await usageSrv.close();
  }

  // Masking is not optional: a usage module that cannot mask must fail the
  // request, never serve an unmasked transcript.
  const noMask = spyUsage({ maskSecrets: undefined });
  const srv3 = await startDashboard({ port: 0, cwd: fixture, fetchStatus: async () => STUB_STATUS, usage: noMask.api });
  try {
    await test('/api/session/:id fails CLOSED when the masker is unavailable', async () => {
      const r = await get(srv3.url + 'api/session/aaa');
      assert(r.status === 500, 'expected 500, got ' + r.status);
      assert(!r.body.includes('sk-live-DEADBEEF01234'), 'no unmasked transcript may leak on the error path');
    });
  } finally {
    await srv3.close();
  }

  // ── the served page: sixth segment, four views, poll control ──
  const uiSrv = await startDashboard({ port: 0, cwd: fixture, fetchStatus: async () => STUB_STATUS, usage: spyUsage().api });
  try {
    await test('served HTML carries the sixth "Usage" segment and its four sub-views', async () => {
      const r = await get(uiSrv.url);
      contains(r.body, 'data-tab="usage"');
      contains(r.body, '>Usage<');
      contains(r.body, 'id="panel-usage"');
      for (const v of ['score', 'findings', 'sessions', 'transcript']) {
        contains(r.body, 'id="v-' + v + '"');
        contains(r.body, 'data-view="' + v + '"');
      }
    });

    await test('transcript labels attribute by kind — a tool result never renders as "you"', async () => {
      // The Messages API records tool results under role "user"; the renderer
      // must label from tn.kind, and the page must carry the pieces that do it:
      // the kind branch, the "tool result" label, the t-tool styling, and the
      // hover title telling the reader the harness — not the person — sent it.
      const r = await get(uiSrv.url);
      contains(r.body, 'tn.kind');
      contains(r.body, '"tool result"');
      contains(r.body, 'kind==="context"');
      contains(r.body, '.t-tool .t-who');
      contains(r.body, 'not typed by you');
      assert(!/esc\(user\?"you"/.test(r.body), 'the old role-only "you" label must be gone');
    });

    await test('poll control: default 30s, ten intervals, persisted as ak-dash-poll', async () => {
      const r = await get(uiSrv.url);
      contains(r.body, 'ak-dash-poll');
      contains(r.body, 'POLL_DEFAULT_MS=30000');
      assert(!/setInterval\(\s*poll\s*,\s*5000\s*\)/.test(r.body), 'the hardcoded 5s poll must be gone');
      for (const ms of [15000, 30000, 60000, 300000, 900000, 1800000, 3600000, 21600000, 43200000, 86400000]) {
        contains(r.body, 'data-ms="' + ms + '"');
      }
      contains(r.body, 'POLL_COOLDOWN_MS=3000');
    });

    await test('every refresh path is single-flight + cooldown guarded', async () => {
      const r = await get(uiSrv.url);
      const fn = r.body.slice(r.body.indexOf('function refreshAll('));
      const body = fn.slice(0, fn.indexOf('\n  function '));
      assert(/inflight/.test(body), 'refreshAll must consult the single-flight flag');
      assert(/POLL_COOLDOWN_MS/.test(body), 'refreshAll must consult the cooldown');
      assert(/setInterval\(refreshAll/.test(r.body), 'the automatic poll must go through the SAME guarded path');
    });

    await test('the Usage tab is lazy — the shared status poll never fetches /api/usage', async () => {
      const r = await get(uiSrv.url);
      const fn = r.body.slice(r.body.indexOf('function pollStatus('));
      const body = fn.slice(0, fn.indexOf('\n  function '));
      assert(body.includes('/api/status'), 'pollStatus must fetch the status endpoint');
      assert(!body.includes('/api/usage'), 'pollStatus must NOT fetch usage — that is lazy on tab activation');
      assert(!body.includes('/api/sessions'), 'pollStatus must NOT fetch sessions');
      contains(r.body, 'usageLoaded');
    });

    // qe-sec finding Q1: every well-formed-but-unknown id returned 200 with a
    // null body, which read as "an empty session exists" and was a mild
    // existence oracle. Uses its own server whose readSession genuinely returns
    // null — asserting this against the shared spy would only test the spy.
    await test('an unknown but well-formed session id is 404, not 200-with-null', async () => {
      const srv = await startDashboard({
        port: 0,
        fetchStatus: async () => ({ overall: 'ok', rows: [] }),
        usage: { readSession: async () => null, maskSecrets: (t) => String(t) },
      });
      try {
        for (const id of ['zzz-does-not-exist', '...']) {
          const r = await getRaw(srv.port, `/api/session/${id}`);
          assert(r.status === 404, `${id} must be 404, got ${r.status}`);
          assert(!r.body.includes('"turns"'), 'a 404 must not carry a turns array');
        }
        // A malformed id stays 400 — "missing" and "malformed" must not collapse
        // into one status, or the guard becomes unobservable.
        const bad = await getRaw(srv.port, '/api/session/..');
        assert(bad.status === 400, `a dot-segment id is malformed (400), got ${bad.status}`);
      } finally { await srv.close(); }
    });

    // The payload trim must actually trim. projectTree[].rows holds the same
    // objects as sessions[], so dropping only the top-level array left the whole
    // session list in the response.
    await test('/api/usage trims projectTree rows to the preview cap', async () => {
      const r = await get(`${uiSrv.url}api/usage?days=14`);
      const j = JSON.parse(r.body);
      assert(j.sessions === undefined, 'top-level sessions[] must be gone');
      const node = j.projectTree[0];
      assert(node.rows.length === 25, `expected 25 preview rows, got ${node.rows.length}`);
      assert(node.rowsTotal === 40, 'rowsTotal must preserve the true count for "load all"');
      assert(node.sessions === 40, 'the aggregate count is untouched');
    });

    // qe-sec finding F: the Host guard stops a hostile page READING the response,
    // but a drive-by GET still EXECUTES the handler — and /api/usage triggers a
    // full-corpus scan plus a cache rewrite. Fetch-metadata closes the drive-by
    // case while leaving curl (which sends no Sec-Fetch-Site) working.
    await test('a cross-site GET is refused before it can trigger a scan', async () => {
      const hdr = (h) => new Promise((resolve, reject) => {
        require('node:http').request(
          { host: '127.0.0.1', port: uiSrv.port, path: '/api/usage?days=365', method: 'GET', headers: h },
          (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b })); },
        ).on('error', reject).end();
      });
      assert((await hdr({ 'sec-fetch-site': 'cross-site' })).status === 403, 'cross-site must be 403');
      assert((await hdr({ 'sec-fetch-site': 'same-site' })).status === 403, 'same-site is still another origin');
      assert((await hdr({ origin: 'https://evil.example' })).status === 403, 'a foreign Origin must be 403');
      // Our own page and non-browser clients must keep working.
      assert((await hdr({ 'sec-fetch-site': 'same-origin' })).status === 200, 'our own page must pass');
      assert((await hdr({ 'sec-fetch-site': 'none' })).status === 200, 'direct navigation must pass');
      assert((await hdr({})).status === 200, 'curl sends no fetch-metadata and must keep working');
    });

    // qe-sec finding C: maskTurns was the gate, but `meta` was forwarded around
    // it. meta.title only looked safe because usage-index masks it at parse
    // time; project/skill/plugin were never masked on any path.
    await test('meta is masked server-side, not just turns', async () => {
      // Split so no scannable literal enters the diff (see usage-index.test.mjs).
      const leak = 'gh' + 'p_' + 'A'.repeat(36);
      const srv = await startDashboard({
        port: 0,
        fetchStatus: async () => ({ overall: 'ok', rows: [] }),
        usage: {
          readSession: async () => ({
            meta: { title: `t ${leak}`, project: `p ${leak}`, skill: `s ${leak}` },
            turns: [{ role: 'user', text: 'hello' }],
          }),
          maskSecrets: (t) => String(t).replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_…redacted'),
        },
      });
      try {
        const r = await get(`${srv.url}api/session/abc123`);
        assert(!r.body.includes(leak), 'no meta field may carry an unmasked secret');
        assert(r.body.includes('redacted'), 'the masker must actually have run over meta');
      } finally { await srv.close(); }
    });

    // Cross-module shape contract. usage-index emits projectTree[].categories as
    // a cost-ranked ARRAY of {category, sessions, cost}; an earlier build of the
    // renderer assumed a keyed map, so Object.keys() returned ["0","1","2"] and the
    // chips rendered "0 [object Object]". Neither side's own tests caught it —
    // each was internally consistent. This pins the contract at the seam.
    await test('project chips render the ARRAY category shape, not a keyed map', async () => {
      const r = await get(uiSrv.url);
      const fn = r.body.slice(r.body.indexOf('var cs=g.categories'));
      const body = fn.slice(0, 900);
      assert(/Array\.isArray\(cs\)/.test(body),
        'the renderer must branch on the array shape usage-index actually emits');
      assert(/\.category\b/.test(body) && /\.sessions\b/.test(body),
        'array branch must read .category/.sessions, not stringify the element');
      assert(!/^\s*var ck=Object\.keys\(cs\)/m.test(body.split('Array.isArray(cs)')[0]),
        'Object.keys must not be the primary path — that is the [object Object] bug');
    });

    await test('served page is still self-contained after the Usage tab lands', async () => {
      const r = await get(uiSrv.url);
      assert(!/https?:\/\/(?!127\.0\.0\.1)/.test(r.body.replace(/https?:\/\/[^"'\s]*w3\.org/g, '')),
        'page must not reference external http(s) hosts');
      assert(!/<script[^>]+src=/i.test(r.body), 'no external script src');
    });
  } finally {
    await uiSrv.close();
  }

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
