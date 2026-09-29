// Decision 3 (docs/plans/2026-09-26-issues-237-238-239-verification-and-decisions.md):
// one recognizer for every host decides which AQE MCP registrations ak may edit.
// Accepted: AQE's own programs started exactly as AQE starts its MCP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recognizedAqeTransport, recognizedAqeCommandLine } from '../../src/lib/aqe-embedding-transport.mjs';
import { aqeTomlEnvironment } from '../../src/lib/aqe-embedding-toml.mjs';
import { inspectAqeEmbeddingProjections } from '../../src/lib/aqe-embedding-projection.mjs';
import { reconcileOpencodeAqeEmbedding } from '../../src/lib/opencode-core.mjs';

const NPX = ['-y', 'agentic-qe@latest', 'mcp'];
const PLATFORMS = ['darwin', 'linux', 'win32'];

// [label, command, args, expected on every platform]
const shared = [
  ['aqe-mcp bin, no args', 'aqe-mcp', [], true],
  ['absolute aqe-mcp, no args', '/opt/homebrew/bin/aqe-mcp', [], true],
  ['aqe-mcp with omitted args', 'aqe-mcp', undefined, true],
  ['aqe mcp', 'aqe', ['mcp'], true],
  ['absolute aqe mcp (#237 reporter)', '/opt/homebrew/bin/aqe', ['mcp'], true],
  ['agentic-qe mcp', 'agentic-qe', ['mcp'], true],
  ['aqe-v3 mcp', '/usr/local/bin/aqe-v3', ['mcp'], true],
  ['npx -y agentic-qe@latest mcp', 'npx', NPX, true],
  ['absolute npx', '/usr/local/bin/npx', NPX, true],
  ['npx.cmd shim', 'npx.cmd', NPX, true],
  ['aqe-mcp.cmd shim', 'aqe-mcp.cmd', [], true],
  ['aqe.cmd shim', 'aqe.cmd', ['mcp'], true],
  ['aqe with extra subcommand', 'aqe', ['mcp', 'start'], false],
  ['aqe with HTTP flags', 'aqe', ['mcp', '--http', '0'], false],
  ['aqe with verbose flag', 'aqe', ['mcp', '--verbose'], false],
  ['aqe without mcp', 'aqe', [], false],
  ['aqe-mcp with args', 'aqe-mcp', ['mcp'], false],
  ['node running the CLI bundle', 'node', ['/x/agentic-qe/dist/cli/bundle.js', 'mcp'], false],
  ['node running the MCP bundle', 'node', ['/x/agentic-qe/dist/mcp/bundle.js'], false],
  ['unpinned npx package', 'npx', ['-y', 'agentic-qe', 'mcp'], true],
  ['npx without -y', 'npx', ['agentic-qe', 'mcp'], true],
  ['npx with extra flag', 'npx', [...NPX, '--verbose'], false],
  // Every plain npx spelling of AQE's server (audit item 5, choice A): an optional
  // single -y/--yes, the package unversioned, @latest or an exact version, then mcp.
  ['npx --yes agentic-qe mcp', 'npx', ['--yes', 'agentic-qe', 'mcp'], true],
  ['npx agentic-qe@latest mcp', 'npx', ['agentic-qe@latest', 'mcp'], true],
  ['npx -y exact version', 'npx', ['-y', 'agentic-qe@3.14.4', 'mcp'], true],
  ['npx --yes exact prerelease', 'npx', ['--yes', 'agentic-qe@3.15.0-rc.1', 'mcp'], true],
  ['npx.cmd --yes unversioned', 'npx.cmd', ['--yes', 'agentic-qe', 'mcp'], true],
  ['npx version range', 'npx', ['-y', 'agentic-qe@^3.14', 'mcp'], false],
  ['npx major-only version', 'npx', ['-y', 'agentic-qe@3', 'mcp'], false],
  ['npx dist-tag other than latest', 'npx', ['-y', 'agentic-qe@next', 'mcp'], false],
  ['npx repeated -y', 'npx', ['-y', '-y', 'agentic-qe', 'mcp'], false],
  ['npx unversioned with extra flag', 'npx', ['-y', 'agentic-qe', 'mcp', '--verbose'], false],
  ['npx --package form', 'npx', ['--package', 'agentic-qe', 'aqe', 'mcp'], false],
  ['npx scoped look-alike package', 'npx', ['-y', '@scope/agentic-qe', 'mcp'], false],
  ['npx without mcp', 'npx', ['-y', 'agentic-qe'], false],
  ['npx -y after the package', 'npx', ['agentic-qe', '-y', 'mcp'], false],
  ['PowerShell shim', 'aqe.ps1', ['mcp'], false],
  ['another AQE bin', 'aqe-court-referee', ['mcp'], false],
  ['shell wrapper', 'bash', ['-c', 'aqe mcp'], false],
  ['non-string command', 42, ['mcp'], false],
  ['non-array args', 'aqe', 'mcp', false],
];

for (const [label, command, args, expected] of shared) {
  for (const platform of PLATFORMS) {
    test(`AQE transport on ${platform}: ${label} → ${expected ? 'recognized' : 'preserved'}`, () => {
      assert.equal(recognizedAqeTransport(command, args, { platform }), expected);
    });
  }
}

test('Windows names are case-insensitive and use Windows path separators', () => {
  const win = { platform: 'win32' };
  assert.equal(recognizedAqeTransport('C:\\Users\\u\\AppData\\Roaming\\npm\\AQE.CMD', ['mcp'], win), true);
  assert.equal(recognizedAqeTransport('C:\\Users\\u\\AppData\\Roaming\\npm\\Aqe-Mcp.cmd', [], win), true);
  assert.equal(recognizedAqeTransport('C:\\Program Files\\nodejs\\NPX.CMD', NPX, win), true);
  assert.equal(recognizedAqeTransport('C:\\tools\\aqe.cmd', ['MCP'], win), false, 'arguments stay exact');
  assert.equal(recognizedAqeTransport('AQE.CMD', ['mcp'], { platform: 'darwin' }), false, 'case-sensitive elsewhere');
});

test('an OpenCode command array is recognized by the same rule', () => {
  assert.equal(recognizedAqeCommandLine(['aqe-mcp']), true);
  assert.equal(recognizedAqeCommandLine(['aqe', 'mcp']), true);
  assert.equal(recognizedAqeCommandLine(['npx', ...NPX]), true);
  assert.equal(recognizedAqeCommandLine(['aqe', 'mcp', 'start']), false);
  assert.equal(recognizedAqeCommandLine([]), false);
  assert.equal(recognizedAqeCommandLine('aqe-mcp'), false);
});

// Every host reaches the same verdict for the same start command.
const endpoint = 'http://127.0.0.1:11434';
function claudeVerdict(t, command, args) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-transport-claude-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { 'agentic-qe': { command, args } } }));
  const cfg = { aqe: true, aqeEmbedding: { mode: 'endpoint', endpoint }, integrations: { hosts: { claude: true, codex: false } } };
  const result = inspectAqeEmbeddingProjections(cfg, cwd, { claudeUserFile: path.join(cwd, 'claude-user.json') });
  const finding = result.findings.find(f => f.file.endsWith('.mcp.json'));
  return finding.status !== 'conflict';
}
function codexVerdict(command, args) {
  try {
    aqeTomlEnvironment(`[mcp_servers.agentic-qe]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`);
    return true;
  } catch { return false; }
}
function opencodeVerdict(t, command) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-transport-opencode-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const configFile = path.join(cwd, 'opencode.json');
  const entry = { type: 'local', command, enabled: true, timeout: 30000, environment: { AQE_EMBEDDER_ENDPOINT: endpoint } };
  fs.writeFileSync(configFile, JSON.stringify({ mcp: { 'agentic-qe': entry } }));
  const cfg = { aqe: true, aqeEmbedding: { mode: 'endpoint', endpoint },
    integrations: { hosts: { opencode: true }, ownership: { opencode: { mcp: null, managed: { mcp: {} } } } } };
  // An equal, unowned endpoint on a recognized entry converges without adopting ownership.
  return reconcileOpencodeAqeEmbedding(cfg, { configFile }).ok;
}

for (const [command, args, expected] of [
  ['aqe-mcp', [], true],
  ['/opt/homebrew/bin/aqe', ['mcp'], true],
  ['agentic-qe', ['mcp'], true],
  ['aqe-v3', ['mcp'], true],
  ['npx', NPX, true],
  ['aqe', ['mcp', 'start'], false],
  ['node', ['/x/agentic-qe/dist/cli/bundle.js', 'mcp'], false],
]) {
  test(`Claude, Codex and OpenCode agree on ${[command, ...args].join(' ')}`, t => {
    assert.deepEqual(
      { claude: claudeVerdict(t, command, args), codex: codexVerdict(command, args), opencode: opencodeVerdict(t, [command, ...args]) },
      { claude: expected, codex: expected, opencode: expected });
  });
}
