import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxHome, sandboxProject, snapshot, assertUnchanged, captureLog } from './helpers/home-sandbox.mjs';

const sandbox = sandboxHome('ak-host-alignment');
const project = sandboxProject('ak-host-alignment');
const other = sandboxProject('ak-host-alignment-other');
const { run } = await import('../../src/commands/run.mjs');
const legacy = { command: 'codex', args: ['mcp-server'] };
const modern = { type: 'http', url: 'https://example.com/mcp' };
function seed() {
  fs.writeFileSync(path.join(sandbox, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  for (const root of [project, other]) fs.writeFileSync(path.join(root, '.mcp.json'), '{}\n');
  fs.mkdirSync(path.join(sandbox, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, '.codex/config.toml'), '');
}

test('ak run refuses retired host MCP transport before launching workers', async () => {
  seed();
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { old: legacy } }));
  const previous = process.cwd();
  process.chdir(project);
  let launched = false;
  try {
    const result = await captureLog(() => run({ flags: { json: true }, positionals: ['feature', 'task'],
      cfg: {}, executePlan: async () => { launched = true; return []; } }));
    assert.equal(result.result, 1, result.out);
    assert.equal(launched, false);
    assert.match(result.out, /host align/);
  } finally { process.chdir(previous); }
});

test('alignment finds actual transports across user, local and selected project scopes', async () => {
  seed();
  fs.writeFileSync(path.join(sandbox, '.claude.json'), JSON.stringify({
    mcpServers: { legacyPeer: legacy, codex: modern },
    projects: { [project]: { mcpServers: { peer: legacy } }, [other]: { mcpServers: { peer: legacy } } },
  }));
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { worker: legacy } }));
  const { inspectHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  const report = inspectHostAlignment({ projectRoots: [project], home: sandbox });
  assert.equal(report.findings.filter(f => f.code === 'retired-codex-mcp').length, 3);
  assert.ok(report.findings.every(f => f.project !== other));
  assert.ok(report.findings.every(f => f.name !== 'codex'));
});

test('approved alignment preserves AQE routes, modern names, unrelated servers and other projects', async () => {
  seed();
  const configFile = path.join(sandbox, '.claude.json');
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { old: legacy, codex: modern },
    projects: { [other]: { mcpServers: { old: legacy } } }, theme: 'dark' }));
  fs.mkdirSync(path.join(project, '.agentic-qe'), { recursive: true });
  const routerFile = path.join(project, '.agentic-qe/llm-config.json');
  const router = '{"agentOverrides":{"qe-test-architect":{"provider":"codex","model":"example"}},"defaultProvider":"claude-code"}\n';
  fs.writeFileSync(routerFile, router);
  const { inspectHostAlignment, applyHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  const plan = inspectHostAlignment({ projectRoots: [project], home: sandbox });
  const result = await applyHostAlignment(plan, { confirmed: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = JSON.parse(fs.readFileSync(configFile));
  assert.deepEqual(after.mcpServers, { codex: modern });
  assert.deepEqual(after.projects[other].mcpServers.old, legacy);
  assert.equal(after.theme, 'dark');
  assert.equal(fs.readFileSync(routerFile, 'utf8'), router);
  assert.ok(result.backups.length > 0);
  assert.equal(inspectHostAlignment({ projectRoots: [project], home: sandbox }).findings.length, 0);
});

test('preview and declined alignment are byte-inert', async () => {
  seed();
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { old: legacy } }));
  const { inspectHostAlignment, applyHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  const before = snapshot(project);
  const report = inspectHostAlignment({ projectRoots: [project], home: sandbox });
  const result = await applyHostAlignment(report, { confirmed: false });
  assert.equal(result.ok, false);
  assertUnchanged(before, project, 'declined alignment');
});

test('changed configuration invalidates approval before any write', async () => {
  seed();
  const file = path.join(project, '.mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { old: legacy } }));
  const { inspectHostAlignment, applyHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  const report = inspectHostAlignment({ projectRoots: [project], home: sandbox });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { old: modern } }));
  const before = snapshot(project);
  const result = await applyHostAlignment(report, { confirmed: true });
  assert.equal(result.ok, false);
  assertUnchanged(before, project, 'stale approval');
});

test('custom legacy transports and malformed JSON are reported but never automatically rewritten', async () => {
  seed();
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { old: { ...legacy, env: { PRIVATE: 'keep' } } } }));
  fs.writeFileSync(path.join(other, '.mcp.json'), '{ malformed');
  const { inspectHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  const report = inspectHostAlignment({ projectRoots: [project, other], home: sandbox });
  assert.ok(report.findings.some(f => f.code === 'config-unassessed'));
  assert.equal(report.findings.find(f => f.code === 'retired-codex-mcp').repairable, false);
});

test('Claude tools-only MCP is informational and is preserved', async () => {
  seed();
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { tools: { command: 'claude', args: ['mcp', 'serve'] } } }));
  const { inspectHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  const report = inspectHostAlignment({ projectRoots: [project], home: sandbox });
  assert.ok(report.findings.some(f => f.code === 'claude-tools-only' && f.level === 'info'));
  assert.equal(report.aligned, true);
});

test('alignment rejects duplicate JSON keys without rewriting their surviving value', async () => {
  seed();
  fs.writeFileSync(path.join(project, '.mcp.json'), '{"mcpServers":{"old":{"command":"other","command":"codex","args":["mcp-server"]}}}');
  const { inspectHostAlignment, applyHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  const before = snapshot(project);
  const report = inspectHostAlignment({ projectRoots: [project], home: sandbox });
  assert.equal(report.aligned, false);
  assert.equal((await applyHostAlignment(report, { confirmed: true })).ok, false);
  assertUnchanged(before, project, 'duplicate JSON keys');
});

test('alignment cleans project Codex self-registration while preserving modern and AQE registrations', async () => {
  seed();
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  const file = path.join(project, '.codex/config.toml');
  const keep = '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\n\n[mcp_servers.claude]\nurl = "https://example.com/mcp"\n';
  fs.writeFileSync(file, '[mcp_servers.codex]\ncommand = "codex"\nargs = ["mcp-server"]\n\n' + keep);
  const { inspectHostAlignment, applyHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  const report = inspectHostAlignment({ projectRoots: [project], home: sandbox });
  const result = await applyHostAlignment(report, { confirmed: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fs.readFileSync(file, 'utf8'), keep);
});

test('explicit realignment remembers only the approved transport recipe and scope', async () => {
  seed();
  const file = path.join(project, '.mcp.json');
  const { alignHosts } = await import('../../src/commands/x/host-align.mjs');
  const { inspectHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  const cfg = {};
  let prompts = 0;
  const options = { flags: { apply: true }, roots: [project], cfg, save: () => {},
    inspect: args => inspectHostAlignment({ ...args, home: sandbox }),
    confirm: async () => { prompts++; return true; } };
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { old: legacy } }));
  assert.equal((await captureLog(() => alignHosts(options))).result, 0);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { old: legacy } }));
  assert.equal((await captureLog(() => alignHosts(options))).result, 0);
  assert.equal(prompts, 1);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { changed: legacy } }));
  assert.equal((await captureLog(() => alignHosts(options))).result, 0);
  assert.equal(prompts, 2, 'another name requires a new approval');
});

test('unassessed TOML table spellings never bypass detection or orphan custom children', async () => {
  seed();
  const file = path.join(sandbox, '.codex/config.toml');
  const { inspectHostAlignment, applyHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  for (const source of [
    '[ mcp_servers . codex ]\ncommand = "codex"\nargs = ["mcp-server"]\n',
    '[mcp_servers.codex]\ncommand = "codex"\nargs = ["mcp-server"]\n[mcp_servers . codex . env]\nCUSTOM = "retain"\n',
  ]) {
    fs.writeFileSync(file, source);
    const report = inspectHostAlignment({ projectRoots: [], home: sandbox });
    assert.equal(report.aligned, false);
    assert.ok(report.findings.some(f => f.code === 'config-unassessed'));
    assert.equal((await applyHostAlignment(report, { confirmed: true })).changed.length, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), source);
  }
});

test('a custom Codex executable is detected without inheriting bare-command repair authority', async () => {
  seed();
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: {
    old: { command: '/custom/bin/codex', args: ['mcp-server'] },
  } }));
  const { inspectHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  const report = inspectHostAlignment({ projectRoots: [project], home: sandbox });
  assert.equal(report.findings[0].repairable, false);
});

test('a multi-project preview digest is stable when its selected roots are reordered', async () => {
  seed();
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { old: legacy } }));
  const { inspectHostAlignment, applyHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  const first = inspectHostAlignment({ projectRoots: [other, project], home: sandbox });
  const second = inspectHostAlignment({ projectRoots: [project, other], home: sandbox });
  assert.equal(first.digest, second.digest);
  assert.equal((await applyHostAlignment(first, { confirmed: true })).ok, true);
});

test('alignment inspects the selected Codex home rather than a different default profile', async () => {
  seed();
  const codexHome = path.join(sandbox, 'alternate-codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[mcp_servers.codex]\ncommand = "codex"\nargs = ["mcp-server"]\n');
  const { inspectHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  const report = inspectHostAlignment({ projectRoots: [], home: sandbox, codexHome });
  assert.equal(report.aligned, false);
  assert.equal(report.findings[0].file, path.join(codexHome, 'config.toml'));
});

test('an overridden Claude config root is unassessed rather than falsely aligned', async () => {
  seed();
  const { inspectHostAlignment } = await import('../../src/lib/host-alignment.mjs');
  const report = inspectHostAlignment({ projectRoots: [], home: sandbox, claudeConfigDir: path.join(sandbox, 'alternate-claude') });
  assert.equal(report.aligned, false);
  assert.equal(report.findings[0].code, 'config-unassessed');
  assert.equal(report.findings[0].repairable, false);
});
