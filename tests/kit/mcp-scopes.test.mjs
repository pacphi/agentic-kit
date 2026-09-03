import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  claudeMcpTopology, registrationStatus, register, agentBrowserMcpConfigured,
} from '../../src/lib/mcp.mjs';
import { agentBrowserConfigPath } from '../../src/lib/paths.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-mcp-scopes-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, cwd };
}

test('Claude MCP topology reads local, project, and user scopes with documented precedence', (t) => {
  const { home, cwd } = fixture(t);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      'claude-flow': { command: 'ruflo', args: ['mcp', 'start'] },
    },
    projects: {
      [cwd]: {
        mcpServers: {
          ruflo: { command: 'npx', args: ['ruflo', 'mcp', 'start'] },
        },
      },
    },
  }));
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'claude-flow': { command: 'ak', args: ['x', 'ruflo-mcp'] },
      ruflo: { command: 'ruflo', args: ['mcp', 'start'] },
    },
  }));

  const topology = claudeMcpTopology({ cwd, home });
  assert.deepEqual(topology.claudeFlowScopes, ['project', 'user']);
  assert.deepEqual(topology.legacyRufloScopes, ['local', 'project']);
  assert.equal(topology.effective.claudeFlow?.scope, 'project');
  assert.equal(topology.effective.legacyRuflo?.scope, 'local');
  assert.equal(topology.registrations.length, 4);
});

test('registration status never claims scoped legacy entries will be silently migrated', (t) => {
  const { home, cwd } = fixture(t);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    projects: {
      [cwd]: { mcpServers: { ruflo: { command: 'ruflo', args: ['mcp', 'start'] } } },
    },
  }));

  const status = registrationStatus({ cwd, home, settingsFile: path.join(home, 'settings.json') });
  assert.equal(status.claudeFlow, false);
  assert.equal(status.legacyRuflo, true);
  assert.deepEqual(status.legacyRufloScopes, ['local']);
  assert.deepEqual(status.autoMigratableLegacyScopes, []);
  assert.deepEqual(status.preservedLegacyScopes, ['local']);
});

test('a user-scoped legacy key remains the only automatically migratable scope', (t) => {
  const { home, cwd } = fixture(t);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { ruflo: { command: 'ruflo', args: ['mcp', 'start'] } },
  }));

  const status = registrationStatus({ cwd, home, settingsFile: path.join(home, 'settings.json') });
  assert.deepEqual(status.autoMigratableLegacyScopes, ['user']);
  assert.deepEqual(status.preservedLegacyScopes, []);
});

test('Claude registration scopes the trusted browser config to the Ruflo MCP child', async () => {
  const calls = [];
  const ok = await register({ agentBrowser: true }, {
    runner: async (bin, args) => { calls.push([bin, args]); return { code: 0, stdout: '', stderr: '' }; },
    inspect: () => ({ registrations: [{
      name: 'ruflo', scope: 'user', command: 'ruflo', args: ['mcp', 'start'], env: {},
    }] }),
  });
  assert.equal(ok, true);
  assert.deepEqual(calls[0], ['claude', ['mcp', 'remove', 'ruflo', '-s', 'user']]);
  assert.deepEqual(calls[1], ['claude', [
    'mcp', 'add', 'claude-flow', '-s', 'user',
    '-e', `AGENT_BROWSER_CONFIG=${agentBrowserConfigPath()}`,
    '--', 'ruflo', 'mcp', 'start',
  ]]);
  assert.equal(agentBrowserMcpConfigured({ env: { AGENT_BROWSER_CONFIG: agentBrowserConfigPath() } }), true);
  assert.equal(agentBrowserMcpConfigured({ env: {} }), false);
});

test('Claude registration safely replaces the prior canonical claude-flow entry', async () => {
  const calls = [];
  const ok = await register({ agentBrowser: true }, {
    runner: async (bin, args) => { calls.push([bin, args]); return { code: 0, stdout: '', stderr: '' }; },
    inspect: () => ({ registrations: [{
      name: 'claude-flow', scope: 'user', command: 'ruflo', args: ['mcp', 'start'], env: {},
    }] }),
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [
    ['claude', ['mcp', 'remove', 'claude-flow', '-s', 'user']],
    ['claude', [
      'mcp', 'add', 'claude-flow', '-s', 'user',
      '-e', `AGENT_BROWSER_CONFIG=${agentBrowserConfigPath()}`,
      '--', 'ruflo', 'mcp', 'start',
    ]],
  ]);
});

test('Claude registration preserves a conflicting user-owned claude-flow entry', async () => {
  const calls = [];
  const ok = await register({ agentBrowser: true }, {
    runner: async (bin, args) => { calls.push([bin, args]); return { code: 0, stdout: '', stderr: '' }; },
    inspect: () => ({ registrations: [{
      name: 'claude-flow', scope: 'user', command: 'custom-wrapper', args: [], env: {},
    }] }),
  });
  assert.equal(ok, false);
  assert.deepEqual(calls, []);
});

test('Claude registration restores the prior canonical entry if replacement fails', async () => {
  const calls = [];
  const old = {
    name: 'claude-flow', scope: 'user', command: 'ruflo', args: ['mcp', 'start'], env: {},
  };
  const ok = await register({ agentBrowser: true }, {
    runner: async (bin, args) => {
      calls.push([bin, args]);
      if (args[0] === 'mcp' && args[1] === 'add' && args.includes('AGENT_BROWSER_CONFIG=' + agentBrowserConfigPath())) {
        return { code: 1, stdout: '', stderr: 'synthetic failure' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    inspect: () => ({ registrations: [old] }),
  });
  assert.equal(ok, false);
  assert.deepEqual(calls.at(-1), ['claude', [
    'mcp', 'add', 'claude-flow', '-s', 'user', '--', 'ruflo', 'mcp', 'start',
  ]]);
});
