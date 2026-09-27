import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeMemoryRoutes, describeMemoryRoutes } from '../../src/lib/memory-route-probe.mjs';

const VALUE = 'proof-value';

// A fake Ruflo whose two interfaces read and write the given stores. Only the
// process boundary is faked; the probe's choreography and verdicts are real.
function fakeRuflo({ cliWrites, cliReads, mcpWrites, mcpReads, mcpFails = false }) {
  const stores = { 'memory.db': new Map(), 'agentdb-memory.db': new Map() };
  const put = (files, key) => files.forEach((file) => stores[file].set(key, VALUE));
  const has = (files, key) => files.some((file) => stores[file].get(key) === VALUE);
  return {
    stores,
    cli: {
      store: async (key) => { put(cliWrites, key); return true; },
      retrieve: async (key) => ({ ok: true, found: has(cliReads, key) }),
    },
    mcp: async (calls) => {
      if (mcpFails) return { status: 'exited', results: calls.map(() => null) };
      const results = calls.map((call) => {
        if (call.name === 'memory_store') { put(mcpWrites, call.arguments.key); return { ok: true, data: { success: true } }; }
        return { ok: true, data: { found: has(mcpReads, call.arguments.key), value: has(mcpReads, call.arguments.key) ? VALUE : undefined } };
      });
      return { status: 'ok', results };
    },
    locate: (key) => Object.keys(stores).find((file) => stores[file].has(key)) ?? null,
  };
}

const observe = (ruflo) => observeMemoryRoutes({ namespace: 'ns', value: VALUE, ...ruflo });

test('interfaces that share one store are observed as aligned', async () => {
  const both = ['memory.db'];
  const seen = await observe(fakeRuflo({ cliWrites: both, cliReads: both, mcpWrites: both, mcpReads: both }));
  assert.equal(seen.status, 'observed');
  assert.deepEqual([seen.cliToMcp, seen.mcpToCli], ['visible', 'visible']);
  const rows = describeMemoryRoutes(seen);
  assert.deepEqual(rows.map((r) => r.level), ['ok']);
});

test('the observed ruflo shape: CLI writes reach MCP but MCP writes stay in the sibling', async () => {
  const seen = await observe(fakeRuflo({
    cliWrites: ['memory.db', 'agentdb-memory.db'], cliReads: ['memory.db'],
    mcpWrites: ['agentdb-memory.db'], mcpReads: ['agentdb-memory.db'],
  }));
  assert.deepEqual([seen.cliToMcp, seen.mcpToCli], ['visible', 'not-visible']);
  assert.equal(seen.mcpStore, 'agentdb-memory.db');
  const rows = describeMemoryRoutes(seen);
  assert.ok(rows.every((r) => r.level === 'warn' || r.level === 'ok'), 'a known upstream split is never a hard failure');
  const split = rows.find((r) => r.level === 'warn');
  assert.match(split.message, /MCP write[^.]*not visible[^.]*CLI read/);
  assert.match(split.message, /agentdb-memory\.db/);
  assert.match(split.message, /--path/);
});

test('a fully disjoint pair reports both directions as not visible', async () => {
  const seen = await observe(fakeRuflo({ cliWrites: ['memory.db'], cliReads: ['memory.db'], mcpWrites: ['agentdb-memory.db'], mcpReads: ['agentdb-memory.db'] }));
  assert.deepEqual([seen.cliToMcp, seen.mcpToCli], ['not-visible', 'not-visible']);
  assert.equal(describeMemoryRoutes(seen).filter((r) => r.level === 'warn').length, 2);
});

test('an unusable MCP server means routing was not observed, never that it is aligned or split', async () => {
  const seen = await observe(fakeRuflo({ cliWrites: ['memory.db'], cliReads: ['memory.db'], mcpWrites: [], mcpReads: [], mcpFails: true }));
  assert.equal(seen.status, 'mcp-unavailable');
  assert.equal(seen.cliToMcp, undefined);
  const rows = describeMemoryRoutes(seen);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, 'warn');
  assert.match(rows[0].message, /not observed/);
});

test('an MCP store that reports failure is unavailable, not a routing verdict', async () => {
  const ruflo = fakeRuflo({ cliWrites: ['memory.db'], cliReads: ['memory.db'], mcpWrites: ['memory.db'], mcpReads: ['memory.db'] });
  const failing = { ...ruflo, mcp: async () => ({ status: 'ok', results: [{ ok: true, data: { success: false, error: 'Database not initialized' } }, { ok: true, data: { found: false } }] }) };
  const seen = await observe(failing);
  assert.equal(seen.status, 'mcp-unavailable');
  assert.match(seen.detail, /Database not initialized/);
});

test('a failing CLI store stops the probe before MCP is started', async () => {
  let mcpStarted = false;
  const seen = await observeMemoryRoutes({ namespace: 'ns', value: VALUE,
    cli: { store: async () => false, retrieve: async () => ({ ok: true, found: false }) },
    mcp: async () => { mcpStarted = true; return { status: 'ok', results: [] }; }, locate: () => null });
  assert.equal(seen.status, 'cli-unavailable');
  assert.equal(mcpStarted, false);
  assert.equal(describeMemoryRoutes(seen)[0].level, 'warn');
});

test('a CLI retrieve that errors is not observed, and is never reported as a split', async () => {
  const shared = ['memory.db'];
  const ruflo = fakeRuflo({ cliWrites: shared, cliReads: shared, mcpWrites: shared, mcpReads: shared });
  const seen = await observe({ ...ruflo, cli: { ...ruflo.cli, retrieve: async () => ({ ok: false, found: false }) } });
  assert.equal(seen.status, 'observed');
  assert.equal(seen.mcpToCli, 'unknown');
  const rows = describeMemoryRoutes(seen);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, 'warn');
  assert.match(rows[0].message, /not observed/);
  assert.doesNotMatch(rows[0].message, /not visible/);
});

const shared = ['memory.db'];
const sharedRuflo = () => fakeRuflo({ cliWrites: shared, cliReads: shared, mcpWrites: shared, mcpReads: shared });
// Keep the MCP side effects (the write really happens), but script the answers.
const withMcp = (ruflo, results, status = 'ok') => ({
  ...ruflo,
  mcp: async (calls) => { await ruflo.mcp(calls); return { status, results }; },
});
const STORED = { ok: true, data: { success: true, backend: 'sqlite (bridge, brute-force cosine)' } };

test('an MCP retrieve in an unexpected shape is unknown, never reported as a split', async () => {
  for (const data of ['Error: namespace not initialised', { found: true, value: { value: VALUE } }, {}, null, { found: 'yes', value: VALUE }]) {
    const seen = await observe(withMcp(sharedRuflo(), [STORED, { ok: true, data }]));
    assert.equal(seen.status, 'observed', JSON.stringify(data));
    assert.equal(seen.cliToMcp, 'unknown', JSON.stringify(data));
    const rows = describeMemoryRoutes(seen);
    assert.ok(rows.some((r) => /not observed/.test(r.message)), JSON.stringify(data));
    assert.ok(rows.every((r) => !/not visible/.test(r.message)), JSON.stringify(data));
  }
});

test('found:false is the only MCP answer that means a CLI write was not visible', async () => {
  const seen = await observe(withMcp(sharedRuflo(), [STORED, { ok: true, data: { found: false } }]));
  assert.equal(seen.cliToMcp, 'not-visible');
});

test('an MCP retrieve that fails outright makes the MCP round-trip unavailable', async () => {
  const seen = await observe(withMcp(sharedRuflo(), [STORED, { ok: false, error: 'tool blew up' }]));
  assert.equal(seen.status, 'mcp-unavailable');
  assert.match(seen.detail, /tool blew up/);
});

test('a timed-out MCP session is unavailable even when the store call answered', async () => {
  const seen = await observe(withMcp(sharedRuflo(), [STORED, null], 'timeout'));
  assert.equal(seen.status, 'mcp-unavailable');
  assert.match(seen.detail, /timeout/);
});

test('an unlocated store never prints a placeholder or "undefined"', async () => {
  const ruflo = fakeRuflo({ cliWrites: shared, cliReads: shared, mcpWrites: ['agentdb-memory.db'], mcpReads: ['agentdb-memory.db'] });
  const seen = await observe({ ...ruflo, locate: () => null });
  const text = describeMemoryRoutes(seen).map((r) => r.message).join('\n');
  assert.match(text, /unlocated store/);
  assert.doesNotMatch(text, /<store>|undefined|null/);
});

test('the MCP backend is recorded and shown, so a degraded bridge cannot masquerade as alignment', async () => {
  const degraded = { ok: true, data: { success: true, backend: 'sql.js + HNSW (native bridge disabled)' } };
  const seen = await observe(withMcp(sharedRuflo(), [degraded, { ok: true, data: { found: true, value: VALUE } }]));
  assert.equal(seen.mcpBackend, 'sql.js + HNSW (native bridge disabled)');
  const rows = describeMemoryRoutes(seen);
  assert.match(rows[0].message, /native bridge disabled/);
  assert.match(rows[0].message, /isolated test project/, 'the observation is about a synthetic project, not the user project');
  assert.doesNotMatch(rows[0].message, /in this project/);
});

test('a missing backend field is reported as unknown, not omitted or invented', async () => {
  const seen = await observe(withMcp(sharedRuflo(), [{ ok: true, data: { success: true } }, { ok: true, data: { found: true, value: VALUE } }]));
  assert.equal(seen.mcpBackend, null);
  assert.match(describeMemoryRoutes(seen)[0].message, /backend unknown/);
});
