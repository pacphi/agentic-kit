import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codexMcpStatus, codexMcpTopology, codexMcpRepairPlan, repairCodexMcpTopology,
} from '../../src/lib/mcp.mjs';

// A tmp dir with a .git marker → repoRoot() resolves to it, so codexMcpStatus reads
// the .mcp.json we write here (not the real repo's).
function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-codexmcp-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const writeMcp = (dir, servers) =>
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }));

test('registered is false when no .mcp.json exists', () => {
  const dir = tmpProject();
  try {
    assert.deepEqual(codexMcpStatus({}, dir), { registered: false, owned: false });
  } finally { rm(dir); }
});

test('registered is true when .mcp.json lists a codex server', () => {
  const dir = tmpProject();
  try {
    writeMcp(dir, { codex: { command: 'codex', args: ['mcp-server'] } });
    assert.equal(codexMcpStatus({}, dir).registered, true);
  } finally { rm(dir); }
});

test('registered is false when .mcp.json has other servers but not codex', () => {
  const dir = tmpProject();
  try {
    writeMcp(dir, { 'claude-flow': { command: 'ruflo' } });
    assert.equal(codexMcpStatus({}, dir).registered, false);
  } finally { rm(dir); }
});

test('owned reflects the kit.json ak-ownership marker', () => {
  const dir = tmpProject();
  try {
    writeMcp(dir, { codex: {} });
    assert.equal(codexMcpStatus({ integrations: { ownership: { codex: { mcp: 'ak' } } } }, dir).owned, true);
    assert.equal(codexMcpStatus({ integrations: { ownership: { codex: { mcp: null } } } }, dir).owned, false);
    assert.equal(codexMcpStatus({}, dir).owned, false);
  } finally { rm(dir); }
});

test('a pre-existing (unowned) codex server is registered but not owned', () => {
  const dir = tmpProject();
  try {
    writeMcp(dir, { codex: {} });
    assert.deepEqual(codexMcpStatus({ integrations: { ownership: { codex: { mcp: null } } } }, dir),
      { registered: true, owned: false });
  } finally { rm(dir); }
});

test('malformed .mcp.json degrades to not-registered (no throw)', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{ not valid json');
    assert.deepEqual(codexMcpStatus({}, dir), { registered: false, owned: false });
  } finally { rm(dir); }
});

test('Codex MCP topology detects recursive self-registration, duplicate Ruflo, and AQE readiness', () => {
  const dir = tmpProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-codexmcp-home-'));
  try {
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), [
      '[mcp_servers.codex]',
      'command = "codex"',
      'args = ["mcp-server"]',
      '',
      '[mcp_servers.agentic-qe]',
      'command = "aqe-mcp"',
    ].join('\n'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
      '[mcp_servers.claude-flow]',
      'command = "ruflo"',
      'args = ["mcp", "start"]',
      '',
      '[mcp_servers.ruflo]',
      'command = "ak"',
      'args = ["x", "ruflo-mcp"]',
    ].join('\n'));

    const topology = codexMcpTopology({ cwd: dir, home });
    assert.equal(topology.selfRegistrations.length, 1);
    assert.equal(topology.selfRegistrations[0].scope, 'project');
    assert.equal(topology.agenticQeRegistrations.length, 1);
    assert.equal(topology.agenticQeRegistrations[0].command, 'aqe-mcp');
    assert.equal(topology.rufloRegistrations.length, 2);
    assert.equal(topology.duplicateRuflo, true);
  } finally { rm(dir); rm(home); }
});

test('Codex MCP topology treats absent and malformed files as empty', () => {
  const dir = tmpProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-codexmcp-home-'));
  try {
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), '[broken');
    assert.deepEqual(codexMcpTopology({ cwd: dir, home }), {
      files: [path.join(dir, '.codex', 'config.toml'), path.join(home, '.codex', 'config.toml')],
      registrations: [],
      selfRegistrations: [],
      agenticQeRegistrations: [],
      rufloRegistrations: [],
      duplicateRuflo: false,
    });
  } finally { rm(dir); rm(home); }
});

test('Codex MCP repair plans only remove recursive and legacy duplicate entries', async () => {
  const dir = tmpProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-codexmcp-home-'));
  try {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
      '[mcp_servers.codex]', 'command = "codex"', 'args = ["mcp-server"]', '',
      '[mcp_servers.claude-flow]', 'command = "ruflo"', 'args = ["mcp", "start"]', '',
      '[mcp_servers.ruflo]', 'command = "ak"', 'args = ["x", "ruflo-mcp"]',
    ].join('\n'));
    const topology = codexMcpTopology({ cwd: dir, home });
    const plan = codexMcpRepairPlan(topology);
    assert.deepEqual(plan.map(({ name, reason }) => ({ name, reason })), [
      { name: 'codex', reason: 'recursively launches Codex through the deprecated mcp-server transport' },
      { name: 'claude-flow', reason: 'duplicates the canonical workspace-aware [mcp_servers.ruflo] registration' },
    ]);
    const calls = [];
    const result = await repairCodexMcpTopology(plan, dir, {
      runner: async (command, args, options) => {
        calls.push({ command, args, options });
        return { code: 0, stdout: '', stderr: '' };
      },
      inspect: () => ({ registrations: [] }),
    });
    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(path.join(home, '.codex', 'config.toml.bak')),
      'repair must preserve a recovery copy before changing user-owned config');
    assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
      ['codex', ['mcp', 'remove', 'codex']],
      ['codex', ['mcp', 'remove', 'claude-flow']],
    ]);
  } finally { rm(dir); rm(home); }
});
