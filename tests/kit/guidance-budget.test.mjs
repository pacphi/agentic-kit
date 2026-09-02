import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  BUILTIN_BLOCKS,
  CONSERVATIVE_BYTES_PER_TOKEN,
  GUIDANCE_TARGET_BUDGETS,
  detect,
  guidanceContextFromConfig,
  guidanceFootprint,
  templateResolver,
} from '../../src/lib/blocks.mjs';

const PKG_ROOT = path.resolve(import.meta.dirname, '../..');
const resolve = templateResolver(PKG_ROOT);

const allEnabled = guidanceContextFromConfig({
  aqe: true,
  ruvnetBrain: true,
  integrations: { hosts: { claude: true, codex: true, opencode: true } },
}, { flags: { superpowersEnabled: true } });

test('enabled detector prefers persisted intent and only falls back when intent is absent', async () => {
  const detector = {
    type: 'enabled', target: 'codexEnabled',
    fallback: { type: 'always' },
  };
  assert.equal(await detect(detector, { flags: { codexEnabled: false } }), false);
  assert.equal(await detect(detector, { flags: { codexEnabled: true } }), true);
  assert.equal(await detect(detector), true);
});

test('guidance context derives host and managed-integration flags from kit config', () => {
  const context = guidanceContextFromConfig({
    aqe: false,
    ruvnetBrain: true,
    integrations: { hosts: { claude: true, codex: false, opencode: true } },
  }, { flags: { customFlag: true, codexEnabled: true } });

  assert.deepEqual(context.flags, {
    customFlag: true,
    codexEnabled: false,
    claudeEnabled: true,
    opencodeEnabled: true,
    dualMode: false,
    aqeEnabled: false,
    ruvnetBrainEnabled: true,
  });
});

test('persisted disablement omits managed integrations even when legacy probes could succeed', async () => {
  const context = guidanceContextFromConfig({
    aqe: false,
    ruvnetBrain: false,
    integrations: { hosts: { claude: true, codex: false, opencode: true } },
  }, { flags: { superpowersEnabled: false } });
  const report = await guidanceFootprint(BUILTIN_BLOCKS, 'claude', resolve, { context });
  const omitted = report.omitted.map((entry) => entry.slug);

  assert.ok(omitted.includes('ruflo-aqe-reference'));
  assert.ok(omitted.includes('ruflo-providers-reference'));
  assert.ok(omitted.includes('ruflo-dual-mode-reference'));
  assert.ok(omitted.includes('ruvnet-brain-reference'));
});

test('built-in guidance stays within deterministic per-target startup budgets', async () => {
  for (const target of ['claude', 'agents', 'agents-user', 'agents-opencode', 'agents-hermes']) {
    const report = await guidanceFootprint(BUILTIN_BLOCKS, target, resolve, { context: allEnabled });
    assert.equal(report.unknown.length, 0, `${target}: every selected template is measurable`);
    assert.equal(report.withinBudget, true, `${target}: ${report.bytes} <= ${report.budget.maxBytes}`);
    assert.equal(
      report.conservativeTokens,
      Math.ceil(report.bytes / CONSERVATIVE_BYTES_PER_TOKEN),
      `${target}: conservative estimate is deterministic`,
    );
    assert.deepEqual(report.budget, GUIDANCE_TARGET_BUDGETS[target] ?? GUIDANCE_TARGET_BUDGETS.external);
  }
});

test('footprint reports disabled blocks as omitted and missing selected templates as unknown', async () => {
  const rows = [
    { slug: 'off', guidanceFiles: ['claude'], detector: { type: 'flag', target: 'off' }, template: 'off.md' },
    { slug: 'missing', guidanceFiles: ['claude'], detector: { type: 'always' }, template: 'missing.md' },
  ];
  const report = await guidanceFootprint(rows, 'claude', () => '/definitely/missing.md', {
    context: { flags: { off: false } },
  });

  assert.deepEqual(report.omitted, [{ slug: 'off', reason: 'detector-false' }]);
  assert.deepEqual(report.unknown, [{ slug: 'missing', reason: 'missing-template' }]);
  assert.equal(report.withinBudget, null, 'an incomplete measurement never claims budget compliance');
});

test('external/Hermes fallback receives no built-in always-on guidance', async () => {
  const report = await guidanceFootprint(BUILTIN_BLOCKS, 'agents-hermes', resolve, { context: allEnabled });
  assert.equal(report.bytes, 0);
  assert.equal(report.conservativeTokens, 0);
  assert.deepEqual(report.included, []);
  assert.deepEqual(report.omitted, []);
  assert.deepEqual(report.unknown, []);
});
