import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMPONENTS, componentById } from '../../src/lib/ruflo-components/catalogue.mjs';
import { STATES, describeState } from '../../src/lib/ruflo-components/states.mjs';
import { RUFLO_COMPONENT_DEFAULTS, validateRufloComponents, managedIntent }
  from '../../src/lib/ruflo-components/config.mjs';
import { loadKitConfig, saveKitConfig } from '../../src/lib/config.mjs';

test('catalogue lists the eight ADR-0058 components with minimum versions', () => {
  assert.deepEqual(COMPONENTS.map((c) => [c.id, c.minRuflo]), [
    ['typesafePicker', '3.43.0'], ['minilmPicker', '3.44.0'], ['mcpGovernance', '3.42.0'],
    ['learningProfile', '3.42.1'], ['turnCredit', '3.36.0'], ['memoryFix2887', '3.36.0'],
    ['funnel', null], ['encryptionAtRest', null],
  ]);
});

test('every component explains itself in plain language', () => {
  for (const c of COMPONENTS) {
    for (const key of ['does', 'benefit', 'cost', 'change']) {
      assert.ok(c.explain[key]?.length > 10, `${c.id}.explain.${key}`);
    }
  }
});

test('learning profile lists all five profiles with their budgets', () => {
  assert.deepEqual(componentById('learningProfile').options.map((o) => o.value),
    ['real-time', 'balanced', 'research', 'edge', 'batch']);
  assert.match(componentById('learningProfile').options[1].detail, /18 ms.*50 MB/);
});

test('every state carries a meaning and an action', () => {
  assert.deepEqual(Object.keys(STATES), ['active', 'applied-unverified', 'needs-ruflo',
    'not-applied', 'drifted', 'user-managed', 'partial', 'blocked', 'not-managed-yet', 'unknown']);
  for (const [id, s] of Object.entries(STATES)) {
    assert.ok(s.meaning.length > 10 && typeof s.action === 'string', id);
  }
});

test('describeState fills version, hosts and reason into the meaning', () => {
  assert.match(describeState('needs-ruflo', { minRuflo: '3.44.0' }).label, /needs ruflo ≥ 3\.44\.0/);
  assert.match(describeState('partial', { hosts: ['codex hooks'] }).meaning, /codex hooks/);
  assert.match(describeState('blocked', { reason: 'npm offline' }).meaning, /npm offline/);
});

test('defaults match ADR-0058 managed values', () => {
  assert.deepEqual(RUFLO_COMPONENT_DEFAULTS, {
    typesafePicker: true, minilmPicker: true, mcpGovernance: { maxCallsPerMinute: 120 },
    learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false,
  });
});

test('validation rejects unknown profiles, bad budgets and unknown keys', () => {
  assert.throws(() => validateRufloComponents({ learningProfile: 'turbo' }), /learningProfile/);
  assert.throws(() => validateRufloComponents({ mcpGovernance: { maxCallsPerMinute: 0 } }), /maxCallsPerMinute/);
  assert.throws(() => validateRufloComponents({ typesafePicker: 'yes' }), /typesafePicker/);
  assert.throws(() => validateRufloComponents({ bogus: true }), /bogus/);
  assert.doesNotThrow(() => validateRufloComponents({ mcpGovernance: false, funnel: true }));
  assert.doesNotThrow(() => validateRufloComponents(undefined));
});

test('managedIntent: false opts out; funnel true means leave funnel alone', () => {
  const cfg = { rufloComponents: { ...RUFLO_COMPONENT_DEFAULTS, minilmPicker: false, funnel: true } };
  assert.equal(managedIntent(cfg, 'minilmPicker'), false);
  assert.equal(managedIntent(cfg, 'funnel'), false);
  assert.equal(managedIntent(cfg, 'learningProfile'), 'balanced');
  assert.deepEqual(managedIntent(cfg, 'mcpGovernance'), { maxCallsPerMinute: 120 });
  assert.equal(managedIntent({}, 'typesafePicker'), true);
  assert.equal(managedIntent({}, 'funnel'), 'off');
});

test('kit.json keeps partial rufloComponents overrides and fills defaults', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'kit.json');
  fs.writeFileSync(file, JSON.stringify({ rufloComponents: { learningProfile: 'research' } }));
  const cfg = loadKitConfig(file);
  assert.equal(cfg.rufloComponents.learningProfile, 'research');
  assert.equal(cfg.rufloComponents.typesafePicker, true);
  cfg.rufloComponents.learningProfile = 'turbo';
  assert.throws(() => saveKitConfig(cfg, file), /learningProfile/);
});
