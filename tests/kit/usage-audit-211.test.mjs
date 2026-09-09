import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { parseSession } from '../../src/lib/usage-opencode.mjs';
import { aggregate, sessionPayload } from '../../src/lib/usage-aggregate.mjs';
import { parseCodex } from '../../src/lib/usage-parsers.mjs';
import { HOST_REGISTRY } from '../../src/lib/adapters/registries.mjs';
const T = Date.parse('2026-09-09T12:00:00Z');
const deps = { costOf: ({ input }) => input * 4 / 1e6, classify: () => ({}), detectInsights: () => [] };
function fixture(t, costs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-cost-211-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbFile = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE session(id TEXT, directory TEXT, title TEXT, parent_id TEXT, time_created INTEGER);
    CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part(id TEXT, message_id TEXT, data TEXT);`);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, NULL, ?)').run('s', '/synthetic', 'costs', T);
  for (const [i, cost] of costs.entries()) db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(String(i), 's', T + i * 1000,
    JSON.stringify({ role: 'assistant', modelID: 'gpt-5.6-sol', tokens: { input: 1e6 }, ...(cost === undefined ? {} : { cost }) }));
  db.close();
  return parseSession({ dbFile, id: 's' }).session;
}
for (const cost of [undefined, null, -1, '0', false, {}, [], 'invalid']) {
  test(`missing or invalid cost ${JSON.stringify(cost)} is estimated`, t => {
    const rec = fixture(t, [cost]);
    assert.equal(sessionPayload(rec, [], deps).meta.cost, 4);
    assert.equal(rec.usage[0].costObserved, null);
  });
}
for (const costs of [[0], [0.25, undefined], [undefined, 0.25], [null, 0.25], [0.25, null]]) {
  test(`observed cost and missing coverage survive coalescing ${JSON.stringify(costs)}`, t => {
    const rec = fixture(t, costs);
    const expected = costs.length === 1 ? 0 : 4.25;
    const meta = sessionPayload(rec, [], deps).meta;
    const agg = aggregate([rec], { days: 1, now: T + 10000, cutoff: T - 1000, deps });
    assert.equal(meta.cost, expected);
    assert.equal(agg.totals.cost, expected);
    assert.equal(meta.costEvidence.observedUsd, costs.length === 1 ? 0 : 0.25);
    assert.equal(meta.costEvidence.estimatedUsd, costs.length === 1 ? 0 : 4);
    assert.deepEqual(agg.sessions[0].costEvidence, meta.costEvidence);
  });
}
const js = fs.readFileSync(new URL('../../src/lib/dashboard/client/usage.mjs', import.meta.url), 'utf8');
const snippet = js.slice(js.indexOf('  function ctxChip(sx){'), js.indexOf('  function sessionChips(sx){'));
const ctxChip = vm.runInNewContext(`(${snippet.trim()})`, { esc: String, fmtTok: String });
function context(records) {
  return parseCodex(records.map(payload => JSON.stringify({ type: 'event_msg', timestamp: new Date(T).toISOString(), payload })).join('\n'), { id: 'ctx' }).session;
}
const count = (input, window) => ({ type: 'token_count', info: { last_token_usage: { input_tokens: input }, ...(window ? { model_context_window: window } : {}) } });
test('context chip omits separately observed numerator and window and legacy-only values', () => {
  assert.equal(ctxChip(context([{ type: 'task_started', model_context_window: 200000 }, count(100000)])), '');
  assert.equal(ctxChip({ ctxLastTokens: 100000, ctxWindow: 200000 }), '');
  assert.equal(ctxChip({}), '');
});
test('paired context percentage preserves over-window and zero pressure', () => {
  assert.match(ctxChip(context([count(250000, 200000)])), /125%/);
  assert.match(ctxChip({ contextEvidence: { pressure: { lastBps: 0 } } }), /0%/);
});
test('later unpaired observations do not fabricate a new ratio', () => {
  const rec = context([count(100000, 200000), { type: 'task_started', model_context_window: 400000 }, count(300000)]);
  assert.match(ctxChip(rec), /50%/);
  assert.doesNotMatch(ctxChip(rec), /75%/);
});
test('OpenCode descriptor advertises its SQLite usage collection', t => {
  assert.equal(HOST_REGISTRY.find(h => h.id === 'opencode').capabilities.usage, true);
  assert.equal(fixture(t, [0.25]).usage.length, 1);
});

test('cost estimates use each missing portion model and day in both payloads', () => {
  const rec = parseCodex('', { id: 'days' }).session;
  Object.assign(rec, { start: T, end: T + 86400000, responses: 3, models: ['a', 'b'], usage: [
    { day: '2026-09-09', model: 'a', input: 30, output: 0, cacheRead: 0, cacheWrite: 0, responses: 2,
      costObserved: 0.25, costObservedMessages: 1, costMissingUsage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, responses: 1 } },
    { day: '2026-09-10', model: 'b', input: 20, output: 0, cacheRead: 0, cacheWrite: 0, responses: 1 },
  ] });
  const datedDeps = { ...deps, costOf: ({ model, day, input }) => input * (model === 'a' && day === '2026-09-09' ? 2 : 3) };
  const meta = sessionPayload(rec, [], datedDeps).meta;
  const agg = aggregate([rec], { days: 2, now: T + 2 * 86400000, cutoff: T - 1, deps: datedDeps });
  assert.equal(meta.cost, 80.25);
  assert.equal(agg.byDay['2026-09-09'].cost, 20.25);
  assert.equal(agg.byModel.b.cost, 60);
  assert.equal(agg.totals.cost, meta.cost);
});
test('oversized omitted session retains explicit aggregate and reader coverage', () => {
  const rec = parseCodex('', { id: 'oversized' }).session;
  rec.acquisitionCoverage = { complete: false, truncated: true, reason: 'byte-limit' };
  const agg = aggregate([rec], { days: 1, now: T, cutoff: T - 86400000, deps });
  assert.equal(agg.sessions.length, 0);
  assert.equal(agg.acquisitionCoverage.omittedSessions, 1);
  assert.equal(sessionPayload(rec, [], deps).meta.acquisitionCoverage.complete, false);
});
