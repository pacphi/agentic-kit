import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapHostModel, swapRoute, seedActivityRoutes, DEFAULT_ROUTES, DEFAULT_PRIMARY_HOST, PRIMARY_HOSTS } from '../../src/lib/routing.mjs';
import { primaryHostIds, effectivePrimaryHostIds } from '../../src/lib/adapters/index.mjs';
import { applyAdmitted, resetAdmitted } from '../../src/lib/adapters/admitted.mjs';

// ── swapHostModel ────────────────────────────────────────────────────────────
test('swapHostModel maps a claude model to the codex host', () => {
  const r = swapHostModel('claude', 'claude-opus-4-8');
  assert.equal(r.host, 'codex');
  assert.ok(typeof r.model === 'string' && r.model.length > 0);
});

test('swapHostModel maps a codex model to the claude host', () => {
  const r = swapHostModel('codex', 'gpt-5.4');
  assert.equal(r.host, 'claude');
  assert.ok(typeof r.model === 'string' && r.model.length > 0);
});

// ── swapRoute ────────────────────────────────────────────────────────────────
test('swapRoute inverts the host and mirrors the escalation ladder', () => {
  // implementation default: codex primary, escalates to claude
  const swapped = swapRoute(DEFAULT_ROUTES.implementation);
  assert.equal(swapped.host, 'claude');
  assert.equal(swapped.escalation[0].host, 'codex');
});

// ── seedActivityRoutes primary bias ─────────────────────────────────────────────
test('seedActivityRoutes default (claude primary) keeps rUv host assignments', () => {
  const policy = seedActivityRoutes({ hosts: ['claude', 'codex'] });
  assert.equal(policy.architecture.host, 'claude'); // reasoning stays on claude
  assert.equal(policy.implementation.host, 'codex'); // impl stays on codex
});

test('seedActivityRoutes with codex primary mirrors host assignments', () => {
  const policy = seedActivityRoutes({ hosts: ['claude', 'codex'], primary: 'codex' });
  assert.equal(policy.architecture.host, 'codex'); // codex now leads reasoning
  assert.equal(policy.implementation.host, 'claude'); // claude becomes the alternate
});

test('seedActivityRoutes stamps every seeded entry with provenance:seeded', () => {
  const policy = seedActivityRoutes({ hosts: ['claude', 'codex'], primary: 'codex' });
  assert.ok(Object.values(policy).every((r) => r.provenance === 'seeded'));
});

// ── constants ────────────────────────────────────────────────────────────────
test('DEFAULT_PRIMARY_HOST is claude and PRIMARY_HOSTS mirrors the registry\'s canBePrimary set', () => {
  assert.equal(DEFAULT_PRIMARY_HOST, 'claude'); // a policy choice, not derived from the registry
  // PRIMARY_HOSTS must stay green under capability caps — a host gaining canBePrimary:true
  // should extend this automatically, so derive the expectation from primaryHostIds()
  // instead of a hand-typed host list.
  assert.deepEqual([...PRIMARY_HOSTS].sort(), [...primaryHostIds()].sort());
});

// D2 keystone (ADR-0031 §1): PRIMARY_HOSTS is frozen at import time and stays
// built-in-only ON PURPOSE — it backs the primary-host SELECTION UX
// (`ak setup --primary-host`, `ak host pick`), which this wave deliberately
// does not extend to admitted external hosts (the deferred pick surface; see
// routing.mjs's own comment above PRIMARY_HOSTS). A granted external host
// must NOT appear here even though it DOES appear in the eligibility-
// VALIDATION sibling, effectivePrimaryHostIds() (proven live by
// hosts.test.mjs's drivingHost tests) — these are two different concerns
// that happen to share a capability.
test('PRIMARY_HOSTS stays built-in-only even once an external host is admitted and granted canBePrimary', (t) => {
  t.after(() => resetAdmitted());
  applyAdmitted([{
    entry: {
      id: 'hermes',
      label: 'Hermes',
      install: { bin: 'hermes', externalInstallPolicy: 'detect-never-overwrite' },
      capabilities: {
        canDriveSession: true, canBePrimary: false, canRouteActivities: true,
        commandStatusline: false, transcripts: true, usage: false,
        nativeMcpConfig: false, nativeGuidance: false,
      },
      trust: { approvalPolicy: 'unchanged', changes: [] },
      enabledByDefault: false,
      configProjection: 'ruflo',
      observability: [],
    },
  }], { grantsByName: { hermes: { canBePrimary: true } } });
  assert.equal(PRIMARY_HOSTS.includes('hermes'), false, 'the frozen, import-time SELECTION constant must not grow');
  assert.ok(effectivePrimaryHostIds().includes('hermes'), 'sanity: the eligibility-VALIDATION sibling DOES see it');
});
