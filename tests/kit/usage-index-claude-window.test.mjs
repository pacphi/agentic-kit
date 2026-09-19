// The usage index pairs a MAIN Claude session with its statusline window ledger
// (ADR-0042 amendment) and keys the cached entry on the ledger file's stat too:
// a ledger that appears or changes after a transcript was parsed must not leave
// a finished session stuck at "Input only". Hermetic: temp dirs only; the real
// ~/.config/agentic-kit is never read (sandboxed roots imply no real ledger).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, SCHEMA_VERSION, _resetForTest } from '../../src/lib/usage-index.mjs';

const SID = '5b2c1f60-7c1e-4b2a-9d8e-3a1f0c2b4d11';
const BASE = Date.parse('2026-07-24T10:00:00.000Z');
const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const line = (o) => JSON.stringify(o);
const ts = (s) => new Date(BASE + s * 1000).toISOString();

const transcript = (sessionId, { sidechain = false } = {}) => [
  line({ type: 'user', sessionId, cwd: '/Users/me/proj', isSidechain: sidechain, timestamp: ts(0), message: { role: 'user', content: 'go' } }),
  line({
    type: 'assistant', sessionId, cwd: '/Users/me/proj', isSidechain: sidechain, timestamp: ts(5),
    message: {
      role: 'assistant', id: 'msg_1', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 199_000, cache_creation_input_tokens: 0 },
    },
  }),
].join('\n') + '\n';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-index-window-'));
  const proj = path.join(dir, 'claude', '-Users-me-proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), transcript(SID));
  const configHome = path.join(dir, 'config');
  const o = {
    days: 14, now: NOW,
    roots: { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex') },
    cachePath: path.join(dir, 'cache', 'usage-index.json'),
    claudeWindowConfigDir: configHome,
    deps: { costOf: () => 0, pricesAsOf: 'x', classify: () => ({ category: 'Build', confidence: 1, basis: 'x' }), detectInsights: () => [] },
  };
  return { dir, proj, configHome, o };
}

function writeLedger(configHome, sessionId, log) {
  const d = path.join(configHome, 'claude-context-windows');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `${sessionId}.json`);
  fs.writeFileSync(f, JSON.stringify(log));
  return f;
}

const evidenceOf = (agg, id) => agg.sessions.find((s) => s.id === id)?.contextEvidence;

test('SCHEMA_VERSION is 24 and a forged v23 cache is discarded and re-parsed', async () => {
  assert.equal(SCHEMA_VERSION, 24);
  _resetForTest();
  const { dir, o, configHome } = sandbox();
  writeLedger(configHome, SID, [{ t: BASE, size: 1_000_000, model: 'claude-opus-5' }]);
  await buildIndex(o);
  const cache = JSON.parse(fs.readFileSync(o.cachePath, 'utf8'));
  cache.schemaVersion = 23;
  for (const e of Object.values(cache.entries)) { e.session.title = 'FORGED-V23'; e.session.contextEvidence.pressure = null; }
  fs.writeFileSync(o.cachePath, JSON.stringify(cache));
  _resetForTest();
  const agg = await buildIndex(o);
  assert.notEqual(agg.sessions[0].title, 'FORGED-V23');
  assert.ok(evidenceOf(agg, SID).pressure, 'the v23 record was re-derived with the ledger');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a main session with a covering ledger gets observed pressure', async () => {
  _resetForTest();
  const { dir, o, configHome } = sandbox();
  writeLedger(configHome, SID, [{ t: BASE, size: 1_000_000, model: 'claude-opus-5' }]);
  const agg = await buildIndex(o);
  const ev = evidenceOf(agg, SID);
  assert.equal(ev.state, 'observed');
  assert.equal(ev.pressure.peakBps, 2000, '200,000 / 1,000,000');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no ledger: the session stays input-only (partial), never fabricated', async () => {
  _resetForTest();
  const { dir, o } = sandbox();
  const ev = evidenceOf(await buildIndex(o), SID);
  assert.equal(ev.state, 'partial');
  assert.equal(ev.pressure, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CACHE KEY: a ledger appearing after the transcript was cached re-parses the session', async () => {
  _resetForTest();
  const { dir, o, configHome } = sandbox();
  assert.equal(evidenceOf(await buildIndex(o), SID).pressure, null, 'first scan: input-only, cached');
  // Transcript file is untouched from here on: only the ledger appears.
  writeLedger(configHome, SID, [{ t: BASE, size: 1_000_000, model: 'claude-opus-5' }]);
  _resetForTest();
  const agg = await buildIndex(o);
  assert.equal(evidenceOf(agg, SID).pressure.peakBps, 2000, 'the stale input-only entry must not be reused');
  const cache = JSON.parse(fs.readFileSync(o.cachePath, 'utf8'));
  const entry = Object.values(cache.entries)[0];
  assert.equal(typeof entry.wmtime, 'number', 'the ledger stat is part of the entry key');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CACHE KEY: a ledger that changes re-parses; an unchanged ledger reuses the entry', async () => {
  _resetForTest();
  const { dir, o, configHome } = sandbox();
  const f = writeLedger(configHome, SID, [{ t: BASE, size: 200_000, model: 'm' }]);
  assert.equal(evidenceOf(await buildIndex(o), SID).pressure.peakBps, 10000);
  // Forge the cached record; an unchanged ledger + transcript must reuse it verbatim.
  const cache = JSON.parse(fs.readFileSync(o.cachePath, 'utf8'));
  Object.values(cache.entries)[0].session.title = 'REUSED';
  fs.writeFileSync(o.cachePath, JSON.stringify(cache));
  _resetForTest();
  assert.equal((await buildIndex(o)).sessions[0].title, 'REUSED');
  // Now the ledger grows (window switched to 1M before the message): must re-parse.
  fs.writeFileSync(f, JSON.stringify([{ t: BASE - 60_000, size: 200_000, model: 'm' }, { t: BASE, size: 1_000_000, model: 'n' }]));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f, later, later);
  _resetForTest();
  const agg = await buildIndex(o);
  assert.notEqual(agg.sessions[0].title, 'REUSED');
  assert.equal(evidenceOf(agg, SID).pressure.peakBps, 2000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a ledger that is later pruned keeps the evidence already derived', async () => {
  _resetForTest();
  const { dir, o, configHome } = sandbox();
  const f = writeLedger(configHome, SID, [{ t: BASE, size: 1_000_000, model: 'm' }]);
  await buildIndex(o);
  fs.rmSync(f);
  _resetForTest();
  assert.equal(evidenceOf(await buildIndex(o), SID).pressure.peakBps, 2000, 'pruning the 35-day ledger must not erase measured pressure');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a subagent transcript never borrows its parent session ledger', async () => {
  _resetForTest();
  const { dir, proj, o, configHome } = sandbox();
  const subDir = path.join(proj, SID, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-abc123.jsonl'), transcript(SID, { sidechain: true }));
  writeLedger(configHome, SID, [{ t: BASE, size: 1_000_000, model: 'm' }]);
  const agg = await buildIndex(o);
  const sub = agg.sessions.find((s) => s.id === `${SID}/agent-abc123`);
  assert.ok(sub, 'the subagent session is indexed');
  assert.equal(sub.contextEvidence.pressure, null, 'sidechains stay input-only');
  assert.equal(sub.contextEvidence.state, 'partial');
  assert.ok(evidenceOf(agg, SID).pressure, 'the main session is still paired');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sandboxed roots never read the real config dir (hermetic by default)', async () => {
  _resetForTest();
  const { dir, o, configHome } = sandbox();
  // Where configDir() would look if the default were (wrongly) consulted: <config>/agentic-kit.
  writeLedger(path.join(configHome, 'agentic-kit'), SID, [{ t: BASE, size: 1_000_000, model: 'm' }]);
  const before = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, APPDATA: process.env.APPDATA };
  process.env.XDG_CONFIG_HOME = configHome; // would be picked up if the default were consulted
  process.env.APPDATA = configHome;         // (configDir() reads APPDATA on Windows)
  try {
    const { claudeWindowConfigDir: _omit, ...withoutOverride } = o;
    const ev = evidenceOf(await buildIndex(withoutOverride), SID);
    assert.equal(ev.pressure, null, 'roots overridden => no ledger read unless explicitly directed');
  } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
