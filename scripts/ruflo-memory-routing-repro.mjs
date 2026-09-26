#!/usr/bin/env node
// Black-box reproduction of Ruflo CLI/MCP project-memory routing (ruvnet/ruflo#3196,
// pacphi/agentic-kit#213). Uses only the public `ruflo` CLI and `ruflo mcp start`
// over stdio; no internals, no agentic-kit code. Every write happens in throwaway
// temp directories that are deleted at the end. Reads SQLite files read-only via
// node:sqlite, so it needs Node >= 22.13 (or --experimental-sqlite on 22.5-22.12).
//
//   node ruflo-memory-routing-repro.mjs            # prints a report, exits 0
//   node ruflo-memory-routing-repro.mjs --json     # machine-readable
//
// Sections: (1) where CLI and MCP writes land and who can read them, (2) whether
// `memory purge` clears every store it wrote to, (3) MCP tool descriptions vs
// behavior, (4) a CLAUDE_FLOW_DB_PATH pin that is not <cwd>/.swarm/memory.db.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const NS = 'route-repro';
const asJson = process.argv.includes('--json');
const report = { versions: {}, platform: `${process.platform}/${process.arch}`, node: process.version, sections: {} };
const dirs = [];

function tempProject() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ruflo-route-repro-')));
  dirs.push(dir);
  return dir;
}

// A clean environment: no user pins or roots can redirect where the probe writes.
function cleanEnv(extra = {}) {
  const env = { ...process.env, RUFLO_DAEMON_AUTOSTART: '0', NO_COLOR: '1', ...extra };
  for (const name of ['CLAUDE_FLOW_DB_PATH', 'CLAUDE_FLOW_MEMORY_PATH', 'CLAUDE_FLOW_DISABLE_BRIDGE']) {
    if (!(name in extra)) delete env[name];
  }
  return env;
}

function cli(cwd, args, env = cleanEnv()) {
  const r = spawnSync('ruflo', args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
  // NO_COLOR keeps the output free of ANSI escapes, so nothing needs stripping.
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// Minimal stdio MCP client: initialize, then each tools/call in order, then kill the tree.
function mcp(cwd, calls, env = cleanEnv(), timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn('ruflo', ['mcp', 'start'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    const results = [];
    let buffer = '';
    let next = 0;
    const done = (status) => {
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      resolve({ status, results });
    };
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    const step = () => (next >= calls.length ? done('ok') : send({ id: next + 2, ...calls[next] }));
    child.on('close', () => done('exited'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { send({ method: 'notifications/initialized' }); step(); }
        else if (msg.id === next + 2) {
          const text = msg.result?.content?.[0]?.text;
          let data;
          try { data = JSON.parse(text); } catch { data = msg.result ?? msg.error; }
          results.push(data);
          next += 1;
          step();
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'route-repro', version: '1' } } });
  });
}
const tool = (name, args) => ({ method: 'tools/call', params: { name, arguments: args } });

function rows(dir, ns = NS) {
  const out = {};
  for (const file of ['memory.db', 'agentdb-memory.db']) {
    const full = path.join(dir, '.swarm', file);
    if (!fs.existsSync(full)) { out[file] = null; continue; }
    try {
      const db = new DatabaseSync(full, { readOnly: true });
      out[file] = db.prepare('SELECT key FROM memory_entries WHERE namespace = ? ORDER BY key').all(ns).map((r) => r.key);
      db.close();
    } catch (e) { out[file] = `unreadable: ${e.code ?? e.message}`; }
  }
  return out;
}

async function main() {
  report.versions.ruflo = cli(os.tmpdir(), ['--version']).out.trim().split('\n').pop();

  // 1. Where do writes land, and who can read them?
  const a = tempProject();
  cli(a, ['memory', 'init']);
  const cliStore = cli(a, ['memory', 'store', '-k', 'cli-key', '--value', 'written-by-cli', '-n', NS]);
  const session = await mcp(a, [
    tool('memory_store', { key: 'mcp-key', value: 'written-by-mcp', namespace: NS }),
    tool('memory_retrieve', { key: 'cli-key', namespace: NS }),
  ]);
  const cliReadsMcp = cli(a, ['memory', 'retrieve', '-k', 'mcp-key', '-n', NS, '--value-only']);
  const cliListing = cli(a, ['memory', 'list', '-n', NS]);
  const afterWrites = rows(a);
  report.sections.routing = {
    cliStoreExit: cliStore.code,
    mcpStore: { success: session.results[0]?.success, backend: session.results[0]?.backend },
    filesAfterWrites: afterWrites,
    mcpReadsCliKey: session.results[1]?.found ?? null,
    cliReadsMcpKey: { exit: cliReadsMcp.code, foundValue: cliReadsMcp.out.includes('written-by-mcp'), tail: cliReadsMcp.out.trim().split('\n').slice(-2).join(' | ').slice(0, 300) },
    cliList: { showsTotal: /Showing 1 of 1/.test(cliListing.out), namesUnreadSibling: /agentdb-memory\.db/.test(cliListing.out) },
  };

  // 2. Does purge clear every store it wrote to?
  const purge = cli(a, ['memory', 'purge', '--namespace', NS, '--force']);
  report.sections.purge = {
    exit: purge.code,
    printed: purge.out.trim().split('\n').filter((l) => /Purged|Remaining/.test(l)).join(' | '),
    filesAfterPurge: rows(a),
  };

  // 3. What do the MCP tool descriptions claim?
  const listing = await mcp(a, [{ method: 'tools/list', params: {} }]);
  const tools = listing.results[0]?.tools ?? [];
  report.sections.descriptions = Object.fromEntries(
    ['memory_store', 'memory_retrieve', 'memory_list'].map((n) => {
      const d = tools.find((t) => t.name === n)?.description ?? null;
      return [n, { mentionsMemoryDb: /memory\.db/.test(d ?? ''), mentionsAgentdbMemoryDb: /agentdb-memory\.db/.test(d ?? '') }];
    }),
  );

  // 4. A DB-path pin that is not the default location.
  const b = tempProject();
  const custom = path.join(b, 'custom', 'memory.db');
  const pinned = cleanEnv({ CLAUDE_FLOW_DB_PATH: custom });
  const init = cli(b, ['memory', 'init'], pinned);
  const pinStore = await mcp(b, [tool('memory_store', { key: 'pin-key', value: 'v', namespace: NS })], pinned);
  report.sections.pin = {
    pin: 'CLAUDE_FLOW_DB_PATH=<tmp>/custom/memory.db (cwd has no .swarm)',
    cliInitExit: init.code,
    pinnedFileExists: fs.existsSync(custom),
    mcpStoreResponse: { success: pinStore.results[0]?.success ?? null, error: pinStore.results[0]?.error ?? null },
  };
}

function summarize() {
  const r = report.sections.routing;
  const p = report.sections.purge;
  const d = report.sections.descriptions;
  const pin = report.sections.pin;
  const f = r.filesAfterWrites;
  const lines = [
    `ruflo ${report.versions.ruflo}  node ${report.node}  ${report.platform}`,
    '',
    '1. routing (cwd has only default paths, no env overrides)',
    `   files after writes: memory.db=${JSON.stringify(f['memory.db'])} agentdb-memory.db=${JSON.stringify(f['agentdb-memory.db'])}`,
    `   MCP backend: ${r.mcpStore.backend ?? 'unknown'}`,
    `   CLI-written key readable via MCP: ${r.mcpReadsCliKey}`,
    `   MCP-written key readable via CLI: ${r.cliReadsMcpKey.foundValue} (exit ${r.cliReadsMcpKey.exit})`,
    `   \`memory list\` prints "Showing 1 of 1": ${r.cliList.showsTotal}; names the unread sibling store: ${r.cliList.namesUnreadSibling}`,
    '',
    '2. purge',
    `   printed: ${p.printed}`,
    `   files after purge: memory.db=${JSON.stringify(p.filesAfterPurge['memory.db'])} agentdb-memory.db=${JSON.stringify(p.filesAfterPurge['agentdb-memory.db'])}`,
    '',
    '3. MCP tool descriptions naming memory.db / agentdb-memory.db',
    ...Object.entries(d).map(([n, v]) => `   ${n}: memory.db=${v.mentionsMemoryDb} agentdb-memory.db=${v.mentionsAgentdbMemoryDb}`),
    '',
    '4. non-default CLAUDE_FLOW_DB_PATH pin',
    `   CLI init exit ${pin.cliInitExit}, pinned file exists: ${pin.pinnedFileExists}`,
    `   MCP memory_store: success=${pin.mcpStoreResponse.success} error=${JSON.stringify(pin.mcpStoreResponse.error)}`,
  ];
  const observed = [];
  if (r.mcpReadsCliKey && !r.cliReadsMcpKey.foundValue) observed.push('MCP write invisible to CLI read');
  if (r.cliList.showsTotal && !r.cliList.namesUnreadSibling && f['agentdb-memory.db']?.length) observed.push('CLI list reports a bare total while a sibling store holds rows');
  if (Array.isArray(p.filesAfterPurge['agentdb-memory.db']) && p.filesAfterPurge['agentdb-memory.db'].length) observed.push('purge reported success but left rows in agentdb-memory.db');
  if (Object.values(d).some((v) => v.mentionsMemoryDb && !v.mentionsAgentdbMemoryDb) && r.mcpStore.backend?.includes('bridge')) observed.push('MCP descriptions name memory.db but the bridge uses agentdb-memory.db');
  if (pin.mcpStoreResponse.success === false) observed.push('MCP ignores a non-default CLAUDE_FLOW_DB_PATH pin');
  lines.push('', `observed on this machine: ${observed.length ? observed.join('; ') : 'none of the above'}`);
  return lines.join('\n');
}

try {
  await main();
  console.log(asJson ? JSON.stringify(report, null, 2) : summarize());
} finally {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}
