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
const removeTomlFixtureTable = (file, name) => {
  const source = fs.readFileSync(file, 'utf8');
  const header = `[mcp_servers.${name}]`;
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `fixture table ${header} must exist`);
  const next = source.indexOf('\n[mcp_servers.', start + header.length);
  const end = next === -1 ? source.length : next + 1;
  fs.writeFileSync(file, source.slice(0, start) + source.slice(end));
};
const repairBackups = (file) => fs.readdirSync(path.dirname(file))
  .filter((name) => name.startsWith(`${path.basename(file)}.ak-mcp-repair-`) && name.endsWith('.bak'))
  .map((name) => path.join(path.dirname(file), name));

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
    assert.equal(topology.selfRegistrations[0].repairKind, 'recursive-codex');
    assert.equal(topology.agenticQeRegistrations.length, 1);
    assert.equal(topology.agenticQeRegistrations[0].command, 'aqe-mcp');
    assert.equal(topology.rufloRegistrations.length, 2);
    assert.equal(topology.rufloRegistrations.find((entry) => entry.name === 'claude-flow').repairKind,
      'legacy-ruflo');
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
      { name: 'claude-flow', reason: 'replaces the deprecated legacy Ruflo transport with canonical workspace-aware [mcp_servers.ruflo]' },
    ]);
    const calls = [];
    const result = await repairCodexMcpTopology(plan, dir, {
      runner: async (command, args, options) => {
        calls.push({ command, args, options });
        removeTomlFixtureTable(path.join(home, '.codex', 'config.toml'), args.at(-1));
        return { code: 0, stdout: '', stderr: '' };
      },
      inspect: () => codexMcpTopology({ cwd: dir, home }),
    });
    assert.equal(result.ok, true);
    assert.equal(repairBackups(path.join(home, '.codex', 'config.toml')).length, 1,
      'repair must preserve one current-state recovery copy before mutation');
    assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
      ['codex', ['mcp', 'remove', 'codex']],
      ['codex', ['mcp', 'remove', 'claude-flow']],
    ]);
  } finally { rm(dir); rm(home); }
});

test('Codex MCP repair edits project scope directly and user scope through Codex without cross-scope deletion', async () => {
  const dir = tmpProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-codexmcp-home-'));
  try {
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const projectFile = path.join(dir, '.codex', 'config.toml');
    const userFile = path.join(home, '.codex', 'config.toml');
    fs.writeFileSync(projectFile, [
      'model = "preserve-me"', '',
      '[mcp_servers.codex]', 'command = "codex"', 'args = ["mcp-server"]', '',
      '[features]', 'responses_websockets_v2 = true', '',
    ].join('\n'));
    fs.writeFileSync(userFile, [
      '[mcp_servers.codex]', 'command = "codex"', 'args = ["mcp-server"]', '',
      '[mcp_servers.ruflo]', 'command = "ak"', 'args = ["x", "ruflo-mcp"]', '',
    ].join('\n'));
    const plan = codexMcpRepairPlan(codexMcpTopology({ cwd: dir, home }));
    assert.deepEqual(plan.map((entry) => entry.scope), ['project', 'user']);
    const calls = [];
    const result = await repairCodexMcpTopology(plan, dir, {
      runner: async (command, args) => {
        calls.push([command, args]);
        removeTomlFixtureTable(userFile, args.at(-1));
        return { code: 0, stdout: '', stderr: '' };
      },
      inspect: () => codexMcpTopology({ cwd: dir, home }),
    });
    assert.equal(result.ok, true, result.detail);
    assert.deepEqual(calls, [['codex', ['mcp', 'remove', 'codex']]],
      'only the user-scoped target may use Codex\'s user-config command');
    assert.doesNotMatch(fs.readFileSync(projectFile, 'utf8'), /mcp_servers\.codex/);
    assert.match(fs.readFileSync(projectFile, 'utf8'), /model = "preserve-me"/);
    assert.match(fs.readFileSync(projectFile, 'utf8'), /\[features\]/);
    assert.doesNotMatch(fs.readFileSync(userFile, 'utf8'), /mcp_servers\.codex/);
    assert.match(fs.readFileSync(userFile, 'utf8'), /mcp_servers\.ruflo/);
    assert.equal(repairBackups(projectFile).length, 1);
    assert.equal(repairBackups(userFile).length, 1);
  } finally { rm(dir); rm(home); }
});

test('Codex MCP repair plan rejects lookalikes, custom registrations, extra fields, and child tables', async () => {
  const dir = tmpProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-codexmcp-home-'));
  try {
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), [
      '[mcp_servers.codex]', 'command = "codex"', 'args = ["mcp-server"]',
      'startup_timeout_sec = 30', '',
      '[mcp_servers.codex.env]', 'SAFE = "1"', '',
    ].join('\n'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
      '[mcp_servers.claude-flow]', 'command = "my-custom-server"', 'args = ["mcp", "start"]', '',
      '[mcp_servers."team-browser"]', 'command = "ruflo"', 'args = ["mcp", "start"]', '',
    ].join('\n'));
    const topology = codexMcpTopology({ cwd: dir, home });
    assert.equal(topology.selfRegistrations.length, 1, 'the recursive hazard remains visible');
    assert.deepEqual(codexMcpRepairPlan(topology), [], 'no lookalike is safe to auto-remove');
    let called = false;
    const forged = { ...topology.selfRegistrations[0], repairKind: null };
    const result = await repairCodexMcpTopology([forged], dir, {
      runner: async () => { called = true; return { code: 0, stdout: '', stderr: '' }; },
      inspect: () => topology,
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /not a recognized disclosed legacy shape/);
    assert.equal(called, false);
  } finally { rm(dir); rm(home); }
});

test('Codex MCP repair aborts before mutation when a confirmed table changes identity', async () => {
  const dir = tmpProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-codexmcp-home-'));
  try {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const file = path.join(home, '.codex', 'config.toml');
    fs.writeFileSync(file, [
      '[mcp_servers.codex]', 'command = "codex"', 'args = ["mcp-server"]', '',
    ].join('\n'));
    const plan = codexMcpRepairPlan(codexMcpTopology({ cwd: dir, home }));
    fs.writeFileSync(file, [
      '[mcp_servers.codex]', 'command = "codex"', 'args = ["mcp-server", "--changed"]', '',
    ].join('\n'));
    const changed = fs.readFileSync(file, 'utf8');
    let called = false;
    const result = await repairCodexMcpTopology(plan, dir, {
      runner: async () => { called = true; return { code: 0, stdout: '', stderr: '' }; },
      inspect: () => codexMcpTopology({ cwd: dir, home }),
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /changed after confirmation/);
    assert.equal(called, false);
    assert.equal(fs.readFileSync(file, 'utf8'), changed);
    assert.equal(fs.existsSync(`${file}.bak`), false, 'identity drift aborts before backup/write');
  } finally { rm(dir); rm(home); }
});

test('Codex MCP repair refuses symlinked config and preserves a stale generic backup', async (t) => {
  if (process.platform === 'win32') return t.skip('file symlink privileges vary on Windows CI');
  const dir = tmpProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-codexmcp-home-'));
  try {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const realFile = path.join(home, 'real-config.toml');
    const linkedFile = path.join(home, '.codex', 'config.toml');
    const source = [
      '[mcp_servers.codex]', 'command = "codex"', 'args = ["mcp-server"]', '',
      '[mcp_servers.claude-flow]', 'command = "ruflo"', 'args = ["mcp", "start"]', '',
      '[mcp_servers.ruflo]', 'command = "ak"', 'args = ["x", "ruflo-mcp"]', '',
    ].join('\n');
    fs.writeFileSync(realFile, source);
    fs.symlinkSync(realFile, linkedFile);
    const linkedTopology = codexMcpTopology({ cwd: dir, home });
    assert.equal(linkedTopology.selfRegistrations.length, 1, 'the hazard remains visible');
    assert.equal(linkedTopology.rufloRegistrations.length, 2,
      'the legacy Ruflo transport remains visible beside the canonical entry');
    assert.equal(linkedTopology.duplicateRuflo, true);
    assert.deepEqual(codexMcpRepairPlan(linkedTopology), [], 'a symlink is never auto-repaired');
    assert.equal(fs.lstatSync(linkedFile).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(realFile, 'utf8'), source);

    fs.unlinkSync(linkedFile);
    fs.writeFileSync(linkedFile, source);
    fs.writeFileSync(`${linkedFile}.bak`, 'older recovery state');
    const plan = codexMcpRepairPlan(codexMcpTopology({ cwd: dir, home }));
    const result = await repairCodexMcpTopology(plan, dir, {
      runner: async (_command, args) => {
        removeTomlFixtureTable(linkedFile, args.at(-1));
        return { code: 0, stdout: '', stderr: '' };
      },
      inspect: () => codexMcpTopology({ cwd: dir, home }),
    });
    assert.equal(result.ok, true, result.detail);
    assert.equal(fs.readFileSync(`${linkedFile}.bak`, 'utf8'), 'older recovery state');
    const backups = repairBackups(linkedFile);
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(backups[0], 'utf8'), source,
      'the repair-specific recovery copy captures immediate pre-repair bytes');
  } finally { rm(dir); rm(home); }
});
