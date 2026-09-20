import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectAqeEmbeddingProjections as inspect, reconcileAqeEmbeddingProjections as reconcile,
  prepareAqeEmbeddingInitialization } from '../../src/lib/aqe-embedding-projection.mjs';
import { applyOpencode, opencodeConverged } from '../../src/lib/opencode-core.mjs';
const inspectAqeEmbeddingProjections = (cfg, cwd, opts = {}) => inspect(cfg, cwd, { claudeUserFile: path.join(cwd, 'claude-user.json'), ...opts });
const reconcileAqeEmbeddingProjections = (cfg, cwd, opts = {}) => reconcile(cfg, cwd, { claudeUserFile: path.join(cwd, 'claude-user.json'), ...opts });

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-projection-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(cwd, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file;
  };
  const cfg = { aqe: true, aqeEmbedding: { mode: 'endpoint', endpoint: 'http://localhost:11434' }, integrations: { hosts: { claude: true, codex: false } } };
  return { cwd, write, cfg };
}

test('projects endpoint with receipts, converges, and restores only owned values', t => {
  const { cwd, write, cfg } = fixture(t);
  const file = write('.mcp.json', { mcpServers: { 'agentic-qe': { command: 'aqe-mcp', env: { KEEP: 'yes' } } } });
  assert.equal(inspectAqeEmbeddingProjections(cfg, cwd).changed, true);
  assert.equal(reconcileAqeEmbeddingProjections(cfg, cwd).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file)).mcpServers['agentic-qe'].env.AQE_EMBEDDER_ENDPOINT, cfg.aqeEmbedding.endpoint);
  assert.equal(inspectAqeEmbeddingProjections(cfg, cwd).changed, false);
  cfg.aqeEmbedding = { mode: 'unmanaged' };
  assert.equal(reconcileAqeEmbeddingProjections(cfg, cwd).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).mcpServers['agentic-qe'].env, { KEEP: 'yes' });
});

test('preserves conflicting foreign endpoint and reports unresolved drift', t => {
  const { cwd, write, cfg } = fixture(t);
  const file = write('.mcp.json', { mcpServers: { 'agentic-qe': { command: 'aqe-mcp', env: { AQE_EMBEDDER_ENDPOINT: 'http://foreign:1234' } } } });
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(reconcileAqeEmbeddingProjections(cfg, cwd).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('dry run writes nothing and equal unowned values remain untouched on disable', t => {
  const { cwd, write, cfg } = fixture(t);
  const file = write('.claude/settings.local.json', { env: { AQE_EMBEDDER_ENDPOINT: cfg.aqeEmbedding.endpoint } });
  const before = fs.readFileSync(file, 'utf8');
  reconcileAqeEmbeddingProjections(cfg, cwd, { dryRun: true });
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
  reconcileAqeEmbeddingProjections(cfg, cwd);
  cfg.aqeEmbedding.mode = 'unmanaged';
  reconcileAqeEmbeddingProjections(cfg, cwd);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('in-process projects empty endpoint and preserves later user edits', t => {
  const { cwd, write, cfg } = fixture(t);
  cfg.aqeEmbedding = { mode: 'in-process' };
  const file = write('.claude/settings.local.json', { env: { KEEP: 'yes' } });
  reconcileAqeEmbeddingProjections(cfg, cwd);
  assert.equal(JSON.parse(fs.readFileSync(file)).env.AQE_EMBEDDER_ENDPOINT, '');
  write('.claude/settings.local.json', { env: { AQE_EMBEDDER_ENDPOINT: 'http://user:12' } });
  cfg.aqeEmbedding.mode = 'unmanaged';
  assert.equal(reconcileAqeEmbeddingProjections(cfg, cwd).ok, false);
  assert.equal(JSON.parse(fs.readFileSync(file)).env.AQE_EMBEDDER_ENDPOINT, 'http://user:12');
});

test('Codex projection preserves unrelated TOML and removes owned endpoint on disable', t => {
  const { cwd, write, cfg } = fixture(t);
  cfg.integrations.hosts = { codex: true };
  const file = write('.codex/config.toml', '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\nargs = []\n\n[other]\nkeep = "yes"\n');
  const opts = { codexHome: path.join(cwd, 'unused-user-home') };
  assert.equal(reconcileAqeEmbeddingProjections(cfg, cwd, opts).ok, true);
  assert.match(fs.readFileSync(file, 'utf8'), /\[mcp_servers.agentic-qe.env\]\nAQE_EMBEDDER_ENDPOINT = "http:\/\/localhost:11434"/);
  assert.equal(inspectAqeEmbeddingProjections(cfg, cwd, opts).changed, false);
  cfg.aqeEmbedding.mode = 'unmanaged';
  assert.equal(reconcileAqeEmbeddingProjections(cfg, cwd, opts).ok, true);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /AQE_EMBEDDER_ENDPOINT/);
  assert.match(fs.readFileSync(file, 'utf8'), /keep = "yes"/);
});

test('refuses symlinks and malformed JSON without losing contents', t => {
  const { cwd, write, cfg } = fixture(t);
  const original = write('original.json', '{}');
  fs.symlinkSync(original, path.join(cwd, '.mcp.json'));
  write('.claude/settings.local.json', '{ invalid');
  assert.equal(reconcileAqeEmbeddingProjections(cfg, cwd).ok, false);
  assert.equal(fs.readFileSync(original, 'utf8'), '{}');
  assert.equal(fs.readFileSync(path.join(cwd, '.claude/settings.local.json'), 'utf8'), '{ invalid');
});

test('unsupported Codex inline environment is reported without replacement', t => {
  const { cwd, write, cfg } = fixture(t);
  cfg.integrations.hosts = { codex: true };
  const source = '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\nenv = { KEEP = "yes" }\n';
  const file = write('.codex/config.toml', source);
  assert.equal(reconcileAqeEmbeddingProjections(cfg, cwd, { codexHome: path.join(cwd, 'none') }).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
});

test('OpenCode uses existing entry ownership for endpoint lifecycle', async t => {
  const { cwd, cfg } = fixture(t);
  cfg.integrations.hosts = { opencode: true };
  const configFile = path.join(cwd, 'opencode.json');
  const opts = { configFile, brainShim: path.join(cwd, 'no-brain') };
  const first = await applyOpencode(cfg, opts);
  assert.equal(first.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(configFile)).mcp['agentic-qe'].environment.AQE_EMBEDDER_ENDPOINT, cfg.aqeEmbedding.endpoint);
  assert.equal((await opencodeConverged(cfg, opts)).converged, true);
  cfg.aqeEmbedding = { mode: 'unmanaged' };
  assert.equal((await opencodeConverged(cfg, opts)).converged, false);
  assert.equal((await applyOpencode(cfg, opts)).ok, true);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(configFile)).mcp['agentic-qe'].environment, 'AQE_EMBEDDER_ENDPOINT'), false);
});

test('host disable restores owned values without claiming equal foreign values', t => {
  const { cwd, write, cfg } = fixture(t);
  const file = write('.claude/settings.local.json', { env: { KEEP: 'yes' } });
  reconcileAqeEmbeddingProjections(cfg, cwd);
  cfg.integrations.hosts.claude = false;
  assert.equal(reconcileAqeEmbeddingProjections(cfg, cwd).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).env, { KEEP: 'yes' });
});

test('interrupted receipt does not authorize a second overwrite', t => {
  const { cwd, write, cfg } = fixture(t);
  const file = write('.claude/settings.local.json', { env: { KEEP: 'yes' } });
  write('.claude/settings.local.json.agentic-kit-aqe-embedding.json', {
    version: 1, before: { present: false }, after: { present: true, value: cfg.aqeEmbedding.endpoint }, pending: true,
  });
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(reconcileAqeEmbeddingProjections(cfg, cwd).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('refuses a symlinked configuration directory', t => {
  const { cwd, write, cfg } = fixture(t);
  const file = write('external/settings.local.json', '{}');
  fs.symlinkSync(path.dirname(file), path.join(cwd, '.claude'));
  assert.equal(reconcileAqeEmbeddingProjections(cfg, cwd).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
});

test('AQE disabled leaves all configuration untouched', t => {
  const { cwd, write, cfg } = fixture(t);
  const file = write('.claude/settings.local.json', '{}');
  cfg.aqe = false;
  assert.deepEqual(reconcileAqeEmbeddingProjections(cfg, cwd).findings, []);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
});

test('recognizes upstream npx generator and safely relinquishes before repeat initialization', t => {
  const { cwd, write, cfg } = fixture(t);
  cfg.integrations.hosts = { claude: true, codex: true };
  const json = { mcpServers: { 'agentic-qe': { command: 'npx', args: ['-y', 'agentic-qe@latest', 'mcp'] } } };
  const toml = '[mcp_servers.agentic-qe]\ncommand = "npx"\nargs = ["-y", "agentic-qe@latest", "mcp"]\n';
  write('.mcp.json', json); write('.codex/config.toml', toml);
  const options = { codexHome: path.join(cwd, 'no-user'), claudeUserFile: path.join(cwd, 'no-claude') };
  assert.equal(reconcileAqeEmbeddingProjections(cfg, cwd, options).ok, true);
  assert.equal(prepareAqeEmbeddingInitialization(cfg, cwd, options).ok, true);
  write('.mcp.json', json); write('.codex/config.toml', toml);
  assert.equal(reconcileAqeEmbeddingProjections(cfg, cwd, options).ok, true);
  assert.equal(inspectAqeEmbeddingProjections(cfg, cwd, options).changed, false);
});

test('refuses extra wrapper arguments and never prints malformed JSON content', t => {
  const { cwd, write, cfg } = fixture(t);
  write('.mcp.json', { mcpServers: { 'agentic-qe': { command: 'npx', args: ['-y', 'foreign-package', 'mcp'] } } });
  write('.claude/settings.local.json', '{"secret":"DO_NOT_PRINT_SECRET", unexpected}');
  const result = reconcileAqeEmbeddingProjections(cfg, cwd);
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_PRINT_SECRET/);
});

test('reports overriding Claude local endpoint conflict without changing it', t => {
  const { cwd, write, cfg } = fixture(t);
  write('.mcp.json', { mcpServers: { 'agentic-qe': { command: 'aqe-mcp' } } });
  const user = write('claude-user.json', { projects: { [cwd]: { mcpServers: { 'agentic-qe': {
    command: 'aqe-mcp', env: { AQE_EMBEDDER_ENDPOINT: 'http://foreign:12' },
  } } } } });
  const before = fs.readFileSync(user, 'utf8');
  const result = reconcileAqeEmbeddingProjections(cfg, cwd);
  assert.equal(result.ok, false);
  assert.equal(result.findings.some(f => f.scope === 'local' && f.status === 'conflict'), true);
  assert.equal(fs.readFileSync(user, 'utf8'), before);
  assert.doesNotMatch(JSON.stringify(result), /foreign:12/);
});

test('reports explicit user scope conflict and refuses malformed precedence evidence', t => {
  const { cwd, write, cfg } = fixture(t);
  write('.mcp.json', { mcpServers: { 'agentic-qe': { command: 'aqe-mcp' } } });
  write('claude-user.json', { mcpServers: { 'agentic-qe': { command: 'aqe-mcp', env: { AQE_EMBEDDER_ENDPOINT: 'http://foreign:13' } } } });
  assert.equal(inspectAqeEmbeddingProjections(cfg, cwd).ok, false);
  write('claude-user.json', '{ "token":"DO_NOT_PRINT_SECRET", invalid }');
  const result = inspectAqeEmbeddingProjections(cfg, cwd);
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_PRINT_SECRET/);
});
