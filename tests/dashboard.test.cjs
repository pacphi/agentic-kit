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

// GET helper → { status, headers, body }. `token`, when given, rides as the
// x-dash-token header every /api/* route now requires (ADR-0014); routes
// outside /api/ (the page itself, unknown paths) ignore it harmlessly.
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

// Raw-path GET: `http.get(url)` runs the string through WHATWG URL parsing, which
// COLLAPSES `..` segments client-side — so a traversal test written with get()
// would never put the hostile path on the wire. This puts the bytes through
// verbatim, which is what a real attacker's client does.
function getRaw(port, rawPath, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { 'x-dash-token': token } : {};
    http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject).end();
  });
}

function openSse(port, { headers = {}, onChunk = () => {}, path: route = '/api/live/events', token } = {}) {
  let req;
  const authHeaders = token ? { 'x-dash-token': token } : {};
  const opened = new Promise((resolve, reject) => {
    req = http.request({
      host: '127.0.0.1', port, path: route, method: 'GET',
      headers: { accept: 'text/event-stream', ...authHeaders, ...headers },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', onChunk);
      resolve(res);
    });
    req.on('error', reject);
    req.end();
  });
  return { opened, close: () => req.destroy() };
}

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

async function main() {
  const { startDashboard } = await import('file://' + MOD);

  const STUB_STATUS = {
    overall: 'warn',
    rows: [
      { subsystem: 'versions', level: 'ok', message: 'ruflo 4.0.0 (latest)', fix: null },
      { subsystem: 'natives', level: 'fail', message: 'WASM fallback', fix: 'sync installs native better-sqlite3' },
      { subsystem: 'learning', level: 'warn', message: 'no patterns yet', fix: null },
      { subsystem: 'opencode', level: 'warn', message: 'lifecycle plugin out of date', fix: 'sync rewrites it' },
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

  const { url, close, token, urlWithToken } = await startDashboard({
    port: 0,
    cwd: fixture,
    fetchStatus: async () => STUB_STATUS,
  });

  try {
    assert(/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url), 'url must be a 127.0.0.1 loopback URL, got ' + url);

    await test('ADR-0014: urlWithToken carries the token ONLY in the fragment', () => {
      assert(urlWithToken.includes('/#token='), 'token must ride in the # fragment');
      assert(!/\?token=/.test(urlWithToken), 'token must NOT be a query parameter on the launch URL');
      assert(urlWithToken.includes(token), 'urlWithToken carries the session token');
    });

    await test('GET / → 200 text/html with the header band (unauthenticated — the page itself is not gated)', async () => {
      const r = await get(url);
      assert(r.status === 200, 'expected 200, got ' + r.status);
      contains(r.headers['content-type'] || '', 'text/html');
      contains(r.body, 'agentic-kit');          // kit name in the header band
      contains(r.body, 'class="band"');          // the header band itself
      contains(r.body, '/api/status');           // client polls the JSON endpoint
      contains(r.body, 'id="dash-gate"');        // the token gate markup
    });

    await test('GET / is self-contained — no external fetches', async () => {
      const r = await get(url);
      assert(!/https?:\/\/(?!127\.0\.0\.1)/.test(r.body.replace(/https?:\/\/[^"'\s]*w3\.org/g, '')),
        'page must not reference external http(s) hosts');
      assert(!/<link[^>]+stylesheet/i.test(r.body), 'no external stylesheet links');
      assert(!/<script[^>]+src=/i.test(r.body), 'no external script src');
    });

    // Security review Finding 4: the dashboard — a larger inline-script
    // surface than admin, and the one that renders attacker-influenced
    // transcript text — had no CSP while admin did. Same header shape as
    // admin.test.cjs's CSP assertion.
    await test('GET / carries a CSP header confining the page to same-origin fetches', async () => {
      const r = await get(url);
      const csp = r.headers['content-security-policy'] || '';
      assert(/default-src 'none'/.test(csp), "CSP must be default-src 'none'");
      assert(/connect-src 'self'/.test(csp), 'CSP must confine fetch/EventSource to same-origin');
      assert(r.headers['x-content-type-options'] === 'nosniff', 'nosniff on the HTML response');
      assert(r.headers['referrer-policy'] === 'no-referrer', 'no-referrer on the HTML response');
    });

    await test('GET /api/status carries nosniff', async () => {
      const r = await get(url + 'api/status', token);
      assert(r.headers['x-content-type-options'] === 'nosniff', 'nosniff on every JSON route, not just the transcript ones');
    });

    await test('GET /api/status with a MISSING token → 401, no data fields', async () => {
      const r = await get(url + 'api/status');
      assert(r.status === 401, 'expected 401, got ' + r.status);
      const j = JSON.parse(r.body);
      assert(typeof j.error === 'string' && !('rows' in j), '401 body must carry no data fields');
    });

    await test('GET /api/status with a WRONG token → 401', async () => {
      const r = await get(url + 'api/status', 'not-the-token');
      assert(r.status === 401, 'expected 401, got ' + r.status);
    });

    await test('GET /api/status → 200 valid JSON with rows + overall', async () => {
      const r = await get(url + 'api/status', token);
      assert(r.status === 200, 'expected 200, got ' + r.status);
      contains(r.headers['content-type'] || '', 'application/json');
      const j = JSON.parse(r.body);
      assert(Array.isArray(j.rows), 'rows must be an array');
      assert(j.overall === 'warn', 'overall must pass through, got ' + j.overall);
      assert(j.rows.length === 4, 'expected 4 rows, got ' + j.rows.length);
    });

    await test('GET /api/status passes opencode subsystem rows through untouched', async () => {
      const r = await get(url + 'api/status', token);
      const j = JSON.parse(r.body);
      const oc = (j.rows || []).filter((x) => x.subsystem === 'opencode');
      assert(oc.length === 1, 'expected the opencode row to pass through, got ' + oc.length);
      assert(oc[0].level === 'warn' && oc[0].fix === 'sync rewrites it',
        'opencode row level/fix must survive the payload verbatim');
    });

    await test('GET / categorizes the opencode subsystem into the Hosts tab (not the runtime fallback)', async () => {
      const r = await get(url);
      contains(r.body, 'opencode:"hosts"');
      // and it must sort with the host MCP subsystems, not at the unknown end
      contains(r.body, '"codex-mcp","opencode"');
    });

    await test('GET /api/status embeds improvement.json read off the fixture', async () => {
      const r = await get(url + 'api/status', token);
      const j = JSON.parse(r.body);
      assert(j.improvement && j.improvement.verdict === 'PASS', 'improvement.json must be embedded');
      assert(j.improvement.deltaPP === 33, 'improvement fields must survive');
    });

    await test('GET /api/status embeds the health-history ring', async () => {
      const r = await get(url + 'api/status', token);
      const j = JSON.parse(r.body);
      assert(Array.isArray(j.health) && j.health.length === 3, 'health ring must be embedded as an array');
    });

    await test('GET /api/status via ?token= query param (the EventSource fallback path)', async () => {
      const r = await get(url + 'api/status?token=' + encodeURIComponent(token));
      assert(r.status === 200, 'query-param token must also authenticate, got ' + r.status);
    });

    await test('unknown route → 404 (no token required outside /api/)', async () => {
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
      const r = await get(srv2.url + 'api/status', srv2.token);
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

  await test('maskTurns recursively masks nested tool arguments and results', async () => {
    const secret = 'sk-live-NESTED012345';
    const turns = [{
      role: 'assistant',
      tools: [{ name: 'shell', arguments: { command: `deploy --token ${secret}` } }],
      result: { chunks: [{ text: `result ${secret}` }] },
    }];
    const out = maskTurns(turns, (s) => s.replaceAll(secret, '[MASKED]'));
    const wire = JSON.stringify(out);
    assert(!wire.includes(secret), 'nested tool data must pass through the server masker');
    assert(wire.includes('[MASKED]'), 'nested strings should remain present only in masked form');
    assert(JSON.stringify(turns).includes(secret), 'recursive masking must not mutate the source transcript');
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
    byHost: {
      claude: { cost: 10, sessions: 1, tokens: 1000 },
      codex: { cost: 2.5, sessions: 1, tokens: 250 },
    },
    byProvider: {
      anthropic: { cost: 10, sessions: 1, tokens: 1000 },
      unknown: { cost: null, sessions: 1, tokens: 250 },
    },
    byTranscriptProvider: {
      claude: { cost: 10, sessions: 1, tokens: 1000 },
      codex: { cost: 2.5, sessions: 1, tokens: 250 },
    },
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
        id: `row-${i}`, host: 'claude', provider: i ? 'anthropic' : null,
        providerProvenance: i ? 'observed' : 'unknown',
        transcriptProvider: 'claude', title: `session ${i}`, project: 'demo',
        category: 'Security review', cost: 0.25, minutes: 2, tokens: 100,
      })),
    }],
    sessions: [
      { id: 'aaa', host: 'claude', provider: 'anthropic', providerProvenance: 'observed',
        transcriptProvider: 'claude', title: 'one', project: 'demo', category: 'Security review', cost: 10 },
      { id: 'bbb', host: 'codex', provider: null, providerProvenance: 'unknown',
        transcriptProvider: 'codex', title: 'two', project: 'other', category: 'Refactor', cost: 2.5 },
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
      const r = await get(usageSrv.url + 'api/usage?days=7', usageSrv.token);
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
      const all = JSON.parse((await get(usageSrv.url + 'api/sessions?days=14', usageSrv.token)).body);
      assert(Array.isArray(all.sessions) && all.sessions.length === 2, 'both sessions with no filter');
      assert(all.total === 2, 'total must report the pre-pagination count, got ' + all.total);

      const byProject = JSON.parse((await get(usageSrv.url + 'api/sessions?project=demo', usageSrv.token)).body);
      assert(byProject.sessions.length === 1 && byProject.sessions[0].id === 'aaa', 'project filter must apply');

      const byCat = JSON.parse((await get(usageSrv.url + 'api/sessions?category=Refactor', usageSrv.token)).body);
      assert(byCat.sessions.length === 1 && byCat.sessions[0].id === 'bbb', 'category filter must apply');

      const paged = JSON.parse((await get(usageSrv.url + 'api/sessions?limit=1&offset=1', usageSrv.token)).body);
      assert(paged.sessions.length === 1 && paged.sessions[0].id === 'bbb', 'limit/offset must page');
      assert(paged.total === 2, 'total stays the unpaged count');
    });

    await test('GET /api/session/:id → { meta, turns } with secrets masked SERVER-side', async () => {
      const r = await get(usageSrv.url + 'api/session/aaa', usageSrv.token);
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
        const r = await getRaw(usageSrv.port, p, usageSrv.token);
        assert(r.status === 400, 'expected 400 for ' + p + ', got ' + r.status);
        assert(!/root:|passwd/i.test(r.body), 'a rejected request must not echo file content: ' + p);
      }
      assert(spy.calls.readSession.length === before,
        'readSession must NOT be called for any hostile id — got ' + (spy.calls.readSession.length - before) + ' call(s)');
    });
  } finally {
    await usageSrv.close();
  }

  // ── /api/limits (ADR-0010): injected provider, insights computed server-side ──
  const limitsSrv = await startDashboard({
    port: 0, cwd: fixture, fetchStatus: async () => STUB_STATUS, usage: spyUsage().api,
    limits: async () => ({
      generatedAt: '2026-07-27T12:00:00.000Z',
      claude: {
        provider: 'claude', source: 'statusline', fetchedAt: 1785000000000,
        windows: [{ id: 'seven_day', label: 'weekly', usedPercent: 89, windowMinutes: 10080, resetsAt: 1785600000 }],
      },
      codex: {
        provider: 'codex', source: 'app-server', fetchedAt: 1785000000000, planType: 'prolite',
        lanes: [{ id: 'codex', name: 'codex', windows: [{ label: 'weekly', usedPercent: 3, windowMinutes: 10080, resetsAt: 1785694902 }] }],
        resetCredits: { availableCount: 2, credits: [] },
      },
    }),
  });
  try {
    await test('GET /api/limits → both providers plus server-computed limit insights', async () => {
      const r = await get(limitsSrv.url + 'api/limits', limitsSrv.token);
      assert(r.status === 200, 'expected 200, got ' + r.status);
      const j = JSON.parse(r.body);
      assert(j.claude && j.claude.windows[0].usedPercent === 89, 'claude windows must survive');
      assert(j.codex && j.codex.planType === 'prolite', 'codex plan must survive');
      assert(Array.isArray(j.insights), 'insights must be an array');
      assert(j.insights.some((i) => i.id === 'cross-host-arbitrage-claude'),
        'claude 89% vs codex 3% must yield the arbitrage finding, got ' + JSON.stringify(j.insights.map((i) => i.id)));
      assert(j.insights.some((i) => i.id === 'codex-reset-credits'),
        '2 reset credits must yield the credits finding');
    });
    await test('GET /api/limits degrades to 500 JSON when the provider throws', async () => {
      const broken = await startDashboard({
        port: 0, cwd: fixture, fetchStatus: async () => STUB_STATUS, usage: spyUsage().api,
        limits: async () => { throw new Error('quota backend down'); },
      });
      try {
        const r = await get(broken.url + 'api/limits', broken.token);
        assert(r.status === 500, 'expected 500, got ' + r.status);
        contains(r.body, 'quota backend down');
      } finally { await broken.close(); }
    });
  } finally {
    await limitsSrv.close();
  }

  // Masking is not optional: a usage module that cannot mask must fail the
  // request, never serve an unmasked transcript.
  const noMask = spyUsage({ maskSecrets: undefined });
  const srv3 = await startDashboard({ port: 0, cwd: fixture, fetchStatus: async () => STUB_STATUS, usage: noMask.api });
  try {
    await test('/api/session/:id fails CLOSED when the masker is unavailable', async () => {
      const r = await get(srv3.url + 'api/session/aaa', srv3.token);
      assert(r.status === 500, 'expected 500, got ' + r.status);
      assert(!r.body.includes('sk-live-DEADBEEF01234'), 'no unmasked transcript may leak on the error path');
    });
  } finally {
    await srv3.close();
  }

  // ── the served page: sixth segment, four views, poll control ──
  const uiSrv = await startDashboard({ port: 0, cwd: fixture, fetchStatus: async () => STUB_STATUS, usage: spyUsage().api });
  try {
    await test('served HTML carries the sixth "Usage" segment and its five sub-views', async () => {
      const r = await get(uiSrv.url);
      contains(r.body, 'data-tab="usage"');
      contains(r.body, '>Usage<');
      contains(r.body, 'id="panel-usage"');
      for (const v of ['score', 'limits', 'findings', 'sessions', 'transcript']) {
        contains(r.body, 'id="v-' + v + '"');
        contains(r.body, 'data-view="' + v + '"');
      }
    });

    await test('Usage rendering treats host and inference provider as independent axes', async () => {
      const r = await get(uiSrv.url);
      contains(r.body, 'd.byHost||d.byTranscriptProvider||d.byProvider');
      contains(r.body, 'var host=sx.host||sx.transcriptProvider');
      contains(r.body, 'var provider=sx.provider||sx.inferenceProvider||"unknown"');
      contains(r.body, 'title="host: ');
      contains(r.body, 'class="s-provider"');
    });

    await test('Live rendering never derives host identity from inference provider', async () => {
      const r = await get(uiSrv.url);
      contains(r.body, 'function hostOf');
      contains(r.body, 'function inferenceProviderName');
      contains(r.body, 'Provider not established');
      assert(!r.body.includes('function providerOf'), 'legacy host/provider branding helper remains');
      assert(!r.body.includes('v&&v.provider||v&&v.host'),
        'Live presentation still falls back from provider to host');
    });

    await test('served HTML carries the read-only Live Sessions surface', async () => {
      const r = await get(uiSrv.url);
      for (const marker of [
        'data-tab="live"', 'id="panel-live"', 'id="live-graph"',
        'id="live-session-list"', 'id="live-transcript-list"', 'id="live-selection"',
        'id="live-pause"', 'id="live-viewport"', 'id="live-canvas"',
        'id="live-zoom-in"', 'id="live-zoom-out"', 'id="live-fit"',
        'id="live-fit-selection"', 'id="live-reset-layout"',
        'aria-label="Map controls"', 'new EventSource(dashSseUrl("/api/live/events"))',
        '"/api/live/transcripts/"',
      ]) contains(r.body, marker);
      for (const behavior of [
        'addEventListener("wheel"', 'addEventListener("pointerdown"',
        'addEventListener("pointermove"', 'setPointerCapture',
        'Math.max(.25,Math.min(2.8', 'renderTranscript',
      ]) contains(r.body, behavior);
      assert(!/live-[^"]*"[^>]*>(?:send|cancel|chat|prompt)</i.test(r.body),
        'the live surface must expose no write or chat control');
      contains(r.body, 'window.AKDashboardOpenTranscript=function(id)');
      contains(r.body, 'setTab("usage")');
      contains(r.body, 'setUsageView("transcript",id)');
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

    await test('harness sentinel markup is restyled, not rendered as literal XML', async () => {
      // fmtHarness turns <command-name>/<system-reminder>/<local-command-*>
      // wrappers into styled structure — content verbatim, wrappers gone. The
      // page must carry the formatter, its two regex families, the CSS, and
      // the human-readable labels; and it must run INSIDE the turn body
      // builder (after markRedactions, so it operates on escaped text).
      const r = await get(uiSrv.url);
      contains(r.body, 'function fmtHarness');
      contains(r.body, 'command-name');
      contains(r.body, 'system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|task-notification');
      contains(r.body, 'bash-input');
      contains(r.body, 'fmtHarness(markRedactions(');
      contains(r.body, '.h-cmd{');
      contains(r.body, '.h-note{');
      contains(r.body, '"system reminder"');
      contains(r.body, '"command output"');
      contains(r.body, '"bash output"');
      contains(r.body, '"task notification"');
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
          const r = await getRaw(srv.port, `/api/session/${id}`, srv.token);
          assert(r.status === 404, `${id} must be 404, got ${r.status}`);
          assert(!r.body.includes('"turns"'), 'a 404 must not carry a turns array');
        }
        // A malformed id stays 400 — "missing" and "malformed" must not collapse
        // into one status, or the guard becomes unobservable.
        const bad = await getRaw(srv.port, '/api/session/..', srv.token);
        assert(bad.status === 400, `a dot-segment id is malformed (400), got ${bad.status}`);
      } finally { await srv.close(); }
    });

    // The payload trim must actually trim. projectTree[].rows holds the same
    // objects as sessions[], so dropping only the top-level array left the whole
    // session list in the response.
    await test('/api/usage trims projectTree rows to the preview cap', async () => {
      const r = await get(`${uiSrv.url}api/usage?days=14`, uiSrv.token);
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
          { host: '127.0.0.1', port: uiSrv.port, path: '/api/usage?days=365', method: 'GET', headers: { 'x-dash-token': uiSrv.token, ...h } },
          (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b })); },
        ).on('error', reject).end();
      });
      assert((await hdr({ 'sec-fetch-site': 'cross-site' })).status === 403, 'cross-site must be 403');
      assert((await hdr({ 'sec-fetch-site': 'same-site' })).status === 403, 'same-site is still another origin');
      assert((await hdr({ origin: 'https://evil.example' })).status === 403, 'a foreign Origin must be 403');
      assert((await hdr({ origin: 'http://127.0.0.1:1' })).status === 403,
        'a different loopback port is still a foreign origin');
      assert((await hdr({ origin: `https://127.0.0.1:${uiSrv.port}` })).status === 403,
        'the HTTPS origin cannot be the origin of this plain-HTTP server');
      // Our own page and non-browser clients must keep working.
      assert((await hdr({ 'sec-fetch-site': 'same-origin' })).status === 200, 'our own page must pass');
      assert((await hdr({ origin: `http://127.0.0.1:${uiSrv.port}` })).status === 200,
        'the exact dashboard origin must pass');
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
        const r = await get(`${srv.url}api/session/abc123`, srv.token);
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

  // ── Live Sessions: read-only snapshot + resumable, bounded SSE transport ──
  const listeners = new Set();
  const liveCalls = { start: 0, close: 0, subscribe: 0, unsubscribe: 0, replay: [] };
  const liveEvents = [
    { eventId: 'test:1', ingestSeq: 1, action: 'session.started', sessionId: 's1' },
    {
      eventId: 'test:2', ingestSeq: 2, action: 'agent.output', sessionId: 's1',
      source: { artifact: '/Users/private/.codex/sessions/rollout-secret.jsonl' },
      prompt: 'PRIVATE PROMPT', arguments: { token: 'PRIVATE ARGUMENT' },
      result: 'PRIVATE RESULT', cwd: '/Users/private/Development/secret-project',
    },
  ];
  const liveSnapshot = {
    schemaVersion: 1,
    cursor: 'test:2',
    sessions: [{
      id: 's1',
      nodes: [{
        id: 'n1',
        source: { artifact: '/Users/private/.claude/projects/session.jsonl' },
        response: 'PRIVATE RESPONSE',
        toolResult: { text: 'PRIVATE TOOL RESULT' },
        projectRoot: '/Users/private/Development/secret-project',
      }],
      edges: [],
    }],
  };
  const live = {
    start() { liveCalls.start++; },
    snapshot() { return liveSnapshot; },
    replay(cursor) {
      liveCalls.replay.push(cursor);
      if (cursor === 'test:1') return { reset: false, events: liveEvents.slice(1) };
      return { reset: true, events: liveEvents };
    },
    subscribe(fn) {
      liveCalls.subscribe++;
      listeners.add(fn);
      return () => { liveCalls.unsubscribe++; listeners.delete(fn); };
    },
    close() { liveCalls.close++; },
  };
  const liveSrv = await startDashboard({
    port: 0, cwd: fixture, fetchStatus: async () => STUB_STATUS, usage: spyUsage().api,
    live, liveHeartbeatMs: 100, liveMaxClients: 1,
  });
  let activeAtShutdown;
  try {
    await test('GET /api/live returns a no-store materialized snapshot and starts lazily once', async () => {
      assert(liveCalls.start === 0, 'live collector must remain lazy until requested');
      const r = await get(liveSrv.url + 'api/live', liveSrv.token);
      assert(r.status === 200, 'expected 200, got ' + r.status);
      contains(r.headers['content-type'] || '', 'application/json');
      assert(r.headers['cache-control'] === 'no-store', 'live snapshots must never be cached');
      assert(JSON.parse(r.body).cursor === 'test:2', 'snapshot cursor must survive');
      assert(!r.body.includes('/Users/private'), 'snapshot provenance must not expose absolute paths');
      for (const secret of ['PRIVATE RESPONSE', 'PRIVATE TOOL RESULT']) {
        assert(!r.body.includes(secret), `snapshot must not expose ${secret}`);
      }
      await get(liveSrv.url + 'api/live', liveSrv.token);
      assert(liveCalls.start === 1, 'live collector must start exactly once');
    });

    await test('GET /api/live/events with no token → 401 before any subscribe', async () => {
      const before = liveCalls.subscribe;
      const r = await getRaw(liveSrv.port, '/api/live/events');
      assert(r.status === 401, 'expected 401, got ' + r.status);
      assert(liveCalls.subscribe === before, 'unauthenticated SSE must not subscribe');
    });

    await test('GET /api/live/events sends init, named/id delta events and heartbeats', async () => {
      let body = '';
      const stream = openSse(liveSrv.port, { onChunk: (chunk) => { body += chunk; }, token: liveSrv.token });
      const response = await stream.opened;
      try {
        assert(response.statusCode === 200, 'expected SSE 200');
        contains(response.headers['content-type'] || '', 'text/event-stream');
        assert(response.headers['cache-control'] === 'no-store', 'SSE must be no-store');
        assert(response.headers.connection === 'keep-alive', 'SSE must keep the connection alive');
        await eventually(() => body.includes('event: init'), 'initial snapshot event was not sent');
        for (const secret of [
          '/Users/private', 'PRIVATE PROMPT', 'PRIVATE ARGUMENT', 'PRIVATE RESULT',
          'PRIVATE RESPONSE', 'PRIVATE TOOL RESULT',
        ]) assert(!body.includes(secret), `SSE init/replay must not expose ${secret}`);
        const emitted = {
          eventId: 'test:3', ingestSeq: 3, action: 'tool.started', sessionId: 's1',
          prompt: 'PRIVATE DELTA PROMPT',
          args: { command: 'PRIVATE DELTA ARGUMENT' },
          result: { text: 'PRIVATE DELTA RESULT' },
          path: '/Users/private/Development/secret-project/private.txt',
        };
        for (const fn of listeners) fn(emitted);
        await eventually(() => body.includes('id: test:3') && body.includes('event: delta'),
          'named delta with event id was not sent');
        for (const secret of [
          '/Users/private', 'PRIVATE DELTA PROMPT', 'PRIVATE DELTA ARGUMENT', 'PRIVATE DELTA RESULT',
        ]) assert(!body.includes(secret), `SSE delta must not expose ${secret}`);
        await eventually(() => body.includes(': heartbeat'), 'heartbeat was not sent');
        assert(!body.includes('/Users/private'), 'SSE provenance must not expose absolute paths');
      } finally { stream.close(); }
      await eventually(() => listeners.size === 0, 'disconnect did not remove SSE listener');
    });

    await test('Last-Event-ID resumes retained deltas and stale cursors force reset init', async () => {
      let resumed = '';
      const one = openSse(liveSrv.port, {
        headers: { 'last-event-id': 'test:1' }, onChunk: (chunk) => { resumed += chunk; }, token: liveSrv.token,
      });
      await one.opened;
      try {
        await eventually(() => resumed.includes('id: test:2'), 'retained delta was not replayed');
        contains(resumed, '"reset":false');
      } finally { one.close(); }

      let reset = '';
      const stale = openSse(liveSrv.port, {
        headers: { 'last-event-id': 'test:0' }, onChunk: (chunk) => { reset += chunk; }, token: liveSrv.token,
      });
      await stale.opened;
      try {
        await eventually(() => reset.includes('"reset":true'), 'stale cursor did not reset');
        assert(!reset.includes('id: test:1'), 'reset must use its snapshot, not replay stale deltas');
      } finally { stale.close(); }
      assert(liveCalls.replay.includes('test:1') && liveCalls.replay.includes('test:0'),
        'both Last-Event-ID values must reach replay()');
    });

    await test('cross-site live stream is rejected before subscribe/start work', async () => {
      const before = liveCalls.subscribe;
      const r = await new Promise((resolve, reject) => {
        http.request({
          host: '127.0.0.1', port: liveSrv.port, path: '/api/live/events', method: 'GET',
          headers: { 'sec-fetch-site': 'cross-site' },
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject).end();
      });
      assert(r.status === 403, 'cross-site SSE must be 403');
      assert(liveCalls.subscribe === before, 'rejected SSE must not subscribe');
    });

    await test('an active SSE client is registered for dashboard shutdown cleanup', async () => {
      activeAtShutdown = openSse(liveSrv.port, { token: liveSrv.token });
      await activeAtShutdown.opened;
      await eventually(() => listeners.size === 1, 'active stream did not subscribe');
      const excess = await getRaw(liveSrv.port, '/api/live/events', liveSrv.token);
      assert(excess.status === 503, `excess SSE client must be rejected, got ${excess.status}`);
      assert(listeners.size === 1, 'rejected client must not create a subscription');
    });
  } finally {
    await liveSrv.close();
    activeAtShutdown?.close();
  }
  await test('dashboard close releases SSE clients and closes the live service once', async () => {
    assert(listeners.size === 0, 'all live listeners must be released');
    assert(liveCalls.unsubscribe === liveCalls.subscribe, 'every subscription must be unsubscribed');
    assert(liveCalls.close === 1, 'live service must close exactly once');
  });

  await test('SSE initialization loses neither snapshot-time nor post-replay events', async () => {
    const raceListeners = new Set();
    const during = {
      eventId: 'race:1', ingestSeq: 1, sessionId: 'race-session',
      action: 'agent.started', actor: { id: 'during', kind: 'agent' },
    };
    const afterReplay = {
      eventId: 'race:2', ingestSeq: 2, sessionId: 'race-session',
      action: 'tool.started', actor: { id: 'after-replay', kind: 'tool' },
    };
    let snapshotCalls = 0;
    const raceLive = {
      start() {},
      async snapshot() {
        snapshotCalls++;
        // The event occurs while an async snapshot is being assembled and is
        // represented in the returned materialization.
        for (const fn of raceListeners) fn(during);
        await Promise.resolve();
        return {
          schemaVersion: 1,
          cursor: 'race:1',
          sessions: [{
            id: 'race-session', nodes: [{ id: 'during', kind: 'agent' }], edges: [],
          }],
        };
      },
      replay(cursor) {
        assert(cursor === 'race:1', `unexpected race cursor ${cursor}`);
        return {
          reset: false,
          // Access happens after replay() returns. Publishing from the getter
          // deterministically exercises the replay-resolution/init handoff.
          get events() {
            for (const fn of raceListeners) fn(afterReplay);
            return [];
          },
        };
      },
      subscribe(fn) {
        raceListeners.add(fn);
        return () => raceListeners.delete(fn);
      },
      close() {},
    };
    const raceSrv = await startDashboard({
      port: 0, fetchStatus: async () => STUB_STATUS, usage: spyUsage().api,
      live: raceLive, liveHeartbeatMs: 10_000,
    });
    let body = '';
    const stream = openSse(raceSrv.port, { onChunk: (chunk) => { body += chunk; }, token: raceSrv.token });
    try {
      await stream.opened;
      await eventually(() => body.includes('id: race:2'), 'post-replay event was lost');
      assert(body.includes('"id":"during"'), 'snapshot-time event must remain in the init snapshot');
      assert(!body.includes('id: race:1'), 'snapshot-time event must not be duplicated as a delta');
      assert((body.match(/id: race:2/g) || []).length === 1,
        'post-replay event must be delivered exactly once');
      assert(snapshotCalls === 1, 'stream initialization must take one snapshot');
    } finally {
      stream.close();
      await raceSrv.close();
    }
    assert(raceListeners.size === 0, 'race-test subscription must be cleaned up');
  });

  // code-quality Finding 1 regression: the client-cap check and the client-cap
  // registration used to be on opposite sides of several awaits (dynamic
  // import + service.start() inside getLive()). Two concurrent requests could
  // both observe size===0 before either registered, and both pass a cap of 1.
  // The fix reserves the slot BEFORE the first await — this proves it holds
  // under real concurrency, not just sequentially.
  await test('SSE client cap holds under concurrent requests racing a slow async start (TOCTOU fix)', async () => {
    let starting = null;
    let resolveStart;
    const slowLive = {
      async start() {
        starting = new Promise((r) => { resolveStart = r; });
        await starting;
      },
      snapshot() { return { schemaVersion: 1, cursor: 'slow:0', sessions: [] }; },
      replay() { return { reset: false, events: [] }; },
      subscribe() { return () => {}; },
      close() {},
    };
    const slowSrv = await startDashboard({
      port: 0, fetchStatus: async () => STUB_STATUS, usage: spyUsage().api,
      live: slowLive, liveMaxClients: 1, liveHeartbeatMs: 10_000,
    });
    try {
      // Fire two SSE connections back-to-back, BEFORE either's getLive() (and
      // therefore start()) has resolved — both requests are mid-await when the
      // second one's cap check would run under the old (broken) ordering.
      const first = openSse(slowSrv.port, { token: slowSrv.token });
      const second = openSse(slowSrv.port, { token: slowSrv.token });
      await eventually(() => starting !== null, 'slow start() was never invoked');
      const secondResponse = await second.opened;
      // The second connection's cap check runs synchronously before any await
      // in its own request — it must already see the first request's reserved
      // slot and be rejected, even though the first hasn't finished starting.
      assert(secondResponse.statusCode === 503, `second concurrent client must be capped, got ${secondResponse.statusCode}`);
      resolveStart();
      const firstResponse = await first.opened;
      assert(firstResponse.statusCode === 200, `first client must succeed once start() resolves, got ${firstResponse.statusCode}`);
      first.close();
      second.close();
    } finally {
      await slowSrv.close();
    }
  });

  // code-quality Finding 1's second half: a client that disconnects DURING the
  // async setup window (before req.once('close', cleanup) could even attach
  // under the old ordering) must not leak its reservation forever — a leak
  // here means stopLive()'s idle-teardown can never fire again.
  await test('an abort during slow async start releases its slot (no permanent leak)', async () => {
    let starting = null;
    let resolveStart;
    const slowLive = {
      async start() {
        starting = new Promise((r) => { resolveStart = r; });
        await starting;
      },
      snapshot() { return { schemaVersion: 1, cursor: 'slow:0', sessions: [] }; },
      replay() { return { reset: false, events: [] }; },
      subscribe() { return () => {}; },
      close() {},
    };
    const slowSrv = await startDashboard({
      port: 0, fetchStatus: async () => STUB_STATUS, usage: spyUsage().api,
      live: slowLive, liveMaxClients: 1, liveHeartbeatMs: 10_000, liveIdleMs: 20,
    });
    try {
      const aborted = openSse(slowSrv.port, { token: slowSrv.token });
      aborted.opened.catch(() => {}); // destroying it below rejects this — expected, not a test failure
      await eventually(() => starting !== null, 'slow start() was never invoked');
      aborted.close(); // destroy the socket WHILE still inside getLive()'s await
      resolveStart();  // let the in-flight start() finish after the abort
      // If the slot leaked, this second connection would see liveClients.size
      // still at the cap (1) and get 503 forever. A released slot lets it
      // through as soon as the first request's cleanup has run. `eventually`
      // takes a synchronous predicate, so this polls with real awaits instead.
      const deadline = Date.now() + 2000;
      let ok = false;
      while (Date.now() < deadline && !ok) {
        const r = await getRaw(slowSrv.port, '/api/live', slowSrv.token);
        ok = r.status === 200;
        if (!ok) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert(ok, 'a fresh request never got in — the aborted client\'s slot leaked');
    } finally {
      await slowSrv.close();
    }
  });

  await test('live collector idles, restarts, cancels idle while connected, and closes once', async () => {
    const idleCalls = { start: 0, close: 0 };
    const idleListeners = new Set();
    const idleLive = {
      start() { idleCalls.start++; },
      snapshot() { return { schemaVersion: 1, cursor: 'idle:0', sessions: [] }; },
      replay() { return { reset: false, events: [] }; },
      subscribe(fn) {
        idleListeners.add(fn);
        return () => idleListeners.delete(fn);
      },
      close() { idleCalls.close++; },
    };
    const idleSrv = await startDashboard({
      port: 0, fetchStatus: async () => STUB_STATUS, usage: spyUsage().api,
      live: idleLive, liveIdleMs: 40, liveHeartbeatMs: 10_000,
    });
    let stream;
    try {
      assert((await get(idleSrv.url + 'api/live', idleSrv.token)).status === 200, 'snapshot request failed');
      assert(idleCalls.start === 1, 'snapshot must start collector once');
      await eventually(() => idleCalls.close === 1, 'snapshot-only collector did not idle-close');

      assert((await get(idleSrv.url + 'api/live', idleSrv.token)).status === 200, 'restart snapshot failed');
      assert(idleCalls.start === 2, 'request after idle close must restart collector');
      stream = openSse(idleSrv.port, { token: idleSrv.token });
      await stream.opened;
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert(idleCalls.close === 1, 'active SSE client must cancel idle close');

      stream.close();
      stream = null;
      await eventually(() => idleCalls.close === 2, 'last SSE disconnect did not idle-close');
      assert(idleListeners.size === 0, 'idle close must release the SSE subscription');
    } finally {
      stream?.close();
      await idleSrv.close();
    }
    assert(idleCalls.close === 2, 'shutdown must not double-close an already-idle collector');
  });

  await test('selected transcript SSE is separate, resumable and security hardened', async () => {
    const listeners = new Set();
    let closed = 0;
    const event = {
      schemaVersion: 1, eventId: 'tx-claude-s1:1', sessionKey: 'claude:s1',
      sessionId: 's1', host: 'claude', kind: 'message',
      actor: { id: 's1', role: 'assistant', label: null },
      text: 'masked transcript text', tool: null,
    };
    const transcriptStream = {
      snapshot() {
        return { schemaVersion: 1, cursor: event.eventId,
          sessionKey: 'claude:s1', events: [event] };
      },
      replay(cursor) {
        return cursor === event.eventId
          ? { reset: false, events: [] } : { reset: true, events: [event] };
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const transcriptService = {
      open(host, id) {
        assert(host === 'claude' && id === 's1', 'route target did not reach service');
        return transcriptStream;
      },
      close() { closed++; },
    };
    const srv = await startDashboard({
      port: 0, fetchStatus: async () => STUB_STATUS, usage: spyUsage().api,
      transcripts: transcriptService, liveHeartbeatMs: 10_000,
    });
    let body = '';
    const stream = openSse(srv.port, {
      path: '/api/live/transcripts/claude/s1/events',
      headers: { 'Last-Event-ID': event.eventId },
      onChunk: (chunk) => { body += chunk; },
      token: srv.token,
    });
    try {
      const response = await stream.opened;
      assert(response.statusCode === 200, 'transcript stream must answer 200');
      assert((response.headers['cache-control'] || '') === 'no-store', 'content must not cache');
      assert(response.headers['x-content-type-options'] === 'nosniff', 'nosniff missing');
      assert(response.headers['cross-origin-resource-policy'] === 'same-origin', 'CORP missing');
      assert(response.headers['referrer-policy'] === 'no-referrer', 'referrer policy missing');
      await eventually(() => body.includes('event: init'), 'transcript init missing');
      assert(body.includes('masked transcript text'), 'transcript body was wrongly stripped');
      assert(!body.includes('event: delta'), 'cursor replay duplicated the current event');
    } finally {
      stream.close();
      await srv.close();
    }
    assert(listeners.size === 0, 'transcript subscription leaked');
    assert(closed === 1, 'transcript service must close once');
  });

  await test('transcript route rejects malformed targets before opening a stream', async () => {
    let opens = 0;
    const srv = await startDashboard({
      port: 0, fetchStatus: async () => STUB_STATUS, usage: spyUsage().api,
      transcripts: { open() { opens++; throw new Error('should not open'); }, close() {} },
    });
    try {
      assert((await getRaw(srv.port, '/api/live/transcripts/other/s1/events', srv.token)).status === 400,
        'unknown host must be 400');
      assert((await getRaw(srv.port, '/api/live/transcripts/claude/..%2Fx/events', srv.token)).status === 400,
        'traversal id must be 400');
      assert(opens === 0, 'invalid target reached transcript service');
    } finally {
      await srv.close();
    }
  });

  await test('session playback route returns a deterministic seek manifest and releases its reader', async () => {
    let releases = 0;
    const playback = {
      schemaVersion: 1, sessionKey: 'codex:s1', host: 'codex', sessionId: 's1',
      range: { startedAt: '2026-07-27T12:00:00.000Z',
        endedAt: '2026-07-27T12:00:03.000Z', durationMs: 3000,
        eventCount: 1, truncated: false },
      seek: { requestedMs: 1500, atMs: 1500, eventIndex: 0 },
      live: { cursor: 'tx-codex-s1:1',
        eventsEndpoint: '/api/live/transcripts/codex/s1/events' },
      events: [{ eventId: 'tx-codex-s1:1', at: '2026-07-27T12:00:00.000Z',
        elapsedMs: 0, text: 'masked evidence' }],
    };
    const srv = await startDashboard({
      port: 0, fetchStatus: async () => STUB_STATUS, usage: spyUsage().api,
      transcripts: {
        open(host, id) {
          assert(host === 'codex' && id === 's1', 'wrong playback target');
          return {
            playback({ atMs }) {
              assert(atMs === 1500, 'seek offset was not parsed');
              return playback;
            },
          };
        },
        release(host, id) {
          assert(host === 'codex' && id === 's1', 'wrong release target');
          releases++;
        },
        close() {},
      },
    });
    try {
      const r = await get(srv.url + 'api/live/playback/codex/s1?at=1500', srv.token);
      assert(r.status === 200, 'playback request failed');
      assert(r.headers['cache-control'] === 'no-store', 'playback content must not cache');
      assert(JSON.parse(r.body).live.cursor === 'tx-codex-s1:1', 'live handoff cursor missing');
      assert((await get(srv.url + 'api/live/playback/codex/s1?at=NaN', srv.token)).status === 400,
        'invalid seek must be rejected');
      assert((await getRaw(srv.port,
        '/api/live/playback/codex/..%2Fx', srv.token)).status === 400,
      'playback traversal target must be rejected');
    } finally {
      await srv.close();
    }
    assert(releases === 1, 'playback reader was not released');
  });

  // Test-quality Finding 5: bump deliberately when adding/removing a test —
  // see admin-model.test.cjs's identical guard for the full rationale. This
  // is the suite where it matters most — the traversal-guard and credential-
  // leak tests live here and were the reviewer's cited example of a block
  // that could silently vanish with the old harness never noticing.
  const EXPECTED = 58;
  if (passed + failed !== EXPECTED) {
    console.error(`\nPLAN MISMATCH: expected ${EXPECTED} tests, ran ${passed + failed}`);
    process.exit(1);
  }
  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
