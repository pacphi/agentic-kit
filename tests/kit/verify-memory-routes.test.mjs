// `ak x verify memory` must observe CLI↔MCP routing (issue #213) and report it
// as an observation: a known upstream split is a warning, an unusable MCP
// server is "not observed", and neither may fail an otherwise-working suite.
// A fake `ruflo` on PATH models the shapes with real SQLite files. Its `split`
// mode is what ruflo 3.45.0 does on macOS (observed 2026-09-26 in a disposable
// project with this suite's environment): a CLI store is mirrored into
// memory.db AND agentdb-memory.db, an MCP store lands in agentdb-memory.db only,
// and a default `memory purge` clears memory.db only while reporting success.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sandboxHome, assertSandboxed, captureLog, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const FAKE_RUFLO = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const argv = process.argv.slice(2);
if (process.env.FAKE_RUFLO_LOG) fs.appendFileSync(process.env.FAKE_RUFLO_LOG, argv.slice(0, 2).join(' ') + '\\n');
const mode = process.env.FAKE_RUFLO_MODE;
const swarm = path.join(process.cwd(), '.swarm');
const cliWrites = mode === 'aligned' ? ['memory.db'] : ['memory.db', 'agentdb-memory.db'];
const mcpFile = mode === 'aligned' ? 'memory.db' : 'agentdb-memory.db';
// Like the real bridge: the native store follows the memory root, not the DB-path pin.
const dirFor = (name) => (name === 'agentdb-memory.db' && process.env.CLAUDE_FLOW_MEMORY_PATH) || swarm;
const open = (name) => {
  fs.mkdirSync(dirFor(name), { recursive: true });
  const db = new DatabaseSync(path.join(dirFor(name), name));
  db.exec('CREATE TABLE IF NOT EXISTS memory_entries (namespace TEXT, key TEXT, value TEXT, status TEXT)');
  return db;
};
const put = (name, ns, key, value) => {
  const db = open(name);
  db.prepare('DELETE FROM memory_entries WHERE namespace = ? AND key = ?').run(ns, key);
  db.prepare("INSERT INTO memory_entries VALUES (?, ?, ?, 'active')").run(ns, key, value);
  db.close();
};
const get = (name, ns, key) => {
  const db = open(name);
  const row = db.prepare('SELECT value FROM memory_entries WHERE namespace = ? AND key = ?').get(ns, key);
  db.close();
  return row ? row.value : null;
};
const flag = (...names) => { for (const n of names) { const i = argv.indexOf(n); if (i !== -1) return argv[i + 1]; } return undefined; };

if (argv[0] === 'mcp') {
  if (mode === 'mcp-down') process.exit(1);
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {} } });
    if (msg.method !== 'tools/call') return;
    const { name, arguments: a } = msg.params;
    const ns = a.namespace || 'default';
    let payload;
    if (name === 'memory_store') { put(mcpFile, ns, a.key, a.value); payload = { success: true, stored: true, backend: 'fake-bridge' }; }
    else { const value = get(mcpFile, ns, a.key); payload = { found: value !== null, value }; }
    send({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  });
} else if (argv[0] === 'memory') {
  const sub = argv[1];
  const ns = flag('-n', '--namespace');
  if (sub === 'init') { open('memory.db').close(); open('agentdb-memory.db').close(); }
  else if (sub === 'store') cliWrites.forEach((f) => put(f, ns, flag('-k'), flag('--value')));
  else if (sub === 'retrieve') {
    const key = flag('-k');
    const mcpKey = key === 'route-written-by-mcp';
    if (mode === 'retrieve-db-error' && mcpKey) { console.log('Database not found'); process.exit(1); }
    if (mode === 'retrieve-exit0-miss' && mcpKey) { console.log('[WARN] nothing to show'); process.exit(0); }
    const value = get('memory.db', ns, key);
    if (value === null) { console.log('[WARN] Key not found'); process.exit(1); }
    console.log(value);
  } else if (sub === 'purge') {
    if (mode === 'purge-fails') process.exit(1);
    if (mode === 'purge-broken' && flag('--path')) process.exit(1);
    // Observed on ruflo 3.42.4 and 3.45.0: a default purge clears memory.db only and still reports success.
    const target = flag('--path');
    for (const f of [target ? path.basename(target) : 'memory.db']) { const db = open(f); db.prepare('DELETE FROM memory_entries WHERE namespace = ?').run(ns); db.close(); }
    console.log('[OK] Purged');
  }
}
`;

const HOME = sandboxHome('ak-verify-routes');
after(() => rmrf(HOME));
const paths = await import('../../src/lib/paths.mjs');
const verify = await import('../../src/commands/x/verify.mjs');
assertSandboxed(paths, HOME);
const PROJECT = sandboxProject('ak-verify-routes');
after(() => rmrf(PROJECT));
paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9' }));

const posix = { skip: process.platform === 'win32' ? 'fake ruflo is a POSIX shebang script' : false };

/** Run `fn` with the fake ruflo first on PATH; returns fn's result and the invocations it saw. */
async function withFakeRuflo(mode, fn) {
  rmrf(paths.configDir());
  writeKitConfig(HOME, offlineKitConfig());
  const bin = tempDir('ak-fake-ruflo');
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'ruflo'), FAKE_RUFLO, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, FAKE_RUFLO_MODE: process.env.FAKE_RUFLO_MODE, FAKE_RUFLO_LOG: process.env.FAKE_RUFLO_LOG, cwd: process.cwd() };
  // The sandbox points PATH at nothing; expose only the fake plus what its shebang and `which` need.
  process.env.PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
  process.env.FAKE_RUFLO_MODE = mode;
  process.env.FAKE_RUFLO_LOG = log;
  process.chdir(PROJECT);
  try {
    const value = await fn();
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    return { ...value, calls };
  } finally {
    process.chdir(saved.cwd);
    for (const name of ['PATH', 'FAKE_RUFLO_MODE', 'FAKE_RUFLO_LOG']) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

const verifyMemoryWith = (mode) => withFakeRuflo(mode, () => captureLog(() => verify.run({ positionals: ['memory'] })));

test('the observed ruflo split passes the suite, clears the mirrored proof row, and reports where the MCP write landed', posix, async () => {
  const { result, out, calls } = await verifyMemoryWith('split');
  assert.equal(result, 0, out);
  assert.match(out, /default purge left the proof row in agentdb-memory\.db/);
  assert.match(out, /isolated proof namespace purged/, 'the sibling is cleared explicitly, so the proof still leaves nothing behind');
  assert.ok(calls.includes('mcp start'), 'the route observation talks to the real MCP entry point');
  assert.match(out, /MCP write is not visible to a CLI read; it landed in agentdb-memory\.db/);
  assert.match(out, /--path/);
  assert.doesNotMatch(out, /CLI write is not visible/, 'the observed CLI write is mirrored to the MCP store');
});

test('an aligned ruflo reports observed route identity and no warning', posix, async () => {
  const { result, out } = await verifyMemoryWith('aligned');
  assert.equal(result, 0, out);
  assert.match(out, /see each other's writes in an isolated test project \(MCP backend: fake-bridge\)/);
  assert.doesNotMatch(out, /not visible/);
  assert.doesNotMatch(out, /purge left/);
});

test('an unusable MCP server is "not observed" and does not fail the suite', posix, async () => {
  const { result, out } = await verifyMemoryWith('mcp-down');
  assert.equal(result, 0, out);
  assert.match(out, /cross-interface routing not observed/);
  assert.doesNotMatch(out, /see each other's writes/);
});

test('the isolated proof never writes into a user-set memory root', posix, async () => {
  const decoy = tempDir('ak-decoy-store');
  const saved = process.env.CLAUDE_FLOW_MEMORY_PATH;
  process.env.CLAUDE_FLOW_MEMORY_PATH = decoy;
  try {
    const { result, out } = await verifyMemoryWith('split');
    assert.equal(result, 0, out);
    assert.deepEqual(fs.readdirSync(decoy), [], 'the proof leaked rows into the user memory root');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_FLOW_MEMORY_PATH; else process.env.CLAUDE_FLOW_MEMORY_PATH = saved;
    fs.rmSync(decoy, { recursive: true, force: true });
  }
});

test('a failing default purge fails the suite', posix, async () => {
  const { result, out } = await verifyMemoryWith('purge-fails');
  assert.equal(result, 1, out);
  assert.match(out, /purge did not remove the proof row/);
});

test('a --path purge that cannot clear the sibling fails the suite instead of claiming cleanup', posix, async () => {
  const { result, out } = await verifyMemoryWith('purge-broken');
  assert.equal(result, 1, out);
  assert.match(out, /purge did not remove the proof row/);
  assert.doesNotMatch(out, /isolated proof namespace purged/);
});

test('a CLI retrieve that errors for another reason is "not observed", not a split', posix, async () => {
  const { result, out } = await verifyMemoryWith('retrieve-db-error');
  assert.equal(result, 0, out);
  assert.match(out, /not observed \(ruflo memory retrieve failed\)/);
  assert.doesNotMatch(out, /MCP write is not visible/);
});

test('a CLI retrieve that exits 0 without the value is a miss, not visibility', posix, async () => {
  const { result, out } = await verifyMemoryWith('retrieve-exit0-miss');
  assert.equal(result, 0, out);
  assert.match(out, /MCP write is not visible to a CLI read/);
});

test('warnings and passes are marked as such, not all rendered as passes', posix, async () => {
  const split = (await verifyMemoryWith('split')).out;
  assert.match(split, /⚠\s+an MCP write is not visible/);
  assert.match(split, /⚠\s+default purge left/);
  const aligned = (await verifyMemoryWith('aligned')).out;
  assert.match(aligned, /✓ CLI and MCP see each other's writes/);
});

test('an exception while observing routes is a warning and never fails the suite', posix, async () => {
  const logs = await captureLog(() => verify.observeProjectMemoryRoutes(os.tmpdir(), {}, 'ns', {
    observe: async () => { throw new Error('launcher exploded'); },
  }));
  assert.match(logs.out, /cross-interface routing not observed: launcher exploded/);
});

// security-verify-memory-user-store (defense in depth): whatever the launcher
// decides for the probe's folder (an enclosing repository, the user-level
// store), the route probe's MCP server runs in the probe's own directory.
test('the route probe starts its MCP server pinned to the isolated directory', async (t) => {
  rmrf(paths.configDir());
  writeKitConfig(HOME, offlineKitConfig());
  const repo = sandboxProject('ak-verify-routes-enclosing'); // has a .git marker
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(repo, 'agentic-kit-memory-')));
  t.after(() => rmrf(repo));
  let launch = null;
  await verify.probeProjectMemoryRoutes(tmp, { KEEP: 'yes' }, 'ns', {
    callMcp: async (spec) => { launch = spec; return []; },
    observe: async ({ mcp }) => { await mcp([]); return {}; },
  });
  assert.ok(launch, 'the probe reached the MCP call');
  assert.equal(launch.cwd, tmp, 'not the enclosing repository');
  assert.equal(launch.env.CLAUDE_FLOW_MEMORY_PATH, path.join(tmp, '.swarm'));
  assert.equal(launch.env.CLAUDE_FLOW_DB_PATH, path.join(tmp, '.swarm', 'memory.db'));
  assert.equal(launch.env.KEEP, 'yes');
});

test('the quick live memory check proves the CLI round trip without starting an MCP server', posix, async () => {
  const cfg = offlineKitConfig();
  const checks = verify.liveChecksFor(cfg).filter((check) => check.id === 'memory');
  assert.equal(checks.length, 1);
  const { results, calls } = await withFakeRuflo('split', async () => ({
    results: await verify.runLiveChecks({ cfg, cwd: PROJECT, checks }),
  }));
  assert.equal(results[0].status, 'passed', JSON.stringify(results[0]));
  assert.ok(calls.some((c) => c === 'memory purge'), 'the proof row is purged');
  assert.ok(!calls.includes('mcp start'), 'the live check stays quick: routing is observed only by ak x verify memory');
});
