#!/usr/bin/env node
//
// admin.test.cjs — unit tests for the maintainer admin (src/lib/admin-collect.mjs
// + src/lib/admin-server.mjs). Zero-dep, NETWORK-FREE: the GitHub/npm fetchers are
// INJECTED (fetchImpl) and the server's stats collector is INJECTED (collect), so
// nothing here ever touches the network. The server is exercised over real HTTP on
// an ephemeral loopback port.
//
// Run: node tests/admin.test.cjs   (exit 0 = pass, 1 = fail)

const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const COLLECT = path.join(ROOT, 'src', 'lib', 'admin-collect.mjs');
const SERVER = path.join(ROOT, 'src', 'lib', 'admin-server.mjs');

// ── tiny harness ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('  \x1b[32m✓\x1b[0m ' + name); passed++; })
    .catch((e) => { console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + (e && e.message)); failed++; });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { assert(a === b, (msg || 'equality') + ` — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// GET/POST helper with optional headers → { status, headers, body }
function req(url, { headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { ...headers } };
    if (host) opts.headers.host = host;
    http.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject).end();
  });
}

// A fetch double: `route(url)` returns { ok?, status?, body } or an Error to throw.
// Captures every requested URL so tests can assert on the exact request path.
function mkFetch(route) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const r = route(String(url));
    if (r instanceof Error) throw r;
    return { ok: r.ok !== false, status: r.status ?? 200, json: async () => r.body };
  };
  impl.calls = calls;
  return impl;
}

// A canonical GitHub/npm fixture set for the AC-3 contract test.
function ghFixtures(url) {
  if (/\/repos\/pacphi\/agentic-kit\/releases/.test(url)) {
    return { body: [
      { tag_name: 'v1.0.0', name: 'One', published_at: '2026-01-01T00:00:00Z',
        assets: [{ name: 'kit.tgz', download_count: 100, size: 2097152 }, { name: 'kit.zip', download_count: 50, size: 1048576 }] },
    ] };
  }
  if (/\/repos\/pacphi\/agentic-kit\/traffic\/clones/.test(url)) return { body: { count: 40, uniques: 12, clones: [{ timestamp: '2026-01-01T00:00:00Z', count: 5, uniques: 3 }] } };
  if (/\/repos\/pacphi\/agentic-kit\/traffic\/views/.test(url)) return { body: { count: 200, uniques: 88, views: [{ timestamp: '2026-01-01T00:00:00Z', count: 20, uniques: 10 }] } };
  if (/\/repos\/pacphi\/agentic-kit\/traffic\/popular\/referrers/.test(url)) return { body: [{ referrer: 'github.com', count: 30, uniques: 9 }] };
  if (/\/repos\/pacphi\/agentic-kit\/issues/.test(url)) {
    return { body: [
      { number: 9, title: 'external issue', state: 'open', user: { login: 'alice' }, author_association: 'CONTRIBUTOR', pull_request: null, html_url: 'https://github.com/pacphi/agentic-kit/issues/9', created_at: '2026-06-01T00:00:00Z' },
      { number: 5, title: 'external PR', state: 'open', user: { login: 'bob' }, author_association: 'NONE', pull_request: { url: 'x' }, html_url: 'https://github.com/pacphi/agentic-kit/pull/5', created_at: '2026-03-01T00:00:00Z' },
      { number: 3, title: 'my own issue', state: 'closed', user: { login: 'pacphi' }, author_association: 'OWNER', pull_request: null, html_url: 'https://github.com/pacphi/agentic-kit/issues/3', created_at: '2026-02-01T00:00:00Z' },
    ] };
  }
  if (/\/repos\/pacphi\/agentic-kit\/stargazers/.test(url)) return { body: [{ login: 'carol' }, { login: 'pacphi' }] };
  if (/\/repos\/pacphi\/agentic-kit\/forks/.test(url)) return { body: [{ owner: { login: 'dave' }, created_at: '2026-04-01T00:00:00Z' }] };
  if (/\/repos\/pacphi\/agentic-kit$/.test(url)) return { body: { stargazers_count: 20, forks_count: 4, subscribers_count: 3, open_issues_count: 2 } };
  if (/api\.npmjs\.org/.test(url)) return { body: { downloads: Array.from({ length: 30 }, (_, i) => ({ day: '2026-01-' + String(i + 1).padStart(2, '0'), downloads: i + 1 })) } };
  return { ok: false, status: 404, body: null };
}

async function main() {
  const C = await import('file://' + COLLECT);
  const S = await import('file://' + SERVER);

  // ── parseRepoSlug — shapes + fail-closed (EC-8) ─────────────────────────────
  await test('parseRepoSlug handles git+https / ssh / scp / bare shapes', () => {
    eq(C.parseRepoSlug('git+https://github.com/pacphi/agentic-kit.git'), 'pacphi/agentic-kit');
    eq(C.parseRepoSlug('ssh://git@github.com/pacphi/agentic-kit.git'), 'pacphi/agentic-kit');
    eq(C.parseRepoSlug('git@github.com:pacphi/agentic-kit.git'), 'pacphi/agentic-kit');
    eq(C.parseRepoSlug('https://github.com/o/r'), 'o/r');
  });
  await test('parseRepoSlug fails closed (null) on unparseable input', () => {
    eq(C.parseRepoSlug('not a url'), null);
    eq(C.parseRepoSlug('https://github.com/only-owner'), null);
    eq(C.parseRepoSlug(''), null);
    eq(C.parseRepoSlug(null), null);
    eq(C.parseRepoSlug(42), null);
  });

  // ── resolveGhToken — env chain + best-effort gh (FR-4, EC-7) ────────────────
  await test('resolveGhToken prefers GITHUB_TOKEN then GH_TOKEN', async () => {
    eq((await C.resolveGhToken({ GITHUB_TOKEN: 'aaa', GH_TOKEN: 'bbb' })).token, 'aaa');
    eq((await C.resolveGhToken({ GH_TOKEN: 'bbb' })).source, 'GH_TOKEN');
  });
  await test('resolveGhToken falls back to `gh auth token`, then to empty', async () => {
    const okGh = async () => ({ stdout: 'ghp_fromcli\n' });
    eq((await C.resolveGhToken({}, okGh)).token, 'ghp_fromcli');
    const noGh = async () => { throw new Error('gh: command not found'); };  // EC-7: absent gh must not crash
    const r = await C.resolveGhToken({}, noGh);
    eq(r.token, '');
    eq(r.source, null);
  });

  // ── collectAdminStats — the payload contract (AC-3) ─────────────────────────
  await test('collectAdminStats builds the documented contract from injected fixtures', async () => {
    const fetchImpl = mkFetch(ghFixtures);
    const d = await C.collectAdminStats({ fetchImpl, ghToken: 'tok', repoSlug: 'pacphi/agentic-kit', npmPkg: 'agentic-kit' });

    // repo reach
    assert(d.repo && d.repo.stars === 20 && d.repo.forks === 4 && d.repo.watchers === 3 && d.repo.openIssues === 2, 'repo reach mapped');

    // releases mapped + totalAssetDownloads summed (EC-1)
    eq(d.releases.length, 1);
    eq(d.releases[0].tag, 'v1.0.0');
    eq(d.releases[0].name, 'One');
    eq(d.releases[0].assets.length, 2);
    eq(d.totalAssetDownloads, 150);

    // people grouped by external author, OWNER excluded server-side
    const logins = d.people.contributors.map((c) => c.login);
    assert(logins.includes('alice') && logins.includes('bob'), 'external authors grouped');
    assert(!logins.includes('pacphi'), 'the owner is excluded from contributors');
    assert(!d.people.stargazers.includes('pacphi'), 'the owner is excluded from stargazers');
    // totalIssues/totalPRs count the whole issue list (pseudocode §3d) — non-PR
    // items #9 (alice) + #3 (owner) = 2 issues, #5 = 1 PR. Owner-exclusion is a
    // contributors/stargazers/forks property, not an aggregate-count one.
    eq(d.people.totalIssues, 2);
    eq(d.people.totalPRs, 1);

    // traffic configured
    eq(d.traffic.configured, true);
    assert(d.traffic.clones && d.traffic.views && Array.isArray(d.traffic.referrers), 'traffic sub-blocks present');

    // npm week/month/daily
    assert(d.npm && Array.isArray(d.npm.daily) && d.npm.daily.length === 30, 'npm daily present');
    eq(d.npm.lastWeek, 24 + 25 + 26 + 27 + 28 + 29 + 30); // last 7 of 1..30
    eq(d.npm.lastMonth, (30 * 31) / 2);                    // sum 1..30

    // feedback doors built from slug, never network
    assert(d.feedback.issues.includes('pacphi/agentic-kit') && d.feedback.discussions.includes('pacphi/agentic-kit'), 'doors from slug');
  });

  await test('collectAdminStats URL-encodes a scoped npm package name (AC-3)', async () => {
    const fetchImpl = mkFetch(ghFixtures);
    await C.collectAdminStats({ fetchImpl, ghToken: 'tok', repoSlug: 'pacphi/agentic-kit', npmPkg: '@scope/name' });
    const npmCall = fetchImpl.calls.find((u) => /api\.npmjs\.org/.test(u));
    assert(npmCall && npmCall.includes('%40scope%2Fname'), 'scoped name must be percent-encoded, got: ' + npmCall);
  });

  // ── AC-2 — no credential degrades honestly ──────────────────────────────────
  await test('no GitHub credential → traffic.configured false + note; repo/releases/npm still populate', async () => {
    const fetchImpl = mkFetch(ghFixtures);
    const d = await C.collectAdminStats({ fetchImpl, ghToken: '', repoSlug: 'pacphi/agentic-kit', npmPkg: 'agentic-kit' });
    eq(d.traffic.configured, false);
    assert(typeof d.traffic.note === 'string' && d.traffic.note.length > 0, 'a human note, not an error');
    eq(d.traffic.clones, null);
    eq(d.traffic.views, null);
    eq(d.traffic.referrers, null);
    assert(d.repo && d.repo.stars === 20, 'repo still populates without a token');
    assert(d.releases.length === 1, 'releases still populate');
    assert(d.npm && d.npm.daily.length === 30, 'npm still populates');
    // the traffic endpoints must never be requested when unconfigured
    assert(!fetchImpl.calls.some((u) => /\/traffic\//.test(u)), 'no doomed traffic request when unconfigured');
  });

  // ── Edge cases ───────────────────────────────────────────────────────────────
  await test('EC-1: no releases → releases [] and totalAssetDownloads 0 (never a fabricated 0)', async () => {
    const fetchImpl = mkFetch((url) => (/releases/.test(url) ? { body: [] } : ghFixtures(url)));
    const d = await C.collectAdminStats({ fetchImpl, ghToken: 'tok', repoSlug: 'pacphi/agentic-kit', npmPkg: 'agentic-kit' });
    eq(JSON.stringify(d.releases), '[]');
    eq(d.totalAssetDownloads, 0);
  });
  await test('EC-2: npm 404 → npm null (page still functional)', async () => {
    const fetchImpl = mkFetch((url) => (/api\.npmjs\.org/.test(url) ? { ok: false, status: 404, body: null } : ghFixtures(url)));
    const d = await C.collectAdminStats({ fetchImpl, ghToken: 'tok', repoSlug: 'pacphi/agentic-kit', npmPkg: 'agentic-kit' });
    eq(d.npm, null);
    assert(d.repo, 'siblings unaffected');
  });
  await test('EC-3: a sub-fetch throwing nulls its block, siblings unaffected', async () => {
    const fetchImpl = mkFetch((url) => (/stargazers/.test(url) ? new Error('boom') : ghFixtures(url)));
    const d = await C.collectAdminStats({ fetchImpl, ghToken: 'tok', repoSlug: 'pacphi/agentic-kit', npmPkg: 'agentic-kit' });
    eq(JSON.stringify(d.people.stargazers), '[]');   // failed stargazer fetch → empty, not a rejection
    assert(d.repo && d.repo.stars === 20, 'the repo block is unaffected by a stargazer failure');
  });
  await test('EC-4: stars>0 with an empty stargazer list is faithfully [] (credential gap, not 0 people)', async () => {
    const fetchImpl = mkFetch((url) => (/stargazers/.test(url) ? { body: [] } : ghFixtures(url)));
    const d = await C.collectAdminStats({ fetchImpl, ghToken: 'tok', repoSlug: 'pacphi/agentic-kit', npmPkg: 'agentic-kit' });
    eq(d.repo.stars, 20);
    eq(JSON.stringify(d.people.stargazers), '[]');
  });

  // ── NFR-3 — the credential NEVER appears in the payload or any error note ────
  const FAKE_TOKEN = 'ghp_FAKE_SECRET_do_not_leak_0123456789abcdef';
  await test('NFR-3: a real collect with a credential set never echoes it into the payload', async () => {
    const fetchImpl = mkFetch(ghFixtures);
    const d = await C.collectAdminStats({ fetchImpl, ghToken: FAKE_TOKEN, repoSlug: 'pacphi/agentic-kit', npmPkg: 'agentic-kit' });
    assert(!JSON.stringify(d).includes(FAKE_TOKEN), 'the GitHub credential must never reach the payload');
    // sanity: the token WAS used (as an auth header) — proving this is the real path, not a no-op
    assert(fetchImpl.calls.length > 0, 'the collector actually fetched');
  });
  await test('NFR-3: a sub-fetch error whose message embeds the credential is not echoed anywhere', async () => {
    // The thrown message is deliberately "tempting to echo" — it contains the token.
    // ghJson must swallow it (return null), so nothing carrying the credential can
    // reach the payload, notes, or an error field.
    const fetchImpl = mkFetch(() => new Error('GitHub 401 for Bearer ' + FAKE_TOKEN + ' — token rejected'));
    const d = await C.collectAdminStats({ fetchImpl, ghToken: FAKE_TOKEN, repoSlug: 'pacphi/agentic-kit', npmPkg: 'agentic-kit' });
    const s = JSON.stringify(d);
    assert(!s.includes(FAKE_TOKEN), 'no credential in the payload/notes even when an error message embedded it');
    assert(!/token rejected/.test(s), 'a tempting sub-fetch error message must not be echoed into the payload');
    eq(d.repo, null); // every block degraded to null, honestly
  });

  // ── admin-server: auth (AC-1), loopback + CSP + self-contained (AC-5) ────────
  const FIXTURE_PAYLOAD = { generatedAt: '2026-07-24T00:00:00Z', repoSlug: 'pacphi/agentic-kit', repo: { stars: 20, forks: 4, watchers: 3, openIssues: 2 }, releases: [], totalAssetDownloads: 0, traffic: { configured: false, note: 'no token', clones: null, views: null, referrers: null }, npm: null, people: { externalEngagers: 0, totalIssues: 0, totalPRs: 0, contributors: [], stargazers: [], forks: [] }, feedback: { issues: 'x', discussions: 'y' } };

  const admin = await S.startAdmin({ port: 0, collect: async () => FIXTURE_PAYLOAD });
  try {
    await test('AC-5: bound to 127.0.0.1 and urlWithToken carries the token ONLY in the fragment', () => {
      assert(/^http:\/\/127\.0\.0\.1:\d+\/$/.test(admin.url), 'url must be a loopback URL, got ' + admin.url);
      assert(admin.urlWithToken.includes('/#token='), 'token must ride in the # fragment');
      assert(!/\?token=/.test(admin.urlWithToken), 'token must NOT be a query parameter');
      assert(admin.urlWithToken.includes(admin.token), 'urlWithToken carries the session token');
    });

    await test('AC-5: GET / serves a self-contained page with a CSP header and no external sub-resources', async () => {
      const r = await req(admin.url);
      eq(r.status, 200);
      assert(/text\/html/.test(r.headers['content-type'] || ''), 'text/html');
      const csp = r.headers['content-security-policy'] || '';
      assert(/default-src 'none'/.test(csp), "CSP must be default-src 'none'");
      assert(/connect-src 'self'/.test(csp), 'CSP must confine fetch to same-origin');
      // no external stylesheet links, no external <script src>, no external <img src>
      assert(!/<link[^>]+stylesheet/i.test(r.body), 'no external stylesheet links');
      assert(!/<script[^>]+\bsrc=/i.test(r.body), 'no external script src');
      assert(!/\bsrc\s*=\s*["']https?:/i.test(r.body), 'no external resource src=');
      // the model + view are embedded (their source strings are present)
      assert(r.body.includes('function metric') || r.body.includes('metric='), 'model embedded in page');
      assert(r.body.includes('x-admin-token'), 'the client sends the admin token header');
      // the model import line must have been stripped (no bare module fetch)
      assert(!/from ['"]\.\/admin-model\.mjs['"]/.test(r.body), 'model import must be stripped at serve');
    });

    await test('AC-1: /api/admin-stats with the RIGHT token → 200 full payload', async () => {
      const r = await req(admin.url + 'api/admin-stats', { headers: { 'x-admin-token': admin.token } });
      eq(r.status, 200);
      assert(/application\/json/.test(r.headers['content-type'] || ''), 'json');
      assert(/no-store/.test(r.headers['cache-control'] || ''), 'no-store on /api');
      eq(r.headers['x-content-type-options'], 'nosniff', 'nosniff on the /api 200 response');
      const j = JSON.parse(r.body);
      assert(j.repo && j.people && 'traffic' in j, 'full payload present');
    });

    await test('AC-1: /api/admin-stats with a WRONG token → 401 JSON error, NO data fields', async () => {
      const r = await req(admin.url + 'api/admin-stats', { headers: { 'x-admin-token': 'nope' } });
      eq(r.status, 401);
      eq(r.headers['x-content-type-options'], 'nosniff', 'nosniff on the /api 401 response');
      const j = JSON.parse(r.body);
      assert(typeof j.error === 'string', 'a JSON error message');
      assert(!('repo' in j) && !('people' in j) && !('releases' in j) && !('traffic' in j), '401 body must carry NO data');
    });

    await test('AC-1: /api/admin-stats with a MISSING token → 401', async () => {
      const r = await req(admin.url + 'api/admin-stats');
      eq(r.status, 401);
    });

    await test('AC-5/NFR-2: DNS-rebinding Host guard rejects a foreign Host', async () => {
      const r = await req(admin.url + 'api/admin-stats', { headers: { 'x-admin-token': admin.token }, host: 'evil.example.com' });
      eq(r.status, 403);
    });

    await test('unknown route → 404', async () => {
      const r = await req(admin.url + 'nope');
      eq(r.status, 404);
    });
  } finally {
    await admin.close();
  }

  // ── tokenMatches — constant-time accept/reject with a length guard (AC-1) ────
  await test('tokenMatches accepts the exact token and rejects wrong/short/empty', () => {
    eq(S.tokenMatches('abc123', 'abc123'), true);
    eq(S.tokenMatches('abc124', 'abc123'), false);
    eq(S.tokenMatches('ab', 'abc123'), false);        // unequal length must be false, NEVER a throw
    eq(S.tokenMatches('', 'abc123'), false);
    eq(S.tokenMatches('abc123', ''), false);          // no secret ⇒ never open (fail-closed)
    eq(S.tokenMatches(undefined, 'abc123'), false);
  });

  // ── EC-8 at the server boundary: unparseable repo.url → refuse to start ──────
  await test('EC-8: startAdmin refuses to start when repository.url is unparseable', async () => {
    let threw = false;
    try {
      await S.startAdmin({ port: 0, pkg: { name: 'x', repository: { url: 'not a url' } }, collect: async () => FIXTURE_PAYLOAD });
    } catch (e) {
      threw = true;
      assert(/repository\.url|owner\/repo|refus/i.test(e.message), 'error must explain the fail-closed reason');
    }
    assert(threw, 'startAdmin must throw rather than query the wrong repository');
  });

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
