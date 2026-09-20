import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/commands/x/aqe-embedding.mjs';
import { captureLog } from './helpers/home-sandbox.mjs';

const cfg = () => ({ aqeEmbedding: { mode: 'endpoint', endpoint: 'http://localhost:11434', provisioning: 'ollama' } });
test('configuration preview never saves, downloads, or writes host files', async () => {
  const result = await captureLog(() => run({ positionals: ['configure'], flags: { 'dry-run': true }, load: cfg,
    save: () => assert.fail(), prepare: () => assert.fail(), reconcile: () => assert.fail() }));
  assert.equal(result.result, 0);
  assert.match(result.out, /Re-run with --yes/);
});
test('configuration retains selected intent on failed provisioning and returns failure', async () => {
  let saved;
  const result = await captureLog(() => run({ positionals: ['configure'], flags: { yes: true }, load: cfg,
    save: value => { saved = value; }, prepare: async () => ({ ok: false, detail: 'missing service' }), reconcile: () => assert.fail() }));
  assert.equal(result.result, 1);
  assert.equal(saved.aqeEmbedding.provisioning, 'ollama');
});
test('OpenCode ownership conflicts remain failure instead of claiming updated environments', async () => {
  const result = await captureLog(() => run({ positionals: ['prepare'], flags: { yes: true },
    load: () => ({ ...cfg(), integrations: { hosts: { opencode: true } } }),
    prepare: async () => ({ ok: true, detail: 'backend passed' }),
    reconcile: () => ({ ok: true, detail: 'Claude/Codex converged' }),
    reconcileOpenCode: () => ({ ok: false, detail: 'OpenCode AQE entry is unowned or edited' }) }));
  assert.equal(result.result, 1);
  assert.match(result.out, /unowned or edited/);
  assert.doesNotMatch(result.out, /New host sessions load/);
});
test('embedding configuration updates OpenCode immediately and saves its owned receipt', async () => {
  let saved = 0;
  const result = await captureLog(() => run({ positionals: ['prepare'], flags: { yes: true },
    load: () => ({ ...cfg(), integrations: { hosts: { opencode: true } } }),
    save: () => { saved += 1; }, prepare: async () => ({ ok: true, detail: 'backend passed' }),
    reconcile: () => ({ ok: true, detail: 'Claude/Codex converged' }),
    reconcileOpenCode: (value, { dryRun }) => { assert.equal(dryRun, false); return { ok: true, markersChanged: true, detail: 'OpenCode updated' }; } }));
  assert.equal(result.result, 0);
  assert.equal(saved, 1);
  assert.match(result.out, /OpenCode updated/);
});
test('verify never provisions models and unmanaged is not a passing proof', async () => {
  let provision;
  const result = await captureLog(() => run({ positionals: ['verify'], load: () => ({}),
    prepare: async (value, options) => { provision = options.provision; return { ok: true, status: 'skipped', detail: 'unmanaged' }; } }));
  assert.equal(provision, false);
  assert.equal(result.result, 1);
});
