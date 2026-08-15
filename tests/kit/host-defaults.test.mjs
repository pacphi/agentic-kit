// F-15 (single-source host-enablement default) + F-16 (validateBinding wiring)
// regression coverage for `ak host` — see src/commands/x/host.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindingWarnings } from '../../src/commands/x/host.mjs';

const validBinding = {
  id: 'ollama-via-claude', host: 'claude', provider: 'ollama',
  transport: 'anthropic-compatible', endpoint: 'http://127.0.0.1:11434',
};

test('bindingWarnings is empty for an empty or absent binding list', () => {
  assert.deepEqual(bindingWarnings({ integrations: {} }), []);
  assert.deepEqual(bindingWarnings({ integrations: { bindings: [] } }), []);
});

test('bindingWarnings leaves a valid user-declared binding untouched', () => {
  assert.deepEqual(bindingWarnings({ integrations: { bindings: [validBinding] } }), []);
});

test('bindingWarnings reports an unknown host as a friendly, structured message', () => {
  const bindings = [{ id: 'bad', host: 'not-a-host', provider: 'ollama', transport: 'native' }];
  const warnings = bindingWarnings({ integrations: { bindings } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^kit\.json integrations\.bindings\[0\]\.host: unknown-host \("not-a-host"\)$/);
});

test('bindingWarnings reports an unknown provider as a friendly, structured message', () => {
  // An unknown provider also fails the transport check (no known transports
  // for it to support) — validateBinding cascades both errors, by design.
  const bindings = [{ id: 'bad', host: 'claude', provider: 'not-a-provider', transport: 'native' }];
  const warnings = bindingWarnings({ integrations: { bindings } });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => /^kit\.json integrations\.bindings\[0\]\.provider: unknown-provider \("not-a-provider"\)$/.test(w)));
  assert.ok(warnings.some((w) => /^kit\.json integrations\.bindings\[0\]\.transport: unsupported-transport \("native"\)$/.test(w)));
});

test('bindingWarnings reports an unsupported transport as a friendly, structured message', () => {
  const bindings = [{ id: 'bad', host: 'claude', provider: 'ollama', transport: 'carrier-pigeon' }];
  const warnings = bindingWarnings({ integrations: { bindings } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^kit\.json integrations\.bindings\[0\]\.transport: unsupported-transport \("carrier-pigeon"\)$/);
});

test('bindingWarnings indexes each entry independently and leaves valid entries silent', () => {
  const bindings = [
    validBinding,
    { id: 'bad', host: 'not-a-host', provider: 'ollama', transport: 'native' },
  ];
  const warnings = bindingWarnings({ integrations: { bindings } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^kit\.json integrations\.bindings\[1\]\.host: unknown-host/);
});

test('bindingWarnings never throws — it always returns a plain array', () => {
  assert.doesNotThrow(() => bindingWarnings({ integrations: { bindings: [{}] } }));
});
