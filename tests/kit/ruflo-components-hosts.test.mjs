import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rufloMcpLaunch } from '../../src/lib/ruflo-memory.mjs';
import { mcpEntriesFor } from '../../src/lib/opencode-core.mjs';
import { renderPolicy } from '../../src/lib/ruflo-components/policy.mjs';
import { projectHookEnv } from '../../src/templates/opencode-ruflo-hooks.js';

const cfg = { agentBrowser: false, rufloComponents: { typesafePicker: true, minilmPicker: true,
  mcpGovernance: { maxCallsPerMinute: 120 }, learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false } };
function repo(t, withPolicy) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-hosts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  if (withPolicy) {
    fs.mkdirSync(path.join(root, '.harness'));
    fs.writeFileSync(path.join(root, '.harness', 'mcp-policy.json'), renderPolicy({ maxCallsPerMinute: 120 }));
  }
  return root;
}

// The gateway template statically imports "@opencode-ai/plugin", which is not
// an ak dependency (opencode itself provides it at runtime). Mirror how
// opencode-ruflo-gateway.test.mjs loads the template: copy it beside a
// throwaway stub package so the import resolves, then read its named export.
const gatewayTemplate = new URL('../../src/templates/opencode-ruflo-gateway.js', import.meta.url);
async function loadManagedEnforcement(t) {
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
  const mod = await import(`${pathToFileURL(dest).href}?v=${Date.now()}`);
  return mod.managedEnforcement;
}

test('Codex launcher adds machine keys and project enforcement only with a policy', (t) => {
  const withPolicy = rufloMcpLaunch(repo(t, true), {}, { cfg, rufloVersion: '3.44.0' });
  assert.equal(withPolicy.env.RUFLO_MCP_ENFORCE_POLICY, '1');
  assert.equal(withPolicy.env.CLAUDE_FLOW_ROUTER_EMBEDDER, 'minilm');
  const without = rufloMcpLaunch(repo(t, false), {}, { cfg, rufloVersion: '3.44.0' });
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in without.env, false);
  assert.equal(without.env.RUFLO_INTELLIGENCE_MODE, 'balanced');
});

test('launcher managed values override inherited shell values', (t) => {
  const spec = rufloMcpLaunch(repo(t, false), { RUFLO_INTELLIGENCE_MODE: 'edge' }, { cfg, rufloVersion: '3.44.0' });
  assert.equal(spec.env.RUFLO_INTELLIGENCE_MODE, 'balanced');
});

test('OpenCode claude-flow entry carries machine keys and the governance marker', async () => {
  const entries = await mcpEntriesFor({ brainShim: '/nonexistent', nestedPath: '/nonexistent', includeAqe: false,
    agentBrowserEnabled: false,
    rufloComponentEnv: { CLAUDE_FLOW_ROUTER_TYPESAFE: '1', AK_RUFLO_GOVERNANCE: 'managed' } });
  assert.equal(entries['claude-flow'].environment.CLAUDE_FLOW_ROUTER_TYPESAFE, '1');
  assert.equal(entries['claude-flow'].environment.AK_RUFLO_GOVERNANCE, 'managed');
});

test('OpenCode hooks enforce governance only with the marker and a valid policy', (t) => {
  const withPolicy = repo(t, true);
  const without = repo(t, false);
  assert.equal(projectHookEnv(withPolicy, { AK_RUFLO_GOVERNANCE: 'managed' }).RUFLO_MCP_ENFORCE_POLICY, '1');
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in projectHookEnv(without, { AK_RUFLO_GOVERNANCE: 'managed' }), false);
  assert.equal('RUFLO_MCP_ENFORCE_POLICY' in projectHookEnv(withPolicy, {}), false);
});

test('OpenCode gateway enforcement helper mirrors the hooks rule', async (t) => {
  const managedEnforcement = await loadManagedEnforcement(t);
  assert.deepEqual(managedEnforcement(repo(t, true), { AK_RUFLO_GOVERNANCE: 'managed' }), { RUFLO_MCP_ENFORCE_POLICY: '1' });
  assert.deepEqual(managedEnforcement(repo(t, false), { AK_RUFLO_GOVERNANCE: 'managed' }), {});
});
