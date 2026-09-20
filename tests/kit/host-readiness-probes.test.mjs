import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectHostSetup } from '../../src/lib/host-readiness-probes.mjs';
const cwd = '/tmp/readiness-project';
const response = (stdout, code = 0) => ({ code, stdout, stderr: '' });
const versions = { claude: '2.1.999 (Claude Code)', codex: 'codex-cli 0.999.0', opencode: '1.99.0' };
const help = { 'doctor --help': 'Usage: claude doctor [options]\nCheck installation and settings',
  'auth status --help': 'Usage: claude auth status [options]\n--json',
  'mcp list --help': 'Usage: codex mcp list [OPTIONS]\n--json',
  'login status --help': 'Usage: codex login status [OPTIONS]' };
const local = () => ({ configuration: { state: 'unknown', reason: 'native required' },
  authentication: { state: 'unknown', reason: 'native required' }, model: { state: 'pass', reason: 'Native default selection' }, target: { nativeDefault: true } });
function probe(host, outputs = {}, present = true, selection = local()) {
  const calls = [];
  return { calls, collect: () => collectHostSetup({ host, cwd, have: async () => present,
    assessSelection: () => selection,
    run: async (bin, args, opts) => {
      calls.push({ bin, args, opts }); const key = args.join(' ');
      if (outputs[key] instanceof Error) throw outputs[key];
      return outputs[key] ?? response(key === '--version' ? versions[host] : help[key] ?? '');
    } }) };
}

test('missing executable is actionable and prevents diagnostics', async () => {
  const p = probe('claude', {}, false); assert.equal((await p.collect()).installation.state, 'fail'); assert.deepEqual(p.calls, []);
});
test('failed executable launch remains neutral', async () => {
  const p = probe('codex', { '--version': response('timeout', 1) });
  assert.equal((await p.collect()).installation.state, 'unknown'); assert.equal(p.calls.length, 1);
});
test('future versions use advertised native capabilities without version locks', async () => {
  const result = await probe('codex', { 'mcp list --json': response('[]'), 'login status': response('Logged in using ChatGPT') }).collect();
  assert.equal(result.configuration.state, 'pass'); assert.equal(result.authentication.state, 'pass'); assert.equal(result.model.state, 'pass');
});
test('missing advertised JSON capability does not execute speculative commands', async () => {
  const p = probe('codex', { 'mcp list --help': response('unknown') });
  const result = await p.collect(); assert.equal(result.configuration.state, 'unknown');
  assert.ok(!p.calls.some(call => call.args.join(' ') === 'mcp list --json'));
});
test('Claude clean doctor and typed auth carry separate local evidence', async () => {
  const result = await probe('claude', { doctor: response('Claude Code doctor\nNo installation issues found.'),
    'auth status --json': response(JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', email: 'SECRET' })) }).collect();
  assert.equal(result.configuration.state, 'pass'); assert.equal(result.authentication.state, 'pass');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('explicit first party sign-out is actionable but custom auth failures are neutral', async () => {
  for (const [provider, state] of [['firstParty', 'fail'], ['bedrock', 'unknown']]) {
    const result = await probe('claude', { 'auth status --json': response(JSON.stringify({ loggedIn: false, apiProvider: provider }), 1) }).collect();
    assert.equal(result.authentication.state, state);
  }
});
test('Codex native login cannot attest a custom providers credentials', async () => {
  const selection = { ...local(), target: { provider: 'custom', model: 'example' } };
  const result = await probe('codex', { 'mcp list --json': response('[]'), 'login status': response('Logged in') }, true, selection).collect();
  assert.equal(result.authentication.state, 'unknown');
});
test('malformed and thrown results never expose raw diagnostics', async () => {
  for (const output of [response('SECRET not json'), new Error('SECRET')]) {
    const result = await probe('codex', { 'mcp list --json': output }).collect();
    assert.equal(result.configuration.state, 'unknown'); assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});
test('OpenCode uses local assessed evidence without starting plugins, catalogs or inference', async () => {
  const pass = { state: 'pass', reason: 'local evidence' };
  const p = probe('opencode', {}, true, { configuration: pass, authentication: pass, model: pass });
  const result = await p.collect(); assert.equal(result.configuration.state, 'pass'); assert.equal(result.authentication.state, 'pass');
  assert.deepEqual(p.calls.map(call => call.args), [['--version']]);
});
test('all commands use bounded output, time and the requested cwd', async () => {
  const p = probe('claude'); await p.collect();
  for (const call of p.calls) { assert.equal(call.opts.cwd, cwd); assert.ok(call.opts.timeout <= 10000); assert.ok(call.opts.maxBuffer <= 1048576); }
});
test('unknown host and relative cwd cannot select arbitrary invocations', async () => {
  await assert.rejects(collectHostSetup({ host: 'arbitrary', cwd }), /unsupported host/);
  await assert.rejects(collectHostSetup({ host: 'claude', cwd: '../other' }), /cwd must be absolute/);
});
