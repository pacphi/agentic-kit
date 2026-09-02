import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_BUDGET_POLICY,
  estimateTokensFromBytes,
  evaluateContextBudget,
  resolveEffectiveContextCeiling,
} from '../../src/lib/context-budget.mjs';

test('resolves the lowest fresh applicable context guard without confusing maximum and effective windows', () => {
  const resolved = resolveEffectiveContextCeiling([
    { tokens: 1_050_000, kind: 'advertised-maximum', provenance: 'provider-catalog', source: 'openai-docs' },
    { tokens: 872_000, kind: 'host-maximum', provenance: 'host-configured', source: 'codex-cache' },
    { tokens: 272_000, kind: 'host-nominal', provenance: 'host-configured', source: 'codex-cache' },
    { tokens: 258_400, kind: 'runtime-effective', provenance: 'runtime-observed', source: 'codex-session' },
  ]);
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.tokens, 258_400);
  assert.equal(resolved.kind, 'runtime-effective');
  assert.equal(resolved.considered, 4);
});

test('unknown, stale, invalid, and untrusted declarations do not manufacture a ceiling', () => {
  assert.deepEqual(resolveEffectiveContextCeiling([
    { tokens: 1_000_000, provenance: 'adapter-self-asserted', source: 'hermes' },
    { tokens: 200_000, provenance: 'provider-catalog', source: 'catalog', status: 'stale' },
    { tokens: -1, provenance: 'runtime-observed', source: 'session' },
  ]), {
    state: 'unknown', tokens: null, kind: null, provenance: null, source: null,
    considered: 0, rejected: 3,
  });
});

test('byte measurements remain explicit conservative estimates', () => {
  assert.deepEqual(estimateTokensFromBytes(29_600), {
    tokens: 9_867,
    unit: 'estimated-tokens',
    method: 'utf8-bytes-div-3-ceil',
    sourceBytes: 29_600,
  });
  assert.throws(() => estimateTokensFromBytes(-1), /non-negative safe integer/);
});

test('startup policy preserves exact 5, 7, and 10 percent boundaries', () => {
  const at = (tokens) => evaluateContextBudget({ ceilingTokens: 100_000, startupTokens: tokens, currentTokens: tokens });
  assert.equal(at(5_000).startup.level, 'target');
  assert.equal(at(5_001).startup.level, 'above-target');
  assert.equal(at(7_000).startup.level, 'above-target');
  assert.equal(at(7_001).startup.level, 'warning');
  assert.equal(at(10_000).startup.level, 'warning');
  assert.equal(at(10_001).startup.level, 'critical');
});

test('dynamic policy reserves 25 percent and names 60, 70, and 75 percent actions', () => {
  const at = (tokens) => evaluateContextBudget({ ceilingTokens: 100_000, startupTokens: 1_000, currentTokens: tokens });
  assert.equal(CONTEXT_BUDGET_POLICY.reserveBps, 2_500);
  assert.equal(at(59_999).dynamic.action, 'continue');
  assert.equal(at(60_000).dynamic.action, 'warn');
  assert.equal(at(70_000).dynamic.action, 'compact');
  assert.equal(at(75_000).dynamic.action, 'handoff');
  assert.equal(at(75_000).reserve.remainingTokens, 25_000);
  assert.equal(at(75_001).reserve.breached, true);
});

test('evaluation stays unknown when no compatible token ceiling is proven', () => {
  const value = evaluateContextBudget({ ceilingTokens: null, startupTokens: 25_985, currentTokens: 25_985 });
  assert.equal(value.state, 'unknown');
  assert.equal(value.startup.pressureBps, null);
  assert.equal(value.dynamic.action, 'unknown');
});
