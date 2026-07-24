import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_MODEL_CATALOG, providerModelChoices, formatModelHelp, HOSTS } from '../../src/lib/routing.mjs';

test('PROVIDER_MODEL_CATALOG lists GLM via openrouter (flagship + value)', () => {
  const ids = PROVIDER_MODEL_CATALOG.openrouter.map((m) => m.id);
  assert.ok(ids.includes('z-ai/glm-5.2'));
  assert.ok(ids.includes('z-ai/glm-5'));
});

test('openrouter is a provider-axis entry, never a host', () => {
  assert.ok(!HOSTS.includes('openrouter'));
});

test('providerModelChoices returns the openrouter models and [] for the unknown', () => {
  assert.equal(providerModelChoices('openrouter').length, 2);
  assert.deepEqual(providerModelChoices('nope'), []);
});

test('formatModelHelp surfaces GLM under a metered aqe-fallback heading', () => {
  const help = formatModelHelp();
  assert.match(help, /openrouter \(aqe-fallback provider — metered\)/);
  assert.match(help, /z-ai\/glm-5\.2/);
});
