// codex-state.mjs — Codex's SQLite thread ledger, tested against fixture dbs
// built with the same node:sqlite the reader uses. Plus applyCodexLedger from
// usage-index.mjs: the attribution overlay the ledger exists to power.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { codexStateDb, readCodexState } from '../../src/lib/codex-state.mjs';
import { applyCodexLedger } from '../../src/lib/usage-index.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ak-codex-state-'));

/** Build a fixture ledger shaped like the real state_5.sqlite (verified live
 *  2026-07-31: threads has id/thread_source/source/model/git_branch/tokens_used
 *  and model_provider — NOT a bare `provider` column — among 33 columns;
 *  thread_spawn_edges has parent/child/status). */
function fixtureDb(dir, name = 'state_5.sqlite') {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, thread_source TEXT, source TEXT, model TEXT,
    git_branch TEXT, tokens_used INTEGER, agent_nickname TEXT, agent_role TEXT,
    title TEXT, name TEXT, cwd TEXT, model_provider TEXT, status TEXT,
    created_at_ms INTEGER, updated_at_ms INTEGER);`);
  db.exec(`CREATE TABLE thread_spawn_edges (
    parent_thread_id TEXT, child_thread_id TEXT, status TEXT);`);
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('parent-1', 'user', 'cli', 'gpt-5.6', 'main', 21_500_000, null, null,
      'private parent task', 'private parent name', '/Users/private/agentic-kit', 'openai', 'running',
      1_785_788_212_549, 1_785_788_531_650);
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('child-1', 'subagent', 'subagent', 'gpt-5.6', 'main', 1_000_000,
      'Bohr', 'tester', 'private child task', 'private child name',
      '/Users/private/agentic-kit', 'openai', 'running',
      1_785_788_220_000, 1_785_788_500_000);
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?,?,?)').run('parent-1', 'child-1', 'open');
  db.close();
  return file;
}

test('codexStateDb picks the HIGHEST migration generation, never a hardcoded name', () => {
  const dir = tmp();
  fixtureDb(dir, 'state_5.sqlite');
  fixtureDb(dir, 'state_12.sqlite');
  fs.writeFileSync(path.join(dir, 'state_x.sqlite'), 'not a generation');
  assert.equal(codexStateDb(dir), path.join(dir, 'state_12.sqlite'));
});

test('codexStateDb returns null for an absent dir or no state db', () => {
  assert.equal(codexStateDb(path.join(tmp(), 'nope')), null);
  assert.equal(codexStateDb(tmp()), null);
});

test('readCodexState reads threads and spawn edges', () => {
  const dir = tmp();
  fixtureDb(dir);
  const ledger = readCodexState({ dir });
  assert.equal(ledger.threads.get('parent-1').threadSource, 'user');
  assert.equal(ledger.threads.get('parent-1').tokensUsed, 21_500_000);
  assert.equal(ledger.threads.get('child-1').threadSource, 'subagent');
  assert.equal(ledger.threads.get('child-1').agentNickname, 'Bohr');
  assert.equal(ledger.threads.get('child-1').agentRole, 'tester');
  assert.equal(ledger.threads.get('child-1').project, 'agentic-kit');
  assert.equal(ledger.threads.get('child-1').provider, 'openai');
  assert.equal(ledger.threads.get('parent-1').createdAt, '2026-08-03T20:16:52.549Z');
  assert.equal(ledger.threads.get('parent-1').updatedAt, '2026-08-03T20:22:11.650Z');
  assert.equal(JSON.stringify([...ledger.threads.values()]).includes('private'), false);
  assert.equal(ledger.parents.get('child-1'), 'parent-1');
});

test('readCodexState tolerates a legacy ledger with a bare provider column', () => {
  const dir = tmp();
  const file = path.join(dir, 'state_5.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, thread_source TEXT, provider TEXT);');
  db.prepare('INSERT INTO threads VALUES (?,?,?)').run('t-1', 'user', 'azure');
  db.close();
  const ledger = readCodexState({ dir });
  assert.equal(ledger.threads.get('t-1').provider, 'azure');
});

test('readCodexState degrades to null when the load-bearing columns are missing', () => {
  const dir = tmp();
  const file = path.join(dir, 'state_9.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE threads (id TEXT, tokens_used INTEGER);'); // no thread_source
  db.close();
  assert.equal(readCodexState({ dir }), null);
});

test('readCodexState returns null for a corrupt file rather than throwing', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state_5.sqlite'), 'garbage bytes, not sqlite');
  assert.equal(readCodexState({ dir }), null);
});

// ── applyCodexLedger — the overlay ───────────────────────────────────────────

const rec = (over = {}) => ({
  id: 'child-1', provider: 'codex', threadSource: null,
  usage: [{ day: '2026-07-26', model: 'gpt-5.6', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, responses: 2 }],
  ...over,
});
const ledgerOf = (threads, parents = []) => ({
  threads: new Map(Object.entries(threads)),
  parents: new Map(parents),
});

test('applyCodexLedger backfills thread_source and STRIPS a subagent’s usage', () => {
  const [out] = applyCodexLedger([rec()], ledgerOf({ 'child-1': { threadSource: 'subagent' } }));
  assert.equal(out.threadSource, 'subagent');
  assert.deepEqual(out.usage, []); // replayed parent history must not double-bill
});

test('applyCodexLedger marks a spawn-edge child subagent even without a thread row', () => {
  const [out] = applyCodexLedger([rec()], ledgerOf({}, [['child-1', 'parent-1']]));
  assert.equal(out.threadSource, 'subagent');
  assert.deepEqual(out.usage, []);
});

test('applyCodexLedger never overrides what the rollout already said', () => {
  const r = rec({ threadSource: 'user' });
  const [out] = applyCodexLedger([r], ledgerOf({ 'child-1': { threadSource: 'subagent' } }));
  assert.equal(out.threadSource, 'user');
  assert.equal(out.usage.length, 1);
});

test('applyCodexLedger does not mutate the (possibly cached) input record', () => {
  const r = rec();
  applyCodexLedger([r], ledgerOf({ 'child-1': { threadSource: 'subagent' } }));
  assert.equal(r.threadSource, null);
  assert.equal(r.usage.length, 1);
});

test('applyCodexLedger leaves claude records and unmatched ids untouched', () => {
  const claude = { id: 'c1', provider: 'claude', threadSource: null, usage: [{}] };
  const unmatched = rec({ id: 'not-in-ledger' });
  const out = applyCodexLedger([claude, unmatched], ledgerOf({ 'child-1': { threadSource: 'subagent' } }));
  assert.equal(out[0], claude);
  assert.equal(out[1], unmatched);
});

test('applyCodexLedger is a no-op for a null/absent ledger', () => {
  const rows = [rec()];
  assert.equal(applyCodexLedger(rows, null), rows);
  assert.equal(applyCodexLedger(rows, {}), rows);
});
