import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessLocalSelection } from '../../src/lib/host-readiness-local.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-health-local-'));
  const cwd = path.join(home, 'project');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(home, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { home, cwd, write, env: { OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(home, 'managed') } };
}

test('OpenCode JSONC and local overrides select a credentialed provider without startup', t => {
  const f = fixture(t);
  f.write('.config/opencode/opencode.jsonc', '{ // comment\n "model":"old/model", "provider":{}, }');
  f.write('project/opencode.json', { model: 'anthropic/claude-example' });
  f.write('.local/share/opencode/auth.json', { anthropic: { type: 'oauth', access: 'SECRET', refresh: 'SECRET', expires: Date.now() + 10000 } });
  const result = assessLocalSelection({ host: 'opencode', ...f });
  assert.equal(result.configuration.state, 'pass');
  assert.equal(result.authentication.state, 'pass');
  assert.equal(result.model.state, 'pass');
  assert.deepEqual(result.target, { provider: 'anthropic', model: 'claude-example' });
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('OpenCode native default is supported without inventing a model ID', t => {
  const f = fixture(t);
  f.write('.local/share/opencode/auth.json', { anthropic: { type: 'api', key: 'SECRET' } });
  const result = assessLocalSelection({ host: 'opencode', ...f });
  assert.equal(result.configuration.state, 'pass');
  assert.equal(result.model.state, 'pass');
  assert.equal(result.authentication.state, 'pass');
  assert.deepEqual(result.target, { nativeDefault: true });
});

test('OpenCode custom root and inline content obey precedence', t => {
  const f = fixture(t);
  f.write('custom/opencode.jsonc', '{"model":"first/model",}');
  const env = { ...f.env, OPENCODE_CONFIG_DIR: path.join(f.home, 'custom'), OPENCODE_CONFIG_CONTENT: '{"model":"openai/gpt-example"}', OPENAI_API_KEY: 'SECRET' };
  const result = assessLocalSelection({ host: 'opencode', ...f, env });
  assert.deepEqual(result.target, { provider: 'openai', model: 'gpt-example' });
  assert.equal(result.authentication.state, 'pass');
});

test('remote config cannot be claimed as locally resolved', t => {
  const f = fixture(t);
  f.write('.local/share/opencode/auth.json', { 'https://example.invalid': { type: 'wellknown', token: 'SECRET', key: 'TOKEN' } });
  const result = assessLocalSelection({ host: 'opencode', ...f });
  assert.equal(result.configuration.state, 'unknown');
  assert.equal(result.model.state, 'unknown');
});

test('invalid JSONC is actionable but unsupported references are neutral', t => {
  const f = fixture(t);
  f.write('project/opencode.jsonc', '{"model":}');
  assert.equal(assessLocalSelection({ host: 'opencode', ...f }).configuration.state, 'fail');
  f.write('project/opencode.jsonc', '{"model":"{file:remote-selection}"}');
  assert.equal(assessLocalSelection({ host: 'opencode', ...f }).configuration.state, 'unknown');
});

test('explicit selected provider does not borrow another providers credentials', t => {
  const f = fixture(t);
  f.write('project/opencode.json', { model: 'openai/gpt-example' });
  f.write('.local/share/opencode/auth.json', { anthropic: { type: 'api', key: 'SECRET' } });
  const result = assessLocalSelection({ host: 'opencode', ...f });
  assert.equal(result.authentication.state, 'unknown');
});

test('Claude local selection uses environment precedence and labels defaults', t => {
  const f = fixture(t);
  f.write('.claude/settings.json', { model: 'sonnet' });
  f.write('project/.claude/settings.local.json', { model: 'opus' });
  assert.equal(assessLocalSelection({ host: 'claude', ...f, env: { ANTHROPIC_MODEL: 'claude-example' } }).target.model, 'claude-example');
});

test('Codex explicit model projection never interprets instruction text', t => {
  const f = fixture(t);
  f.write('.codex/config.toml', 'model = "gpt-example"\nmodel_provider = "custom"\n[other]\nmodel = "not-selected"\n');
  const result = assessLocalSelection({ host: 'codex', ...f });
  assert.deepEqual(result.target, { provider: 'custom', model: 'gpt-example' });
});

test('disabled providers never supply authentication for native default selection', t => {
  const f = fixture(t);
  f.write('project/opencode.json', { disabled_providers: ['anthropic'] });
  f.write('.local/share/opencode/auth.json', { anthropic: { type: 'api', key: 'SECRET' } });
  assert.equal(assessLocalSelection({ host: 'opencode', ...f }).authentication.state, 'unknown');
});

test('local custom endpoint uses its configured credential requirement without network', t => {
  const f = fixture(t);
  f.write('project/opencode.json', { provider: { lmstudio: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://localhost:1234/v1' } } } });
  const result = assessLocalSelection({ host: 'opencode', ...f });
  assert.equal(result.authentication.state, 'pass');
  assert.match(result.authentication.reason, /server authentication is not tested/);
  assert.deepEqual(result.target, { nativeDefault: true });
});

test('Codex project files without selection overrides preserve user model projection', t => {
  const f = fixture(t);
  f.write('.codex/config.toml', 'model = "gpt-example"');
  f.write('project/.codex/config.toml', '[features]\nhooks = true');
  assert.equal(assessLocalSelection({ host: 'codex', ...f }).target.model, 'gpt-example');
  f.write('project/.codex/config.toml', 'model = "different"');
  assert.equal(assessLocalSelection({ host: 'codex', ...f }).model.state, 'unknown');
});

test('JSONC string URLs and comment-looking secrets preserve their literal meaning', t => {
  const f = fixture(t);
  f.write('project/opencode.jsonc', '{"model":"custom/example", "provider":{"custom":{"options":{"apiKey":"SECRET///*",},},},}');
  const result = assessLocalSelection({ host: 'opencode', ...f });
  assert.equal(result.authentication.state, 'pass');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('Codex native local provider does not require a ChatGPT login', t => {
  const f = fixture(t);
  f.write('.codex/config.toml', 'model_provider = "ollama"\nmodel = "local-model"');
  const result = assessLocalSelection({ host: 'codex', ...f });
  assert.equal(result.authentication.state, 'pass');
  assert.match(result.authentication.reason, /no configured login requirement/);
});

test('OpenCode configured default agent model takes precedence over global model', t => {
  const f = fixture(t);
  f.write('project/opencode.json', { model: 'openai/other', default_agent: 'review', agent: { review: { model: 'anthropic/selected' } } });
  f.write('.local/share/opencode/auth.json', { anthropic: { type: 'api', key: 'SECRET' } });
  assert.deepEqual(assessLocalSelection({ host: 'opencode', ...f }).target, { provider: 'anthropic', model: 'selected' });
});

test('auto-loaded selected agent model is not guessed from global config', t => {
  const f = fixture(t);
  f.write('project/.opencode/agents/build.md', '---\nmodel: anthropic/other\n---\nAgent');
  assert.equal(assessLocalSelection({ host: 'opencode', ...f }).model.state, 'unknown');
});

test('malformed operational OpenCode fields cannot pass local health', t => {
  const f = fixture(t);
  f.write('.local/share/opencode/auth.json', { anthropic: { type: 'api', key: 'SECRET' } });
  for (const extra of [
    { mcp: { broken: 42 } }, { mcp: { broken: { type: 'local', command: [] } } },
    { mcp: { broken: { type: 'remote', url: 42 } } },
    { mcp: { broken: { type: 'remote', url: 'https://example.test', enabled: 'yes' } } },
    { provider: { anthropic: { options: { apiKey: {} } } } },
    { provider: { anthropic: { env: 'ANTHROPIC_API_KEY' } } },
    { provider: { anthropic: { models: [] } } }, { agent: { build: 42 } },
  ]) {
    f.write('project/opencode.json', { model: 'anthropic/example', ...extra });
    assert.equal(assessLocalSelection({ host: 'opencode', ...f }).configuration.state, 'fail', JSON.stringify(extra));
  }
});

test('unknown future MCP transport is neutral while supported entries pass', t => {
  const f = fixture(t);
  f.write('project/opencode.json', { model: 'anthropic/example', mcp: { tool: { type: 'future' } } });
  assert.equal(assessLocalSelection({ host: 'opencode', ...f }).configuration.state, 'unknown');
  f.write('project/opencode.json', { model: 'anthropic/example', mcp: { local: { type: 'local', command: ['tool', '--flag'] }, remote: { type: 'remote', url: 'https://example.test/mcp' }, disabled: { enabled: false } } });
  assert.equal(assessLocalSelection({ host: 'opencode', ...f }).configuration.state, 'pass');
});

test('Claude settings environment model overrides lower settings model', t => {
  const f = fixture(t);
  f.write('.claude/settings.json', { model: 'old-model', env: { ANTHROPIC_MODEL: 'actual-model' } });
  assert.equal(assessLocalSelection({ host: 'claude', ...f }).target.model, 'actual-model');
  assert.equal(assessLocalSelection({ host: 'claude', ...f, env: { ANTHROPIC_MODEL: 'process-model' } }).target.model, 'process-model');
});

test('OpenCode inline content expands environment references like file config', t => {
  const f = fixture(t);
  const env = { ...f.env, MODEL: 'anthropic/example', OPENCODE_CONFIG_CONTENT: '{"model":"{env:MODEL}"}' };
  assert.deepEqual(assessLocalSelection({ host: 'opencode', ...f, env }).target, { provider: 'anthropic', model: 'example' });
});

test('Codex system model provider inherits per key with user overrides', t => {
  const f = fixture(t);
  f.write('system.toml', 'model = "system-model"\nmodel_provider = "custom"');
  f.write('.codex/config.toml', 'model = "user-model"');
  const result = assessLocalSelection({ host: 'codex', ...f, codexSystemConfig: path.join(f.home, 'system.toml') });
  assert.deepEqual(result.target, { provider: 'custom', model: 'user-model' });
});

test('unavailable default agents are neutral and known subagents cannot be primary', t => {
  const f = fixture(t);
  f.write('project/opencode.json', { model: 'anthropic/example', default_agent: 'missing' });
  assert.equal(assessLocalSelection({ host: 'opencode', ...f }).configuration.state, 'unknown');
  f.write('project/opencode.json', { model: 'anthropic/example', default_agent: 'review', agent: { review: { mode: 'subagent' } } });
  assert.equal(assessLocalSelection({ host: 'opencode', ...f }).configuration.state, 'fail');
});
