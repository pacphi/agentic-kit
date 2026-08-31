// POST /api/prompts/dismiss + /api/prompts/undismiss — the dashboard's ONE
// non-inference write (Coaching redesign §4.3, ADR-0039 amendment 3). The
// id-validation and no-write guarantees are asserted FIRST: a malformed id
// never touches the ledger file; an unknown-but-valid id is a 404 with no write;
// the write is atomic and never holds prompt text; dismiss is idempotent and
// undismiss reverses it. Token-gated + loopback-only like every /api/ route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard } from '../../src/lib/dashboard-server.mjs';
import { loadLedger as realLoadLedger, saveLedger as realSaveLedger } from '../../src/lib/usage-outcome-ledger.mjs';
import { RELEASE_RITUAL_MIN_COUNT } from '../../src/lib/usage-coaching-rules.mjs';

const CARD_ID = 'release-ritual-skill';

// A canonical aggregate whose one cluster fires the release-ritual rule, so
// `deriveCards` proposes CARD_ID — the id the dismiss endpoint validates against.
// Text-free by construction (promptPatterns carries hashes/counts, never text).
function canonicalAgg() {
  return {
    promptPatterns: {
      clusters: [{
        key: 'k1', kind: 'instruction', label: { name: 'Release ritual', source: 'seed' },
        class: 'instruction', count: RELEASE_RITUAL_MIN_COUNT, sessions: 5, days: 3,
        hosts: ['claude'], medianTokens: 8, sampleSessionIds: ['s1'],
      }],
      reAsks: { pairCount: 0, sessionCount: 0, gapHist: {} },
      exactRepeats: [], tapLengths: [], provenance: {}, corpus: { fingerprints: 5, typed: 5 },
    },
    promptsByHost: null, promptBaselines: null, insights: [],
  };
}

const NULL_LABEL_STORE = {
  loadLabelStore: () => ({ version: 1, labels: {}, cards: {} }), labelStorePath: '/dev/null/unused',
};

function post(base, pathname, body, { token } = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const u = new URL(base + pathname);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
        ...(token ? { 'x-dash-token': token } : {}),
      },
    }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function ledgerDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-dismiss-'));
  return { dir, ledgerPath: path.join(dir, 'usage-outcome-ledger.json') };
}

async function startWith(lg, { readIndex } = {}) {
  return startDashboard({
    port: 0,
    fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    usage: { readIndex: readIndex ?? (async () => canonicalAgg()) },
    coachingLedger: { loadLedger: realLoadLedger, saveLedger: realSaveLedger, ledgerPath: lg.ledgerPath },
    labelStore: NULL_LABEL_STORE,
    cwd: lg.dir, // no CLAUDE.md/skills here → empty adoption inputs, deterministic
  });
}

const readLedger = (lg) => JSON.parse(fs.readFileSync(lg.ledgerPath, 'utf8'));

// ── id validation: a malformed id never touches the ledger file ──────────────

test('a malformed id is rejected 400 and never touches the ledger file', async () => {
  const lg = ledgerDir();
  fs.writeFileSync(lg.ledgerPath, JSON.stringify({ version: 1, records: [] }));
  const before = fs.statSync(lg.ledgerPath);
  const srv = await startWith(lg);
  try {
    for (const bad of ['../../etc/passwd', 'Bad-Upper', 'has space', 'trailing-', '', '..', 'a/b', 42, null]) {
      const r = await post(srv.url, 'api/prompts/dismiss', { id: bad }, { token: srv.token });
      assert.equal(r.status, 400, `expected 400 for id ${JSON.stringify(bad)}, got ${r.status}`);
      assert.equal(JSON.parse(r.body).error, 'invalid card id');
    }
    // Also a body that is not even an object.
    const r = await post(srv.url, 'api/prompts/dismiss', 'not json', { token: srv.token });
    assert.equal(r.status, 400);
    const after = fs.statSync(lg.ledgerPath);
    assert.equal(after.size, before.size, 'the ledger bytes are unchanged');
    assert.equal(after.mtimeMs, before.mtimeMs, 'the ledger mtime is unchanged — no write happened');
    assert.deepEqual(readLedger(lg).records, [], 'no record was written');
  } finally {
    await srv.close();
  }
});

test('an unknown but well-formed id is a 404 with no write', async () => {
  const lg = ledgerDir();
  fs.writeFileSync(lg.ledgerPath, JSON.stringify({ version: 1, records: [] }));
  const before = fs.statSync(lg.ledgerPath);
  // readIndex returns an EMPTY projection → deriveCards proposes nothing.
  const srv = await startWith(lg, { readIndex: async () => ({ promptPatterns: { clusters: [] }, promptsByHost: null, promptBaselines: null, insights: [] }) });
  try {
    const r = await post(srv.url, 'api/prompts/dismiss', { id: 'commit-push-claude-md' }, { token: srv.token });
    assert.equal(r.status, 404, r.body);
    assert.equal(JSON.parse(r.body).error, 'unknown card');
    const after = fs.statSync(lg.ledgerPath);
    assert.equal(after.mtimeMs, before.mtimeMs, 'an unknown card never writes the ledger');
    assert.deepEqual(readLedger(lg).records, []);
  } finally {
    await srv.close();
  }
});

// ── persistence, idempotency, atomicity, and the no-text invariant ───────────

test('a proposable card is dismissed, persisted, and the write holds no prompt text', async () => {
  const lg = ledgerDir();
  const srv = await startWith(lg);
  try {
    const r = await post(srv.url, 'api/prompts/dismiss', { id: CARD_ID }, { token: srv.token });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { id: CARD_ID, status: 'dismissed' });

    const ledger = readLedger(lg);
    const rec = ledger.records.find((x) => x.id === CARD_ID);
    assert.ok(rec, 'a record was persisted for the dismissed card');
    assert.equal(rec.status, 'dismissed');
    assert.equal(rec.windowDays, 30, 'a canonical-window record');

    // The write is atomic (tmp + rename) — no leftover temp file remains.
    assert.deepEqual(fs.readdirSync(lg.dir), ['usage-outcome-ledger.json'], 'no tmp file left behind');

    // The ledger holds the id, evidence hash, counts and timestamps ONLY — never
    // the card's human-readable finding/basis/draft text (§4.3: no prompt text on
    // this path). The id itself ('release-ritual-skill') is legitimately stored,
    // so the fragments checked here are card TEXT that must not be, not the id.
    const raw = fs.readFileSync(lg.ledgerPath, 'utf8');
    for (const fragment of ['recurrences', 'across', 'Release ritual', 'CLAUDE.md', 'draft']) {
      assert.ok(!raw.includes(fragment), `card text leaked into the ledger: ${JSON.stringify(fragment)}`);
    }
  } finally {
    await srv.close();
  }
});

test('dismissing twice is idempotent — one record, no dismiss-count inflation', async () => {
  const lg = ledgerDir();
  const srv = await startWith(lg);
  try {
    await post(srv.url, 'api/prompts/dismiss', { id: CARD_ID }, { token: srv.token });
    const afterFirst = readLedger(lg);
    const firstRec = afterFirst.records.find((x) => x.id === CARD_ID);
    assert.equal(firstRec.dismissCount, 1);

    const r2 = await post(srv.url, 'api/prompts/dismiss', { id: CARD_ID }, { token: srv.token });
    assert.equal(r2.status, 200);
    const afterSecond = readLedger(lg);
    assert.equal(afterSecond.records.filter((x) => x.id === CARD_ID).length, 1, 'still exactly one record');
    assert.equal(afterSecond.records.find((x) => x.id === CARD_ID).dismissCount, 1,
      'a re-dismiss does not bump the count toward a permanent dismissal');
  } finally {
    await srv.close();
  }
});

test('undismiss reverses a dismissal; the card is proposable again', async () => {
  const lg = ledgerDir();
  const srv = await startWith(lg);
  try {
    await post(srv.url, 'api/prompts/dismiss', { id: CARD_ID }, { token: srv.token });
    assert.ok(readLedger(lg).records.some((x) => x.id === CARD_ID && x.status === 'dismissed'));

    const r = await post(srv.url, 'api/prompts/undismiss', { id: CARD_ID }, { token: srv.token });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { id: CARD_ID, status: 'active' });
    assert.ok(!readLedger(lg).records.some((x) => x.id === CARD_ID),
      'the dismissed record is removed — the next reconcile re-proposes it fresh');

    // Nothing to undo → 404, no write.
    const before = fs.statSync(lg.ledgerPath);
    const again = await post(srv.url, 'api/prompts/undismiss', { id: CARD_ID }, { token: srv.token });
    assert.equal(again.status, 404, again.body);
    assert.equal(fs.statSync(lg.ledgerPath).mtimeMs, before.mtimeMs, 'a no-op undo never writes');
  } finally {
    await srv.close();
  }
});

test('a re-dismiss after an undo starts fresh at dismiss-count one', async () => {
  const lg = ledgerDir();
  const srv = await startWith(lg);
  try {
    await post(srv.url, 'api/prompts/dismiss', { id: CARD_ID }, { token: srv.token });
    await post(srv.url, 'api/prompts/undismiss', { id: CARD_ID }, { token: srv.token });
    await post(srv.url, 'api/prompts/dismiss', { id: CARD_ID }, { token: srv.token });
    const rec = readLedger(lg).records.find((x) => x.id === CARD_ID);
    assert.equal(rec.status, 'dismissed');
    assert.equal(rec.dismissCount, 1, 'undo genuinely reset the dismissal history');
  } finally {
    await srv.close();
  }
});

// ── the same gates as every /api/ route ──────────────────────────────────────

test('the write endpoints are token-gated and reject other methods', async () => {
  const lg = ledgerDir();
  const srv = await startWith(lg);
  try {
    const noToken = await post(srv.url, 'api/prompts/dismiss', { id: CARD_ID });
    assert.equal(noToken.status, 401, 'no token → unauthorized, never a write');
    assert.ok(!fs.existsSync(lg.ledgerPath), 'the unauthorized attempt never created the ledger');

    // A GET on a write route is not a write route — it 404s (not in the GET table).
    const getIt = await new Promise((resolve, reject) => {
      http.get(`${srv.url}api/prompts/dismiss?token=${srv.token}`, (res) => {
        let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }).on('error', reject);
    });
    assert.equal(getIt.status, 404, 'GET on a write route is not handled as a write');

    // An unknown POST target is refused (405), never silently accepted.
    const bogus = await post(srv.url, 'api/prompts/frobnicate', { id: CARD_ID }, { token: srv.token });
    assert.equal(bogus.status, 405);
  } finally {
    await srv.close();
  }
});
