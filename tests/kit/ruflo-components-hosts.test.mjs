import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rufloMcpLaunch } from '../../src/lib/ruflo-memory.mjs';
import { mcpEntriesFor } from '../../src/lib/opencode-core.mjs';
import { renderPolicy } from '../../src/lib/ruflo-components/policy.mjs';
import { projectHookEnv } from '../../src/templates/opencode-ruflo-hooks.js';
import { deployPlugin, PLUGIN_NAME } from '../../src/lib/opencode-artifacts.mjs';

const cfg = { agentBrowser: false, rufloComponents: { typesafePicker: true, minilmPicker: true,
  mcpGovernance: { maxCallsPerMinute: 120 }, learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false } };
const cfgUngoverned = { ...cfg, rufloComponents: { ...cfg.rufloComponents, mcpGovernance: false } };

/** @param {'none'|'valid'|'foreign'|'symlink'} kind */
function repo(t, kind = 'none') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-hosts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  if (kind === 'none') return root;
  fs.mkdirSync(path.join(root, '.harness'));
  const policyFile = path.join(root, '.harness', 'mcp-policy.json');
  if (kind === 'valid') {
    fs.writeFileSync(policyFile, renderPolicy({ maxCallsPerMinute: 120 }));
  } else if (kind === 'foreign') {
    // A MetaHarness-generated (or any non-ak) policy file: valid JSON, valid
    // shape, but no ak `_about` provenance stamp. Must never enforce.
    fs.writeFileSync(policyFile, JSON.stringify({ maxToolCallsPerTurn: 8 }));
  } else if (kind === 'symlink') {
    const target = path.join(root, 'external-ak-policy.json');
    fs.writeFileSync(target, renderPolicy({ maxCallsPerMinute: 120 }));
    fs.symlinkSync(target, policyFile);
  }
  return root;
}

// The gateway template statically imports "@opencode-ai/plugin", which is not
// an ak dependency (opencode itself provides it at runtime). Mirror how
// opencode-ruflo-gateway.test.mjs loads the template: copy it beside a
// throwaway stub package so the import resolves, then read its named exports.
const gatewayTemplate = new URL('../../src/templates/opencode-ruflo-gateway.js', import.meta.url);
async function loadGatewayModule(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-gateway-stub-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stubDir = path.join(root, 'node_modules', '@opencode-ai', 'plugin');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({
    name: '@opencode-ai/plugin', version: '0.0.0-test', type: 'module', exports: './index.js',
  }));
  fs.writeFileSync(path.join(stubDir, 'index.js'), 'export const tool = (spec) => spec;\n');
  const dest = path.join(root, 'ruflo-gateway.mjs');
  fs.copyFileSync(gatewayTemplate, dest);
  return import(`${pathToFileURL(dest).href}?v=${Date.now()}`);
}

test('Codex launcher adds machine keys and project enforcement only with a policy', (t) => {
  const withPolicy = rufloMcpLaunch(repo(t, 'valid'), {}, { cfg, rufloVersion: '3.44.0' });
  assert.equal(withPolicy.env.RUFLO_MCP_ENFORCE_POLICY, '1');
  assert.equal(withPolicy.env.CLAUDE_FLOW_ROUTER_EMBEDDER, 'minilm');
  const without = rufloMcpLaunch(repo(t, 'none'), {}, { cfg, rufloVersion: '3.44.0' });
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in without.env, false);
  assert.equal(without.env.RUFLO_INTELLIGENCE_MODE, 'balanced');
});

test('launcher managed values override inherited shell values', (t) => {
  const spec = rufloMcpLaunch(repo(t, 'none'), { RUFLO_INTELLIGENCE_MODE: 'edge' }, { cfg, rufloVersion: '3.44.0' });
  assert.equal(spec.env.RUFLO_INTELLIGENCE_MODE, 'balanced');
});

test('launcher clears a stale inherited enforce value when governance is managed but no valid policy exists', (t) => {
  const spec = rufloMcpLaunch(repo(t, 'none'), { RUFLO_MCP_ENFORCE_POLICY: '1' }, { cfg, rufloVersion: '3.44.0' });
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in spec.env, false);
});

test('launcher preserves a stale inherited enforce value when governance is not managed', (t) => {
  const spec = rufloMcpLaunch(repo(t, 'none'), { RUFLO_MCP_ENFORCE_POLICY: '1' }, { cfg: cfgUngoverned, rufloVersion: '3.44.0' });
  assert.equal(spec.env.RUFLO_MCP_ENFORCE_POLICY, '1');
});

test('OpenCode claude-flow entry carries machine keys and the governance marker', async () => {
  const entries = await mcpEntriesFor({ brainShim: '/nonexistent', nestedPath: '/nonexistent', includeAqe: false,
    agentBrowserEnabled: false,
    rufloComponentEnv: { CLAUDE_FLOW_ROUTER_TYPESAFE: '1', AK_RUFLO_GOVERNANCE: 'managed' } });
  assert.equal(entries['claude-flow'].environment.CLAUDE_FLOW_ROUTER_TYPESAFE, '1');
  assert.equal(entries['claude-flow'].environment.AK_RUFLO_GOVERNANCE, 'managed');
});

test('OpenCode hooks projectHookEnv: enforce only with the marker and a valid ak-authored policy', (t) => {
  const withPolicy = repo(t, 'valid');
  const without = repo(t, 'none');
  assert.equal(projectHookEnv(withPolicy, { AK_RUFLO_GOVERNANCE: 'managed' }).RUFLO_MCP_ENFORCE_POLICY, '1');
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in projectHookEnv(without, { AK_RUFLO_GOVERNANCE: 'managed' }), false);
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in projectHookEnv(withPolicy, {}), false);
});

test('OpenCode hooks projectHookEnv: clears a stale inherited value when managed and invalid, preserves it when not managed', (t) => {
  const without = repo(t, 'none');
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in projectHookEnv(without, { AK_RUFLO_GOVERNANCE: 'managed', RUFLO_MCP_ENFORCE_POLICY: '1' }), false);
  assert.equal(projectHookEnv(without, { RUFLO_MCP_ENFORCE_POLICY: '1' }).RUFLO_MCP_ENFORCE_POLICY, '1');
});

test('OpenCode hooks projectHookEnv: a symlinked policy file never enforces', (t) => {
  const symlinked = repo(t, 'symlink');
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in projectHookEnv(symlinked, { AK_RUFLO_GOVERNANCE: 'managed' }), false);
});

test('OpenCode hooks projectHookEnv: a foreign (non-ak) policy file never enforces and clears a stale value', (t) => {
  const foreign = repo(t, 'foreign');
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in projectHookEnv(foreign, { AK_RUFLO_GOVERNANCE: 'managed', RUFLO_MCP_ENFORCE_POLICY: '1' }), false);
});

test('OpenCode gateway resolveEnforcedEnvironment mirrors the hooks rule (valid/absent policy)', async (t) => {
  const mod = await loadGatewayModule(t);
  assert.deepEqual(mod.managedEnforcement(repo(t, 'valid'), { AK_RUFLO_GOVERNANCE: 'managed' }), { RUFLO_MCP_ENFORCE_POLICY: '1' });
  assert.deepEqual(mod.managedEnforcement(repo(t, 'none'), { AK_RUFLO_GOVERNANCE: 'managed' }), {});
});

test('OpenCode gateway resolveEnforcedEnvironment clears a stale inherited value when managed and invalid, preserves it when not managed', async (t) => {
  const mod = await loadGatewayModule(t);
  const without = repo(t, 'none');
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in mod.resolveEnforcedEnvironment(without, { AK_RUFLO_GOVERNANCE: 'managed', RUFLO_MCP_ENFORCE_POLICY: '1' }), false);
  assert.equal(mod.resolveEnforcedEnvironment(without, { RUFLO_MCP_ENFORCE_POLICY: '1' }).RUFLO_MCP_ENFORCE_POLICY, '1');
});

test('OpenCode gateway resolveEnforcedEnvironment: a symlinked policy file never enforces', async (t) => {
  const mod = await loadGatewayModule(t);
  const symlinked = repo(t, 'symlink');
  assert.deepEqual(mod.resolveEnforcedEnvironment(symlinked, { AK_RUFLO_GOVERNANCE: 'managed' }), { AK_RUFLO_GOVERNANCE: 'managed' });
});

test('OpenCode gateway resolveEnforcedEnvironment: a foreign (non-ak) policy file never enforces and clears a stale value', async (t) => {
  const mod = await loadGatewayModule(t);
  const foreign = repo(t, 'foreign');
  const result = mod.resolveEnforcedEnvironment(foreign, { AK_RUFLO_GOVERNANCE: 'managed', RUFLO_MCP_ENFORCE_POLICY: '1' });
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in result, false);
});

test('deployed OpenCode hooks artifact enforces from baked component env with no explicit caller env', async (t) => {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-hooks-deploy-'));
  t.after(() => fs.rmSync(pluginsDir, { recursive: true, force: true }));
  const componentEnv = { CLAUDE_FLOW_ROUTER_TYPESAFE: '1', AK_RUFLO_GOVERNANCE: 'managed' };
  const deployed = deployPlugin({ pkgRoot, pluginsDir, componentEnv });
  assert.equal(deployed.ok, true);
  const deployedPath = path.join(pluginsDir, PLUGIN_NAME);
  const deployedText = fs.readFileSync(deployedPath, 'utf8');
  assert.ok(deployedText.includes('"CLAUDE_FLOW_ROUTER_TYPESAFE":"1"'), 'machine keys baked into the deployed artifact');
  assert.ok(deployedText.includes('"AK_RUFLO_GOVERNANCE":"managed"'), 'governance marker baked into the deployed artifact');
  const mod = await import(`${pathToFileURL(deployedPath).href}?v=${Date.now()}`);
  const withPolicy = repo(t, 'valid');
  assert.equal(mod.projectHookEnv(withPolicy, {}).RUFLO_MCP_ENFORCE_POLICY, '1',
    'the deployed copy enforces using its own baked marker, without the caller passing one');
  const withoutPolicy = repo(t, 'none');
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in mod.projectHookEnv(withoutPolicy, {}), false);
});

test('deployed OpenCode hooks artifact carries no component keys or marker when governance is not managed/supported', () => {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-hooks-deploy-empty-'));
  try {
    const deployed = deployPlugin({ pkgRoot, pluginsDir, componentEnv: {} });
    assert.equal(deployed.ok, true);
    const deployedText = fs.readFileSync(path.join(pluginsDir, PLUGIN_NAME), 'utf8');
    assert.ok(deployedText.includes('const RUFLO_COMPONENT_ENV = Object.freeze({})'),
      'the baked component-env constant substitutes to an empty object');
    assert.ok(!deployedText.includes('CLAUDE_FLOW_ROUTER_TYPESAFE'));
  } finally {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
  }
});
