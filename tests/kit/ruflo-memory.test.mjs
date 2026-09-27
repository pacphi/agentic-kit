import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  memoryProjectRoot, projectMemoryEnv, rufloMcpLaunch,
} from '../../src/lib/ruflo-memory.mjs';

test('every host launch resolves one absolute memory pin from the repository root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ruflo-memory-'));
  const nested = path.join(root, 'src', 'nested');
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(nested, { recursive: true });
  try {
    const canonical = fs.realpathSync(root);
    assert.equal(memoryProjectRoot(nested), canonical);
    assert.deepEqual(projectMemoryEnv(nested, { KEEP: 'yes', CLAUDE_FLOW_DB_PATH: '/wrong' }), {
      KEEP: 'yes',
      CLAUDE_FLOW_DB_PATH: path.join(canonical, '.swarm', 'memory.db'),
    });
    const launch = rufloMcpLaunch(nested, { KEEP: 'yes' }, { cfg: { agentBrowser: false } });
    assert.deepEqual({ command: launch.command, args: launch.args, cwd: launch.cwd }, {
      command: 'ruflo', args: ['mcp', 'start'], cwd: canonical,
    });
    assert.equal(launch.env.CLAUDE_FLOW_DB_PATH, path.join(canonical, '.swarm', 'memory.db'));
    assert.equal(launch.env.AGENT_BROWSER_CONFIG, undefined);
    const browserLaunch = rufloMcpLaunch(nested, { KEEP: 'yes' }, { cfg: { agentBrowser: true } });
    assert.ok(path.isAbsolute(browserLaunch.env.AGENT_BROWSER_CONFIG));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// B3-D1: Claude Code reaches Ruflo through the same launcher as Codex, in a
// Claude mode that pins only the memory location. Component keys come from
// Claude's settings env (ADR-0058 §3), so the launcher never overrides them.
test('Claude mode keeps inherited component keys, sets ak\'s agent-browser config and pins the repository store', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ruflo-claude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  const nested = path.join(root, 'sub', 'dir');
  fs.mkdirSync(nested, { recursive: true });
  const canonical = fs.realpathSync(root);
  const cfg = { agentBrowser: true, rufloComponents: { learningProfile: 'research', mcpGovernance: true } };
  const inherited = { KEEP: 'yes', RUFLO_INTELLIGENCE_MODE: 'fast', RUFLO_MCP_ENFORCE_POLICY: '1' };
  const codex = rufloMcpLaunch(nested, inherited, { cfg, rufloVersion: '3.46.1' });
  assert.equal(codex.env.RUFLO_INTELLIGENCE_MODE, 'research', 'Codex mode still applies componentEnv');
  const claude = rufloMcpLaunch(nested, inherited, { cfg, rufloVersion: '3.46.1', host: 'claude' });
  assert.equal(claude.cwd, canonical, 'Ruflo starts at the repository root, where .harness/ and .swarm/ live');
  assert.deepEqual([claude.command, ...claude.args], ['ruflo', 'mcp', 'start']);
  assert.equal(claude.env.RUFLO_INTELLIGENCE_MODE, 'fast', 'Claude\'s settings env wins');
  assert.equal(claude.env.RUFLO_MCP_ENFORCE_POLICY, '1', 'no governance deletion in Claude mode');
  assert.equal(claude.env.KEEP, 'yes');
  assert.ok(path.isAbsolute(claude.env.AGENT_BROWSER_CONFIG), 'ak\'s own agent-browser config stays');
  assert.equal(claude.env.CLAUDE_FLOW_DB_PATH, path.join(canonical, '.swarm', 'memory.db'));
  assert.equal(claude.env.CLAUDE_FLOW_MEMORY_PATH, undefined);
});

test('an unknown launcher host is refused', () => {
  assert.throws(() => rufloMcpLaunch(os.tmpdir(), {}, { cfg: { agentBrowser: false }, host: 'cursor' }), /host/);
});
