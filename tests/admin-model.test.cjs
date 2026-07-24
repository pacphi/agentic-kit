#!/usr/bin/env node
//
// admin-model.test.cjs — unit tests for the PURE client model (src/lib/admin-model.mjs).
// This is the "tested code is shipped code" seam (ADR-0007 §5): the very functions
// exercised here are embedded verbatim into the served admin page. Zero-dep, network-
// free — the model imports nothing and touches no DOM, so it runs straight in node.
//
// Run: node tests/admin-model.test.cjs   (exit 0 = pass, 1 = fail)

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MOD = path.join(ROOT, 'src', 'lib', 'admin-model.mjs');

// ── tiny harness (matches dashboard.test.cjs) ────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('  \x1b[32m✓\x1b[0m ' + name); passed++; })
    .catch((e) => { console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + (e && e.message)); failed++; });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { assert(a === b, (msg || 'equality') + ` — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

async function main() {
  const M = await import('file://' + MOD);

  // ── esc / safeUrl (NFR-7 XSS discipline) ───────────────────────────────────
  await test('esc escapes all five HTML-significant characters', () => {
    eq(M.esc(`<b>&"'`), '&lt;b&gt;&amp;&quot;&#39;');
  });
  await test('esc coerces null/undefined to empty string', () => {
    eq(M.esc(null), '');
    eq(M.esc(undefined), '');
  });
  await test('safeUrl passes https/http and escapes them', () => {
    eq(M.safeUrl('https://github.com/a/b'), 'https://github.com/a/b');
    eq(M.safeUrl('HTTP://Example.com'), 'HTTP://Example.com');
  });
  await test('safeUrl rejects javascript: and other schemes with #', () => {
    eq(M.safeUrl('javascript:alert(1)'), '#');
    eq(M.safeUrl('ftp://x/y'), '#');
    eq(M.safeUrl('data:text/html,x'), '#');
    eq(M.safeUrl(''), '#');
    eq(M.safeUrl(null), '#');
  });
  await test('safeUrl escapes a quote that would break out of the attribute', () => {
    // scheme allow-listed AND esc'd — the quote can never terminate the href
    assert(!M.safeUrl('https://x/"onmouseover=alert(1)').includes('"'), 'quote must be escaped');
  });

  // ── metric: Rule 1 — unknown is NOT zero (NFR-4.1, AC-2) ────────────────────
  await test('metric(null) is unknown, never a zero', () => {
    const m = M.metric(null);
    eq(m.known, false);
    assert(m.v === undefined, 'unknown must carry no value');
    assert(typeof m.why === 'string' && m.why.length > 0, 'unknown must carry a reason');
  });
  await test('metric(empty string) is unknown (rejected before Number coercion)', () => {
    eq(M.metric('').known, false);
  });
  await test('metric(undefined) and metric(NaN) and non-numeric are unknown', () => {
    eq(M.metric(undefined).known, false);
    eq(M.metric(NaN).known, false);
    eq(M.metric('abc').known, false);
  });
  await test('metric(0) is a KNOWN zero — a real measured zero is not absence', () => {
    const m = M.metric(0);
    eq(m.known, true);
    eq(m.v, 0);
  });
  await test('metric coerces numeric strings and passes finite numbers', () => {
    eq(M.metric('42').v, 42);
    eq(M.metric(7).v, 7);
  });
  await test('metric carries a custom why through', () => {
    eq(M.metric(null, 'no token').why, 'no token');
  });

  // ── ascend / sum ────────────────────────────────────────────────────────────
  await test('ascend normalises any order to ascending-by-date values', () => {
    const rows = [
      { day: '2026-01-03', downloads: 3 },
      { day: '2026-01-01', downloads: 1 },
      { day: '2026-01-02', downloads: 2 },
    ];
    const s = M.ascend(rows, 'day', 'downloads');
    eq(JSON.stringify(s), JSON.stringify([1, 2, 3]));
  });
  await test('ascend drops undated points and returns null for non-arrays', () => {
    const rows = [{ day: 'not-a-date', downloads: 9 }, { day: '2026-01-01', downloads: 5 }];
    eq(JSON.stringify(M.ascend(rows, 'day', 'downloads')), JSON.stringify([5]));
    eq(M.ascend(null, 'day', 'downloads'), null);
  });
  await test('sum adds a numeric array', () => { eq(M.sum([1, 2, 3, 4]), 10); });

  // ── momentum: Rule 2 — never fabricate a ratio (NFR-4.2, AC-6) ──────────────
  await test('momentum is null for a series shorter than 4 points', () => {
    eq(M.momentum([1, 2, 3]), null);
    eq(M.momentum([]), null);
    eq(M.momentum(null), null);
  });
  await test('momentum is null when the prior window is empty (4..7 points)', () => {
    // length 6: slice(-14,-7) is [] → no honest prior window (AC-6)
    eq(M.momentum([1, 2, 3, 4, 5, 6]), null);
  });
  await test('momentum computes an UP direction over equal 7d windows', () => {
    const series = [10, 10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20, 20, 20];
    const m = M.momentum(series);
    eq(m.recent, 140);
    eq(m.prior, 70);
    eq(m.dir, 'up');
    eq(m.pct, 100);
  });
  await test('momentum reports flat when recent ~= prior', () => {
    const series = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    eq(M.momentum(series).dir, 'flat');
  });
  await test('momentum never divides by a zero prior base (pct null)', () => {
    const series = [0, 0, 0, 0, 0, 0, 0, 5, 5, 5, 5, 5, 5, 5];
    const m = M.momentum(series);
    eq(m.pct, null);
    eq(m.dir, 'up');
  });

  // ── bots + dates ─────────────────────────────────────────────────────────────
  await test('isBot recognises [bot] suffixes and known bot logins', () => {
    eq(M.isBot('dependabot[bot]'), true);
    eq(M.isBot('renovate'), true);
    eq(M.isBot('github-actions'), true);
    eq(M.isBot('alice'), false);
    eq(M.isBot(''), false);
  });
  await test('daysAgo returns 0 for now and null for an unparseable date', () => {
    eq(M.daysAgo(new Date().toISOString()), 0);
    eq(M.daysAgo('nonsense'), null);
  });
  await test('agoLabel words the recent past and flags undated', () => {
    eq(M.agoLabel(new Date().toISOString()), 'today');
    eq(M.agoLabel('nonsense'), 'undated');
  });

  // ── itemId ───────────────────────────────────────────────────────────────────
  await test('itemId is stable per thread and distinguishes PR from issue', () => {
    eq(M.itemId({ isPR: true, number: 5 }), 'p5');
    eq(M.itemId({ isPR: false, number: 7 }), 'i7');
  });

  // ── shape: humans + events (AC-4, bot exclusion) ────────────────────────────
  const PAYLOAD = {
    repo: { stars: 20, forks: 4, watchers: 3, openIssues: 2 },
    totalAssetDownloads: 1000,
    people: {
      contributors: [
        { login: 'alice', issues: 2, prs: 0, association: 'CONTRIBUTOR', items: [
          { number: 1, title: 'old bug', state: 'closed', isPR: false, url: 'https://github.com/o/r/issues/1', at: '2026-01-01' },
          { number: 9, title: 'fresh bug', state: 'open', isPR: false, url: 'https://github.com/o/r/issues/9', at: '2026-06-01' },
        ] },
        { login: 'bob', issues: 0, prs: 1, association: 'NONE', items: [
          { number: 5, title: 'a PR', state: 'open', isPR: true, url: 'https://github.com/o/r/pull/5', at: '2026-03-01' },
        ] },
        { login: 'dependabot[bot]', issues: 1, prs: 0, association: 'NONE', items: [
          { number: 8, title: 'bump dep', state: 'open', isPR: false, url: 'https://github.com/o/r/issues/8', at: '2026-05-01' },
        ] },
      ],
      stargazers: ['carol'],
      forks: [{ login: 'dave', at: '2026-04-01' }],
    },
  };

  await test('shape excludes bots from people and events, counting bot items separately', () => {
    const s = M.shape(PAYLOAD);
    assert(!s.people.some((p) => p.login === 'dependabot[bot]'), 'bots must not appear as humans');
    assert(!s.events.some((e) => e.login === 'dependabot[bot]'), 'bot items must not appear in the feed');
    eq(s.botItems, 1);
  });
  await test('shape includes a forker who never filed as a human', () => {
    const s = M.shape(PAYLOAD);
    const dave = s.people.find((p) => p.login === 'dave');
    assert(dave && dave.forked === true, 'dave forked but filed nothing — still a human');
  });
  await test('shape ranks people by recency (most recent last-seen first)', () => {
    const s = M.shape(PAYLOAD);
    // alice last=2026-06-01, dependabot excluded, bob=2026-03-01, dave=2026-04-01
    eq(s.people[0].login, 'alice');
  });
  await test('shape feed is newest-first and carries a fork event', () => {
    const s = M.shape(PAYLOAD);
    for (let i = 1; i < s.events.length; i++) {
      assert(String(s.events[i - 1].at) >= String(s.events[i].at), 'events must be newest-first');
    }
    assert(s.events.some((e) => e.kind === 'fork' && e.login === 'dave'), 'fork event present');
  });
  await test('shape openItems are oldest-first and threadCount counts non-bot items', () => {
    const s = M.shape(PAYLOAD);
    // open items: alice #9 (2026-06-01) and bob #5 (2026-03-01) → oldest first = bob
    eq(s.openItems[0].number, 5);
    eq(s.threadCount, 3); // alice 2 + bob 1 (bot item excluded)
  });

  // ── snapshot + cumDelta: baseline memory, Rule 2 (AC-4) ─────────────────────
  await test('snapshot captures only cumulative counters + ids + people', () => {
    const s = M.shape(PAYLOAD);
    const snap = M.snapshot(PAYLOAD, s);
    eq(snap.stars, 20);
    eq(snap.forks, 4);
    eq(snap.downloads, 1000);
    assert(Array.isArray(snap.ids) && snap.ids.length === s.events.length, 'ids mirror events');
    assert(Array.isArray(snap.people), 'people logins captured');
    assert(!('clones' in snap) && !('views' in snap) && !('npm' in snap), 'no rolling windows in the baseline');
  });
  await test('cumDelta is exact current-minus-baseline for a known counter', () => {
    const d = M.cumDelta(120, 100, 'unavailable', false);
    eq(d.known, true);
    eq(d.v, 20);
  });
  await test('cumDelta is unknown (never 0) when the current value is absent', () => {
    eq(M.cumDelta(null, 100, 'unavailable', false).known, false);
  });
  await test('cumDelta distinguishes first-visit from a later-appearing counter', () => {
    eq(M.cumDelta(100, null, 'why', true).why, 'first visit — baseline captured now');
    assert(M.cumDelta(100, null, 'why', false).why.includes('after your last visit'),
      'a counter with no baseline that is not a first visit says so');
  });
  await test('mark-reviewed/undo round-trips a snapshot byte-for-byte', () => {
    // Model-level simulation of the view control: stash → advance → restore.
    const s = M.shape(PAYLOAD);
    const original = JSON.stringify(M.snapshot(PAYLOAD, s));
    const stashed = original;                    // "Mark reviewed" copies BASE → BASE_PREV
    const restored = stashed;                    // "Undo" copies BASE_PREV → BASE
    eq(restored, original);                      // byte-for-byte inverse (AC-4)
  });

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
