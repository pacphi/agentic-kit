// O-5 / O-8: a local model with no recorded cost is left UNPRICED and flagged —
// never charged the $3/$15 fallback rate a model this table does not know gets —
// and a completed response that carried no token counts is distinguishable from
// one that used none. Hermetic: pure functions, plus fixture opencode.db files
// in tmp dirs; the real stores are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isLocalInferenceProvider } from '../../src/lib/usage-local-provider.mjs';
import { rowCostEvidence, sessionCostEvidence } from '../../src/lib/usage-cost.mjs';
import { costOf } from '../../src/lib/pricing.mjs';
import { parseSession } from '../../src/lib/usage-opencode.mjs';
import { buildIndex, _resetForTest } from '../../src/lib/usage-index.mjs';

const NOW = Date.parse('2026-07-29T12:00:00Z');
const DAY = 86_400_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ulp-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const deps = { costOf };

const MILLION = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };

test('local providers are recognized by id, however the user spelled it; hosted ones are not', () => {
  for (const id of ['lmstudio', 'LM Studio', 'ollama', 'Ollama', 'llama.cpp', 'llamacpp', 'llama-cpp', 'local-openai']) {
    assert.equal(isLocalInferenceProvider(id), true, id);
  }
  for (const id of ['openrouter', 'anthropic', 'openai', 'opencode', 'moonshotai', '', null, undefined, 42]) {
    assert.equal(isLocalInferenceProvider(id), false, String(id));
  }
});

test('an unrecorded-cost row on a local provider is unpriced and flagged, not charged the fallback rate', () => {
  const row = { day: '2026-07-28', model: 'qwen/qwen3-coder-30b', provider: 'lmstudio', ...MILLION, responses: 3,
    costObserved: null, costMissingUsage: { ...MILLION, responses: 3 } };
  const evidence = rowCostEvidence(row, { provider: 'opencode' }, deps);
  assert.equal(evidence.estimatedUsd, 0, 'no invented $18 (1M in x $3 + 1M out x $15)');
  assert.equal(evidence.observedUsd, 0);
  assert.equal(evidence.estimatedMessages, 0);
  assert.equal(evidence.unpricedMessages, 3, 'the gap is reported as coverage, not hidden as a zero');
});

test('the same model on a hosted provider is still estimated (the fallback rate is unchanged there)', () => {
  const row = { day: '2026-07-28', model: 'qwen/qwen3-coder-30b', provider: 'openrouter', ...MILLION, responses: 1,
    costObserved: null };
  const evidence = rowCostEvidence(row, { provider: 'opencode' }, deps);
  assert.equal(evidence.estimatedUsd, 18);
  assert.equal(evidence.unpricedMessages, 0);
});

test('a reported cost of 0 from a local provider stays an observed zero, not unpriced', () => {
  const row = { day: '2026-07-28', model: 'openai/gpt-oss-20b', provider: 'lmstudio', ...MILLION, responses: 2,
    costObserved: 0, costObservedMessages: 2 };
  const evidence = rowCostEvidence(row, { provider: 'opencode' }, deps);
  assert.deepEqual(evidence, { observedUsd: 0, estimatedUsd: 0, observedMessages: 2, estimatedMessages: 0, unpricedMessages: 0 });
});

test('a mixed row prices only its hosted missing-cost portion; the local portion is flagged', () => {
  const local = { day: '2026-07-28', model: 'm', provider: 'ollama', input: 10, output: 10, cacheRead: 0, cacheWrite: 0, responses: 1,
    costObserved: null, costMissingUsage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, responses: 1 } };
  const rec = { provider: 'opencode', usage: [local, { ...local, provider: 'openrouter', model: 'unknown-hosted' }] };
  const total = sessionCostEvidence(rec, deps);
  assert.equal(total.unpricedMessages, 1);
  assert.equal(total.estimatedMessages, 1);
  assert.ok(total.estimatedUsd > 0);
});

// ── through the index, with the real pricing table ──────────────────────────

function buildDb(file, messages) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text, parent_id text, slug text, directory text NOT NULL,
      title text NOT NULL, version text, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('ses_l', 'p', null, 's', '/x', 'local run', '1.18.9', NOW - DAY, NOW - DAY);
  const ins = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  for (const m of messages) ins.run(m.id, 'ses_l', m.at, m.at, JSON.stringify(m.data));
  db.close();
}

const assistant = (at, { provider, tokens, cost, error, completed = at + 500 }) => ({
  id: `a${at}`, at,
  data: {
    role: 'assistant', modelID: 'qwen/qwen3-coder-30b', providerID: provider, tokens,
    ...(cost !== undefined ? { cost } : {}), ...(error ? { error } : {}),
    time: { created: at, ...(completed ? { completed } : {}) },
  },
});
const T0 = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

function scanFixture(messages) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'claude'));
  fs.mkdirSync(path.join(dir, 'codex'));
  const dbFile = path.join(dir, 'opencode.db');
  buildDb(dbFile, messages);
  const opts = {
    days: 14, now: NOW, cachePath: path.join(dir, 'cache', 'usage-index.json'),
    roots: { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex'), opencode: dbFile },
  };
  return { dir, dbFile, opts };
}

test('a local session with no recorded cost reads $0 with unpriced coverage through a real scan', async () => {
  _resetForTest();
  const at = NOW - DAY;
  const fx = scanFixture([
    { id: 'u1', at, data: { role: 'user', time: { created: at } } },
    assistant(at + 10, { provider: 'lmstudio', tokens: { ...T0, input: 1_000_000, output: 1_000_000, cache: { read: 500_000, write: 0 } } }),
  ]);
  try {
    const agg = await buildIndex(fx.opts);
    const s = agg.sessions.find((x) => x.id === 'ses_l');
    assert.equal(s.cost, 0, 'not the $18 fallback the model id alone used to draw');
    assert.equal(s.costEvidence.unpricedMessages, 1);
    assert.equal(agg.totals.cost, 0);
    assert.equal(s.cacheSavedUsd ?? 0, 0, 'no cache saving is quoted against a rate that was never applied');
  } finally { _resetForTest(); rm(fx.dir); }
});

// ── O-8: usage not reported vs. zero usage ──────────────────────────────────

const parse = (messages) => {
  const fx = scanFixture(messages);
  try { return parseSession({ dbFile: fx.dbFile, id: 'ses_l' }).session; } finally { rm(fx.dir); }
};

test('a completed, error-free response with all-zero tokens is marked usage-not-reported on its row', () => {
  const at = NOW - DAY;
  const session = parse([
    { id: 'u1', at, data: { role: 'user', time: { created: at } } },
    assistant(at + 10, { provider: 'lmstudio', tokens: T0, cost: 0 }),
    assistant(at + 20_000, { provider: 'lmstudio', tokens: { ...T0, input: 50, output: 5 }, cost: 0 }),
  ]);
  const row = session.usage[0];
  assert.equal(row.tokensUnreported, 1, 'only the all-zero completed response');
  assert.equal(row.responses, 2);
  assert.equal(row.costObserved, 0, 'the reported cost of 0 is untouched');
});

test('an in-flight, errored or aborted zero-token row is not called "not reported"', () => {
  const at = NOW - DAY;
  const session = parse([
    { id: 'u1', at, data: { role: 'user', time: { created: at } } },
    assistant(at + 10, { provider: 'lmstudio', tokens: T0, completed: null }),
    assistant(at + 20, { provider: 'lmstudio', tokens: T0, error: { name: 'APIError' } }),
    assistant(at + 30, { provider: 'lmstudio', tokens: T0, error: { name: 'MessageAbortedError' } }),
  ]);
  assert.equal('tokensUnreported' in session.usage[0], false);
});

test('the scan raises one usage-not-reported warning on OpenCode source health', async () => {
  _resetForTest();
  const at = NOW - DAY;
  const fx = scanFixture([
    { id: 'u1', at, data: { role: 'user', time: { created: at } } },
    assistant(at + 10, { provider: 'lmstudio', tokens: T0, cost: 0 }),
    assistant(at + 30_000, { provider: 'lmstudio', tokens: T0, cost: 0 }),
  ]);
  try {
    const agg = await buildIndex(fx.opts);
    const warnings = agg.sourceHealth.opencode.diagnostics.common.warnings;
    assert.deepEqual(warnings, ['usage-not-reported:2']);
    assert.equal(agg.sourceHealth.opencode.status, 'ok', 'informational, not a degraded source');
  } finally { _resetForTest(); rm(fx.dir); }
});

test('a scan with every response reporting tokens raises no warning', async () => {
  _resetForTest();
  const at = NOW - DAY;
  const fx = scanFixture([
    { id: 'u1', at, data: { role: 'user', time: { created: at } } },
    assistant(at + 10, { provider: 'openrouter', tokens: { ...T0, input: 5, output: 5 }, cost: 0.01 }),
  ]);
  try {
    const agg = await buildIndex(fx.opts);
    assert.deepEqual(agg.sourceHealth.opencode.diagnostics.common.warnings, []);
  } finally { _resetForTest(); rm(fx.dir); }
});
