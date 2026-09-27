import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  claudeMcpTopology, registrationStatus, register, agentBrowserMcpConfigured,
} from '../../src/lib/mcp.mjs';
import * as mcpLib from '../../src/lib/mcp.mjs';
import * as mcpSection from '../../src/commands/status/sections/mcp.mjs';
import { agentBrowserConfigPath } from '../../src/lib/paths.mjs';

// register() refuses when `ak` is not on PATH (the registration starts it);
// every test injects the lookup so none depends on the machine's PATH.
const akOnPath = async (bin) => bin === 'ak';

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
  const { ok } = await register({ agentBrowser: true }, {
    haveFn: akOnPath,
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
    '--', 'ak', 'x', 'ruflo-mcp', '--host', 'claude',
  ]]);
  assert.equal(agentBrowserMcpConfigured({ env: { AGENT_BROWSER_CONFIG: agentBrowserConfigPath() } }), true);
  assert.equal(agentBrowserMcpConfigured({ env: {} }), false);
});

test('Claude registration safely replaces the prior canonical claude-flow entry', async () => {
  const calls = [];
  const { ok } = await register({ agentBrowser: true }, {
    haveFn: akOnPath,
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
      '--', 'ak', 'x', 'ruflo-mcp', '--host', 'claude',
    ]],
  ]);
});

// ADR-0016 §4 / ADR-0058 §3 (Inherits): ak never writes ruflo component keys into a
// registration, so a registration carrying one is the user's — its value overrides the
// settings env and must survive, never be re-added without it.
test('Claude registration preserves a user registration carrying a ruflo component env key', async () => {
  const calls = [];
  const { ok } = await register({ agentBrowser: true }, {
    haveFn: akOnPath,
    runner: async (bin, args) => { calls.push([bin, args]); return { code: 0, stdout: '', stderr: '' }; },
    inspect: () => ({ registrations: [{
      name: 'claude-flow', scope: 'user', command: 'ruflo', args: ['mcp', 'start'],
      env: { RUFLO_INTELLIGENCE_MODE: 'research' },
    }] }),
  });
  assert.equal(ok, false);
  assert.deepEqual(calls, []);
});

test('Claude registration preserves a canonical entry carrying a foreign env key alongside a component key', async () => {
  const calls = [];
  const { ok } = await register({ agentBrowser: true }, {
    haveFn: akOnPath,
    runner: async (bin, args) => { calls.push([bin, args]); return { code: 0, stdout: '', stderr: '' }; },
    inspect: () => ({ registrations: [{
      name: 'claude-flow', scope: 'user', command: 'ruflo', args: ['mcp', 'start'],
      env: { RUFLO_INTELLIGENCE_MODE: 'research', MY_KEY: 'user-value' },
    }] }),
  });
  assert.equal(ok, false);
  assert.deepEqual(calls, []);
});

test('Claude registration preserves a conflicting user-owned claude-flow entry', async () => {
  const calls = [];
  const { ok } = await register({ agentBrowser: true }, {
    haveFn: akOnPath,
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
  const { ok } = await register({ agentBrowser: true }, {
    haveFn: akOnPath,
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

// #237 S1 / ADR-0016 (2026-09-02): ak auto-migrates only the legacy user-scope
// registration it wrote itself (`ruflo mcp start`, optionally with ak's
// AGENT_BROWSER_CONFIG). Status and register() must share that ONE predicate:
// status once promised "sync migrates it" for any user-scope `ruflo` key while
// register() silently kept every other shape, and sync printed ✓.
const PRESERVED_LEGACY_SHAPES = {
  'absolute path with ["mcp"]': { command: '/opt/homebrew/bin/ruflo', args: ['mcp'] },
  'ruflo with ["mcp"]': { command: 'ruflo', args: ['mcp'] },
  'absolute path with ["mcp","start"]': { command: '/usr/local/bin/ruflo', args: ['mcp', 'start'] },
  'a custom env': { command: 'ruflo', args: ['mcp', 'start'], env: { MY_TOKEN: 'user-value' } },
};
const recordingRunner = (calls) => async (bin, args) => {
  calls.push([bin, args]);
  return { code: 0, stdout: '', stderr: '' };
};

for (const [label, shape] of Object.entries(PRESERVED_LEGACY_SHAPES)) {
  test(`a user-scope legacy 'ruflo' entry with ${label} is preserved by status and register alike`, async (t) => {
    const { home, cwd } = fixture(t);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { ruflo: shape } }));
    const settingsFile = path.join(home, 'settings.json');

    const status = registrationStatus({ cwd, home, settingsFile });
    assert.deepEqual(status.autoMigratableLegacyScopes, [], 'status must not promise a migration register() refuses');
    assert.deepEqual(status.preservedLegacyScopes, ['user']);

    const calls = [];
    const result = await register({ agentBrowser: false }, {
    haveFn: akOnPath,
      runner: recordingRunner(calls), inspect: () => claudeMcpTopology({ cwd, home }),
    });
    assert.equal(result.ok, true, 'claude-flow is still registered');
    assert.deepEqual(result.preserved.map((entry) => [entry.name, entry.scope]), [['ruflo', 'user']]);
    assert.ok(result.preserved.every((entry) => !('env' in entry)), 'preserved entries never carry env values');
    assert.ok(!calls.some(([, args]) => args[1] === 'remove' && args[2] === 'ruflo'), 'a preserved entry is never removed');

    const entry = claudeMcpTopology({ cwd, home }).registrations.find((candidate) => candidate.name === 'ruflo');
    assert.equal(mcpLib.legacyRufloDisposition(entry), 'preserved');

    const legacyRow = mcpSection.mcpRows(status, { mcp: { register: true }, agentBrowser: false })
      .find((r) => /legacy 'ruflo'/.test(r.message));
    assert.equal(legacyRow.fix, 'claude mcp remove ruflo -s user');
    assert.equal(legacyRow.repair, 'manual', 'sync cannot perform this, so it is never planned');
  });
}

test("ak's own legacy 'ruflo mcp start' registration is still migrated (control)", async (t) => {
  const { home, cwd } = fixture(t);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { ruflo: { command: 'ruflo', args: ['mcp', 'start'] } },
  }));
  const entry = claudeMcpTopology({ cwd, home }).registrations.find((candidate) => candidate.name === 'ruflo');
  assert.equal(mcpLib.legacyRufloDisposition(entry), 'replaceable');
  const status = registrationStatus({ cwd, home, settingsFile: path.join(home, 'settings.json') });
  assert.deepEqual(status.autoMigratableLegacyScopes, ['user']);

  const calls = [];
  const result = await register({ agentBrowser: false }, {
    haveFn: akOnPath,
    runner: recordingRunner(calls), inspect: () => claudeMcpTopology({ cwd, home }),
  });
  assert.deepEqual(result, { ok: true, preserved: [] });
  assert.deepEqual(calls[0], ['claude', ['mcp', 'remove', 'ruflo', '-s', 'user']]);

  const legacyRow = mcpSection.mcpRows(status, { mcp: { register: true }, agentBrowser: false })
    .find((r) => /legacy 'ruflo'/.test(r.message));
  assert.equal(legacyRow.fix, 'sync migrates it to claude-flow at user scope');
  assert.equal(legacyRow.repair, 'sync');
});

test('a project-scope legacy entry is reported with its manual command, never a sync fix', (t) => {
  const { home, cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({
    mcpServers: { ruflo: { command: 'ruflo', args: ['mcp', 'start'] } },
  }));
  const entry = claudeMcpTopology({ cwd, home }).registrations.find((candidate) => candidate.name === 'ruflo');
  assert.equal(mcpLib.legacyRufloDisposition(entry), 'preserved', 'only the user scope is ak-owned');
  const status = registrationStatus({ cwd, home, settingsFile: path.join(home, 'settings.json') });
  const legacyRow = mcpSection.mcpRows(status, { mcp: { register: true }, agentBrowser: false })
    .find((r) => /legacy 'ruflo'/.test(r.message));
  assert.equal(legacyRow.fix, 'claude mcp remove ruflo -s project');
  assert.equal(legacyRow.repair, 'manual');
});

// B3-D1: Claude Code's Ruflo MCP starts through ak's launcher, so a session in
// a subfolder or outside any project uses the same store rule as Codex.
const LAUNCHER = { command: 'ak', args: ['x', 'ruflo-mcp', '--host', 'claude'] };

test('an already-launcher registration with the managed browser config makes no calls', async () => {
  const calls = [];
  const result = await register({ agentBrowser: true }, {
    haveFn: akOnPath, runner: recordingRunner(calls),
    inspect: () => ({ registrations: [{
      name: 'claude-flow', scope: 'user', ...LAUNCHER, env: { AGENT_BROWSER_CONFIG: agentBrowserConfigPath() },
    }] }),
  });
  assert.deepEqual(result, { ok: true, preserved: [] });
  assert.deepEqual(calls, []);
});

test('the launcher registration is replaced when the browser config changes, and a user env key preserves it', async () => {
  const calls = [];
  const replaced = await register({ agentBrowser: false }, {
    haveFn: akOnPath, runner: recordingRunner(calls),
    inspect: () => ({ registrations: [{
      name: 'claude-flow', scope: 'user', ...LAUNCHER, env: { AGENT_BROWSER_CONFIG: agentBrowserConfigPath() },
    }] }),
  });
  assert.equal(replaced.ok, true);
  assert.deepEqual(calls, [
    ['claude', ['mcp', 'remove', 'claude-flow', '-s', 'user']],
    ['claude', ['mcp', 'add', 'claude-flow', '-s', 'user', '--', 'ak', 'x', 'ruflo-mcp', '--host', 'claude']],
  ]);
  const kept = [];
  const preserved = await register({ agentBrowser: true }, {
    haveFn: akOnPath, runner: recordingRunner(kept),
    inspect: () => ({ registrations: [{
      name: 'claude-flow', scope: 'user', ...LAUNCHER, env: { MY_KEY: 'mine' },
    }] }),
  });
  assert.equal(preserved.ok, false);
  assert.deepEqual(kept, []);
});

test('register refuses without touching anything when ak is not on PATH', async () => {
  const calls = [];
  const result = await register({ agentBrowser: true }, {
    haveFn: async () => false, runner: recordingRunner(calls),
    inspect: () => ({ registrations: [{
      name: 'claude-flow', scope: 'user', command: 'ruflo', args: ['mcp', 'start'], env: {},
    }] }),
  });
  assert.deepEqual(result, { ok: false, reason: 'ak-not-on-path', preserved: [] });
  assert.deepEqual(calls, []);
});

test('status asks sync to move ak\'s old ruflo mcp start registration onto the launcher', (t) => {
  const { home, cwd } = fixture(t);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'claude-flow': { command: 'ruflo', args: ['mcp', 'start'] } },
  }));
  const status = registrationStatus({ cwd, home, settingsFile: path.join(home, 'settings.json') });
  const rows = mcpSection.mcpRows(status, { mcp: { register: true }, agentBrowser: false }, { cwd, home });
  const stale = rows.find((r) => /does not start through `ak x ruflo-mcp`/.test(r.message));
  assert.ok(stale, JSON.stringify(rows));
  assert.equal(stale.level, 'warn');
  assert.equal(stale.repair, 'sync');
  const unmanaged = mcpSection.mcpRows(status, { mcp: { register: false }, agentBrowser: false }, { cwd, home })
    .find((r) => /does not start through `ak x ruflo-mcp`/.test(r.message));
  assert.equal(unmanaged.repair, 'manual', 'with registration off, sync never re-registers');
});

test('status names the store the launcher picks from this folder', (t) => {
  const { home, cwd } = fixture(t);
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'claude-flow': LAUNCHER },
  }));
  const status = registrationStatus({ cwd, home, settingsFile: path.join(home, 'settings.json') });
  const cfg = { mcp: { register: true }, agentBrowser: false };
  const here = mcpSection.mcpRows(status, cfg, { cwd, home }).find((r) => /Claude Code's Ruflo MCP/.test(r.message));
  assert.equal(here.level, 'ok');
  assert.equal(here.message, "Claude Code's Ruflo MCP starts through `ak x ruflo-mcp`; from here it uses "
    + `${path.join(fs.realpathSync(cwd), '.swarm')}`);
  const outside = mcpSection.mcpRows(status, cfg, { cwd: home, home }).find((r) => /Claude Code's Ruflo MCP/.test(r.message));
  assert.match(outside.message, /from here it uses the user-level store .*\.claude-flow.memory \(this folder is the home folder\)/);
});

// Plan Task 4.2: register() refuses with 'ak-not-on-path' when it would write
// a registration that starts `ak`, so every row whose sync fix goes through
// that write is the user's step until `ak` resolves on PATH.
const AK_OFF_PATH_FIX = 'put `ak` on PATH, then run `ak sync`';

test('without ak on PATH, the rows whose fix re-registers claude-flow are manual steps', (t) => {
  const { home, cwd } = fixture(t);
  const settingsFile = path.join(home, 'settings.json');
  const cfg = { mcp: { register: true }, agentBrowser: false };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'claude-flow': { command: 'ruflo', args: ['mcp', 'start'] } },
  }));
  const stale = mcpSection.mcpRows(registrationStatus({ cwd, home, settingsFile }), cfg, { cwd, home, akOnPath: false })
    .find((r) => /does not start through `ak x ruflo-mcp`/.test(r.message));
  assert.equal(stale.repair, 'manual');
  assert.equal(stale.fix, AK_OFF_PATH_FIX);

  const browserRow = mcpSection.mcpRows(registrationStatus({ cwd, home, settingsFile }),
    { ...cfg, agentBrowser: true }, { cwd, home, akOnPath: false })
    .find((r) => /agent-browser config/.test(r.message));
  assert.equal(browserRow.repair, 'manual');
  assert.equal(browserRow.fix, AK_OFF_PATH_FIX);

  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  const missing = mcpSection.mcpRows(registrationStatus({ cwd, home, settingsFile }), cfg, { cwd, home, akOnPath: false })
    .find((r) => /not registered/.test(r.message));
  assert.equal(missing.repair, 'manual');
  assert.equal(missing.fix, AK_OFF_PATH_FIX);
});

test('the mcp section looks ak up only when ak manages the registration', async (t) => {
  const { home, cwd } = fixture(t);
  const looked = [];
  const haveFn = async (cmd) => { looked.push(cmd); return false; };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  const status = () => registrationStatus({ cwd, home, settingsFile: path.join(home, 'settings.json') });
  await mcpSection.default.collect({ cfg: { mcp: { register: false }, agentBrowser: false }, cwd, home, haveFn, status });
  assert.deepEqual(looked, []);
  const rows = await mcpSection.default.collect({ cfg: { mcp: { register: true }, agentBrowser: false }, cwd, home, haveFn, status });
  assert.deepEqual(looked, ['ak']);
  assert.equal(rows.find((r) => /not registered/.test(r.message)).fix, AK_OFF_PATH_FIX);
});
