// Retired models are a DIFFERENT mechanism from divergence, and the whole point
// of separating them is that they are allowed to do something divergence must
// never do: override a user's explicit pin. That makes the blast radius of a
// wrong RETIRED_MODELS entry large, so this suite attacks the boundary from both
// sides — a retired id must be substituted everywhere it can be dispatched, and
// a merely-superseded id must be left completely alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RETIRED_MODELS, retirementOf, migrateRetiredRoutes, resolveRoutes,
  MODEL_CATALOG, DEFAULT_ROUTES, seedActivityRoutes, divergedRoutes, ACTIVITIES,
} from '../../src/lib/routing.mjs';
import { migrateRetiredRoutesInConfig } from '../../src/lib/providers.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── The map itself ───────────────────────────────────────────────────────────

test('every retirement names a replacement that is itself current', () => {
  // A replacement pointing at another retired model would migrate a policy from
  // one dead id straight to a second one.
  for (const [id, r] of Object.entries(RETIRED_MODELS)) {
    assert.ok(r.replacement, `${id} has no replacement`);
    assert.equal(retirementOf(r.replacement), null,
      `${id} migrates to ${r.replacement}, which is ITSELF retired`);
  }
});

test('no retired model is still offered as a curated pick', () => {
  const offered = Object.values(MODEL_CATALOG).flat().map((m) => m.id);
  for (const id of Object.keys(RETIRED_MODELS)) {
    assert.ok(!offered.includes(id), `MODEL_CATALOG still offers retired model ${id}`);
  }
});

test('no default route targets a retired model, at any escalation depth', () => {
  for (const [act, r] of Object.entries(DEFAULT_ROUTES)) {
    assert.equal(retirementOf(r.model), null, `default for ${act} is retired: ${r.model}`);
    for (const rung of r.escalation ?? []) {
      assert.equal(retirementOf(rung.model), null, `${act} escalates into retired ${rung.model}`);
    }
  }
});

test('claude-opus-4-8 is deliberately NOT retired', () => {
  // It carries no deprecation notice and is the migration target for opus-4-1.
  // Listing it here would silently override user pins on a live model — the
  // exact failure this separation exists to prevent. If Anthropic ever does
  // retire it, this assertion is the intended place to find out.
  assert.equal(retirementOf('claude-opus-4-8'), null);
  assert.ok(Object.values(MODEL_CATALOG).flat().some((m) => m.id === 'claude-opus-4-8'),
    'a live-but-superseded model stays listed so divergence can explain its trade');
});

test('retirementOf is null-safe for absent and non-string models', () => {
  for (const v of [undefined, null, '', 0, {}, []]) assert.equal(retirementOf(v), null);
});

// ── resolveRoutes substitution (the run-safety half) ─────────────────────────

test('a retired model is substituted at read time even for a user pin', () => {
  const routes = resolveRoutes({
    implementation: { host: 'codex', model: 'gpt-5.4', provenance: 'user' },
  });
  assert.equal(routes.implementation.model, 'gpt-5.6-terra');
  assert.equal(routes.implementation.retiredFrom, 'gpt-5.4');
  assert.equal(routes.implementation.provenance, 'user', 'provenance is not laundered by the swap');
});

test('a retired ESCALATION rung is substituted independently of the primary model', () => {
  const routes = resolveRoutes({
    implementation: {
      host: 'codex',
      model: 'gpt-5.6-terra', // current
      escalation: [{ host: 'codex', model: 'gpt-5.3-codex' }], // retired
      provenance: 'seeded',
    },
  });
  assert.equal(routes.implementation.model, 'gpt-5.6-terra');
  assert.equal(Object.hasOwn(routes.implementation, 'retiredFrom'), false,
    'the primary model never moved, so the route must not claim it did');
  assert.equal(routes.implementation.escalation[0].model, 'gpt-5.6-luna');
  assert.equal(routes.implementation.escalation[0].retiredFrom, 'gpt-5.3-codex');
});

test('a current model passes through resolveRoutes untouched and unmarked', () => {
  const routes = resolveRoutes({
    architecture: { host: 'claude', model: 'claude-opus-4-8', provenance: 'user' },
  });
  assert.equal(routes.architecture.model, 'claude-opus-4-8');
  assert.equal(Object.hasOwn(routes.architecture, 'retiredFrom'), false);
});

test('a host-only override still resolves to a null model, not a retired one', () => {
  // The qe-court B1 rule: a cross-host override leaves the model to the adapter.
  // Substitution must not resurrect a model into that deliberate null.
  const routes = resolveRoutes({ implementation: { host: 'claude', provenance: 'user' } });
  assert.equal(routes.implementation.model, null);
  assert.equal(Object.hasOwn(routes.implementation, 'retiredFrom'), false);
});

test('resolveRoutes on a clean seed marks nothing as retired', () => {
  const routes = resolveRoutes(seedActivityRoutes({ hosts: ['claude', 'codex'] }));
  for (const act of ACTIVITIES) {
    assert.equal(Object.hasOwn(routes[act], 'retiredFrom'), false, `${act} falsely marked retired`);
  }
});

// ── migrateRetiredRoutes (the persistence half) ──────────────────────────────

test('migrateRetiredRoutes rewrites a seeded route and reports the change', () => {
  const { routes, changes } = migrateRetiredRoutes({
    implementation: { host: 'codex', model: 'gpt-5.4', provenance: 'seeded' },
  });
  assert.equal(routes.implementation.model, 'gpt-5.6-terra');
  assert.deepEqual(changes, [{
    activity: 'implementation', field: 'model', from: 'gpt-5.4', to: 'gpt-5.6-terra',
    retiresOn: '2026-08-31', provenance: 'seeded', rewritten: true,
  }]);
});

test('migrateRetiredRoutes REPORTS a user pin but never rewrites it', () => {
  const policy = { implementation: { host: 'codex', model: 'gpt-5.4', provenance: 'user' } };
  const { routes, changes } = migrateRetiredRoutes(policy);
  assert.equal(routes.implementation.model, 'gpt-5.4', 'a user pin survives on disk');
  assert.equal(changes.length, 1, 'but the user is still told it is dead');
  assert.equal(changes[0].rewritten, false);
  assert.equal(changes[0].provenance, 'user');
});

test('an unstamped persisted entry is treated as a user pin (never rewritten)', () => {
  // Matches resolveRoutes' own unstamped→user rule; if these two ever disagree,
  // ak would rewrite a hand edit it promised not to touch.
  const { routes, changes } = migrateRetiredRoutes({
    implementation: { host: 'codex', model: 'gpt-5.4' },
  });
  assert.equal(routes.implementation.model, 'gpt-5.4');
  assert.equal(changes[0].rewritten, false);
});

test('migrateRetiredRoutes rewrites escalation rungs, not just primary models', () => {
  const { routes, changes } = migrateRetiredRoutes({
    testing: {
      host: 'codex', model: 'gpt-5.6-terra', provenance: 'seeded',
      escalation: [{ host: 'codex', model: 'gpt-5.3-codex' }],
    },
  });
  assert.equal(routes.testing.escalation[0].model, 'gpt-5.6-luna');
  assert.deepEqual(changes.map((c) => c.field), ['escalation[0].model']);
});

test('migrateRetiredRoutes is pure — the input policy is not mutated', () => {
  const policy = { implementation: { host: 'codex', model: 'gpt-5.4', provenance: 'seeded' } };
  const snapshot = structuredClone(policy);
  migrateRetiredRoutes(policy);
  assert.deepEqual(policy, snapshot);
});

test('migrateRetiredRoutes is a no-op on a policy seeded from current defaults', () => {
  const seed = seedActivityRoutes({ hosts: ['claude', 'codex'] });
  const { routes, changes } = migrateRetiredRoutes(seed);
  assert.deepEqual(changes, []);
  assert.deepEqual(routes, seed);
});

test('migration and divergence do not double-report the same entry', () => {
  // A retired seeded model is migrated to the current default, which by
  // construction clears its divergence too — so after migrating, the same policy
  // must not still be asking the user to decide about it.
  const policy = { documentation: { host: 'codex', model: 'gpt-5.3-codex', provenance: 'seeded' } };
  assert.ok(divergedRoutes(policy).length > 0, 'anti-vacuity: it diverges before migration');
  const { routes } = migrateRetiredRoutes(policy);
  assert.deepEqual(divergedRoutes(routes), []);
});

// ── migrateRetiredRoutesInConfig (the cfg wrapper ak sync calls) ─────────────

test('migrateRetiredRoutesInConfig mutates cfg only when something was rewritten', () => {
  const cfg = { routing: { routes: { documentation: { host: 'codex', model: 'gpt-5.3-codex', provenance: 'seeded' } } } };
  const out = migrateRetiredRoutesInConfig(cfg);
  assert.equal(out.changed, true);
  assert.equal(cfg.routing.routes.documentation.model, 'gpt-5.6-luna');
});

test('migrateRetiredRoutesInConfig reports a user pin without touching cfg', () => {
  const cfg = { routing: { routes: { documentation: { host: 'codex', model: 'gpt-5.3-codex', provenance: 'user' } } } };
  const out = migrateRetiredRoutesInConfig(cfg);
  assert.equal(out.changed, false, 'nothing to persist');
  assert.equal(out.changes.length, 1, 'but still worth telling the user');
  assert.equal(cfg.routing.routes.documentation.model, 'gpt-5.3-codex');
});

test('migrateRetiredRoutesInConfig tolerates an absent or empty routing policy', () => {
  for (const cfg of [{}, { routing: {} }, { routing: { routes: {} } }]) {
    assert.deepEqual(migrateRetiredRoutesInConfig(cfg), { changed: false, changes: [] });
  }
});

// ── Documentation ────────────────────────────────────────────────────────────

test('docs/PROVIDERS.md names every retired model and its replacement', () => {
  const doc = fs.readFileSync(path.join(PKG_ROOT, 'docs', 'PROVIDERS.md'), 'utf8');
  for (const [id, r] of Object.entries(RETIRED_MODELS)) {
    assert.ok(doc.includes(id), `docs/PROVIDERS.md never mentions retired model ${id}`);
    assert.ok(doc.includes(r.replacement), `docs/PROVIDERS.md never names ${id}'s replacement ${r.replacement}`);
  }
});
