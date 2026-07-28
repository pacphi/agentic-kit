// Issue #55 — seeded-routing divergence detection, and the catalog-note wording
// that the divergence UX depends on.
//
// The defect #55 describes is INVISIBILITY, not the older model: a machine
// seeded before a catalog bump keeps routing to the prior model and no ak
// surface says so. Measured end-to-end (retort versions-blog.md) the diverged
// pin is *cheaper and faster* on routine work, so every assertion here pins
// NEUTRAL framing — `info` not `warn`, "diverges" not "stale". A test that let
// the severity drift to `warn` would push users to spend 2-3.4x the agentic
// turns to clear a lint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL_CATALOG, PROVIDER_MODEL_CATALOG, formatModelHelp,
  DEFAULT_ROUTES, ACTIVITIES, seedDualRouting, divergedRoutes, refreshSeededRoutes,
  resolveRoutes, COST_AXIS_NOTE,
} from '../../src/lib/routing.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ── item 3 (standalone): catalog notes must not conflate price with cost ─────
// Per-TOKEN price is at parity between opus-5 and opus-4-8; per-TASK cost is
// not (opus-5 takes 2-3.4x the agentic turns, and cache reads scale ~turns^2).
// The notes are rendered into `pick --help`, the interactive prompt, and
// docs/PROVIDERS.md — anyone choosing a model reads them as cost-per-task.
const COST_CLAIM = /(same|lower|higher)\s+(price|cost)/i;
const PER_TOKEN_QUALIFIER = /per[-\s]token/i;

const allCatalogEntries = () => [
  ...Object.entries(MODEL_CATALOG).flatMap(([host, ms]) => ms.map((m) => [`${host}/${m.id}`, m])),
  ...Object.entries(PROVIDER_MODEL_CATALOG).flatMap(([prov, ms]) => ms.map((m) => [`${prov}/${m.id}`, m])),
];

test('no MODEL_CATALOG note states a price/cost comparison without qualifying it as per-token', () => {
  const offenders = [];
  for (const [label, m] of allCatalogEntries()) {
    const note = m.note ?? '';
    if (COST_CLAIM.test(note) && !PER_TOKEN_QUALIFIER.test(note)) offenders.push(`${label}: ${note}`);
  }
  assert.deepEqual(offenders, [],
    'a bare "same/lower/higher price|cost" claim reads as cost-per-task; qualify it with "per-token"');
});

test('every catalog entry carries a non-empty note (the cost-per-task vehicle)', () => {
  for (const [label, m] of allCatalogEntries()) {
    assert.equal(typeof m.note, 'string', `${label} has a note`);
    assert.ok(m.note.trim().length > 0, `${label} note is non-empty`);
  }
});

test('formatModelHelp headers that per-token price is not per-task cost', () => {
  const help = formatModelHelp();
  assert.match(help, PER_TOKEN_QUALIFIER, 'help must name the per-token axis explicitly');
  assert.match(help, /per[-\s]task/i, 'help must name the per-task axis it is contrasted with');
});

// ── divergedRoutes: pure detection ──────────────────────────────────────────

test('divergedRoutes returns [] for a policy seeded from the CURRENT defaults', () => {
  assert.deepEqual(divergedRoutes(seedDualRouting({ hosts: ['claude', 'codex'] })), []);
});

test('divergedRoutes returns [] for an empty policy (nothing persisted, nothing to diverge)', () => {
  assert.deepEqual(divergedRoutes({}), []);
  assert.deepEqual(divergedRoutes(), []);
});

test('divergedRoutes reports a seeded entry whose model no longer matches the default', () => {
  // The exact #55 reproduction: a machine seeded pre-alpha.22 still pinned to
  // the prior Opus generation while DEFAULT_ROUTES moved to claude-opus-5.
  const policy = { architecture: { host: 'claude', model: 'claude-opus-4-8', source: 'seeded' } };
  const out = divergedRoutes(policy);
  assert.equal(out.length, 1);
  assert.equal(out[0].activity, 'architecture');
  assert.equal(out[0].model, 'claude-opus-4-8', 'reports the persisted (current) model');
  assert.equal(out[0].defaultModel, DEFAULT_ROUTES.architecture.model, 'and the default it diverges from');
});

test('divergedRoutes NEVER reports a source:user entry, even pinned to an older model', () => {
  // A deliberate pin is intent, not drift. Reporting it would nag the user
  // about a choice they made on purpose.
  const policy = { architecture: { host: 'claude', model: 'claude-opus-4-8', source: 'user' } };
  assert.deepEqual(divergedRoutes(policy), []);
});

test('divergedRoutes treats an unstamped persisted entry as a user pin (never reported)', () => {
  // resolveRoutes already defaults a source-less entry to 'user' (a hand edit is
  // intent). Divergence detection must inherit that, or a legacy hand-edited
  // kit.json gets flagged as machine drift.
  assert.deepEqual(divergedRoutes({ architecture: { host: 'claude', model: 'claude-opus-4-8' } }), []);
});

test('the unstamped→user rule is pinned on BOTH mechanisms that implement it', () => {
  // "unstamped is never reported" is enforced twice, independently: resolveRoutes
  // defaults `source` to 'user' (routing.mjs), and divergedRoutes reads
  // policy[act].source directly and skips anything !== 'seeded'. Asserting only
  // the divergedRoutes half would let a future change to resolveRoutes' defaulting
  // silently split the two — this pins the equivalence itself.
  const legacy = { architecture: { host: 'claude', model: 'claude-opus-4-8' } }; // no `source`
  assert.equal(resolveRoutes(legacy).architecture.source, 'user');
  assert.deepEqual(divergedRoutes(legacy), []);
});

test('the codex-primary clean-seed assertion actually covers a LADDER-bearing activity', () => {
  // Guards a bug one level down from the top-level mirroring one: if the default
  // were mirrored via a top-level host/model swap while `def.escalate` were left
  // unmirrored, a codex-primary seed would pass the top-level check and then
  // false-positive on every rung. `[]` over a ladder-less sample would not catch
  // that — so first prove ladders are present, THEN prove they are clean.
  const seed = seedDualRouting({ primary: 'codex' });
  const withLadders = Object.entries(seed).filter(([, r]) => r.escalate?.length);
  assert.ok(withLadders.length > 0,
    'anti-vacuity: a codex-primary seed must carry ladders, else this proves nothing');
  for (const [, r] of withLadders) {
    for (const rung of r.escalate) {
      assert.equal(rung.host, 'codex', 'the LADDER must be mirrored too, not just the top-level route');
    }
  }
  assert.deepEqual(divergedRoutes(seed), []);
});

test('a corrupted rung on a MIRRORED activity is still reported (mirroring is not amnesty)', () => {
  const seed = seedDualRouting({ primary: 'codex' });
  const [act] = Object.entries(seed).find(([, r]) => r.escalate?.length);
  seed[act].escalate[0].model = 'gpt-5-codex-mini';
  const [d] = divergedRoutes(seed);
  assert.equal(d.activity, act);
  assert.equal(d.modelDiverged, false, 'only the rung moved — the primary model is untouched');
  assert.equal(d.escalate[0].model, 'gpt-5-codex-mini');
  assert.equal(d.escalate[0].defaultModel, 'gpt-5.4', 'compared against the MIRRORED default rung');
});

test('divergedRoutes ignores a seeded entry that still matches the default', () => {
  const policy = {
    architecture: { host: 'claude', model: DEFAULT_ROUTES.architecture.model, source: 'seeded' },
    design: { host: 'claude', model: 'claude-opus-4-8', source: 'seeded' },
  };
  assert.deepEqual(divergedRoutes(policy).map((d) => d.activity), ['design']);
});

/** The pre-alpha.22 seed: a REAL seeded policy (escalation ladders included,
 *  exactly as seedDualRouting writes them) with every claude-opus-5 pin rewound
 *  to claude-opus-4-8 — primary models and escalation rungs alike. Building this
 *  from seedDualRouting rather than by hand matters: a fixture that silently
 *  dropped `escalate` would under-report divergence and hide the escalate-only
 *  case entirely. */
function priorCatalogSeed({ primary = 'claude' } = {}) {
  const rewind = (m) => (m === 'claude-opus-5' ? 'claude-opus-4-8' : m);
  const policy = seedDualRouting({ hosts: ['claude', 'codex'], primary });
  const out = {};
  for (const [act, r] of Object.entries(policy)) {
    out[act] = {
      ...r,
      model: rewind(r.model),
      ...(r.escalate ? { escalate: r.escalate.map((e) => ({ ...e, model: rewind(e.model) })) } : {}),
    };
  }
  return out;
}

test('divergedRoutes reports the full #55 reproduction: SIX routes, escalation rungs included', () => {
  // The issue observed exactly six on a machine tracking main. Four diverge on
  // their primary model; implementation/testing still pin gpt-5.4 (unchanged)
  // but escalate into the prior Opus — a routing decision that diverged on its
  // own schedule and would be missed by a primary-model-only comparison.
  const diverged = divergedRoutes(priorCatalogSeed());
  assert.deepEqual(diverged.map((d) => d.activity).sort(),
    ['architecture', 'debugging', 'design', 'implementation', 'security-analysis', 'testing']);
  assert.equal(diverged.length, 6);
});

test('an escalate-only divergence is flagged as such, never as a bogus same-model diff', () => {
  // implementation's primary model did not move, so rendering it as
  // "gpt-5.4 vs gpt-5.4" would be nonsense. `modelDiverged` lets callers branch.
  const d = divergedRoutes(priorCatalogSeed()).find((x) => x.activity === 'implementation');
  assert.equal(d.modelDiverged, false, 'the primary model is unchanged');
  assert.equal(d.model, d.defaultModel, 'and both sides agree on it');
  assert.ok(d.escalate.length > 0, 'the divergence lives entirely in the escalation ladder');
  assert.equal(d.escalate[0].model, 'claude-opus-4-8');
  assert.equal(d.escalate[0].defaultModel, DEFAULT_ROUTES.implementation.escalate[0].model);
});

test('a primary-model divergence carries modelDiverged and an empty escalation delta', () => {
  const d = divergedRoutes(priorCatalogSeed()).find((x) => x.activity === 'architecture');
  assert.equal(d.modelDiverged, true);
  assert.deepEqual(d.escalate, [], 'architecture has no ladder to diverge');
});

// ── swapRoute mirroring, attacked directly ─────────────────────────────────
// `divergedRoutes` mirrors the default via swapRoute when an entry's host
// differs from the default's. Get this wrong in EITHER direction and the
// feature is worthless: too eager and every codex-primary route false-positives
// (noise worse than the original invisibility); too lax and mirroring becomes a
// blanket amnesty that hides real drift. Both directions are attacked here.

test('divergedRoutes returns [] for a CODEX-PRIMARY seed (mirrored routes are not drift)', () => {
  assert.deepEqual(divergedRoutes(seedDualRouting({ hosts: ['claude', 'codex'], primary: 'codex' })), []);
});

test('a codex-primary seed really is host-mirrored — the fixture is not vacuous', () => {
  // Guards the test above from passing for the wrong reason. If swapRoute ever
  // became a no-op, the codex-primary seed would equal the claude-primary one
  // and "[] means mirroring works" would prove nothing at all.
  const claudePrimary = seedDualRouting({ hosts: ['claude', 'codex'], primary: 'claude' });
  const codexPrimary = seedDualRouting({ hosts: ['claude', 'codex'], primary: 'codex' });
  const flipped = ACTIVITIES.filter((a) => claudePrimary[a] && codexPrimary[a]
    && claudePrimary[a].host !== codexPrimary[a].host);
  assert.ok(flipped.length > 0, 'a codex-primary seed must actually mirror hosts, or this suite is vacuous');
});

test('mirroring is scoped to the host swap — it does not excuse a wrong model on the mirrored host', () => {
  // The dangerous failure: treating "host differs from default" as licence to
  // skip the model comparison entirely. Here the host legitimately differs
  // (codex-primary mirror) AND the model is wrong; it must still be reported.
  const seed = seedDualRouting({ hosts: ['claude', 'codex'], primary: 'codex' });
  const act = ACTIVITIES.find((a) => seed[a] && seed[a].host !== DEFAULT_ROUTES[a].host);
  assert.ok(act, 'need at least one mirrored activity to attack');
  const policy = { ...seed, [act]: { ...seed[act], model: 'definitely-not-the-seeded-model' } };
  const hit = divergedRoutes(policy).find((d) => d.activity === act);
  assert.ok(hit, `a mirrored route with a wrong model must still be reported (${act})`);
  assert.equal(hit.modelDiverged, true);
  assert.equal(hit.defaultModel, seed[act].model, 'compared against the MIRRORED default, not the raw one');
});

test('a claude-primary seed is not silently excused by the mirroring branch either', () => {
  // Same attack from the unmirrored side: hosts match the default, so the
  // mirroring branch must not engage at all.
  const seed = seedDualRouting({ hosts: ['claude', 'codex'], primary: 'claude' });
  const policy = { ...seed, architecture: { ...seed.architecture, model: 'definitely-not-the-seeded-model' } };
  const hit = divergedRoutes(policy).find((d) => d.activity === 'architecture');
  assert.ok(hit);
  assert.equal(hit.defaultModel, DEFAULT_ROUTES.architecture.model);
});

test('a hand-moved host with a current model is not reported as divergence', () => {
  // A user (or a primary swap) can put an activity on the other host while its
  // model is exactly what seeding would produce there. That is not drift.
  const mirrored = seedDualRouting({ hosts: ['claude', 'codex'], primary: 'codex' });
  const act = ACTIVITIES.find((a) => mirrored[a] && mirrored[a].host !== DEFAULT_ROUTES[a].host);
  assert.deepEqual(divergedRoutes({ [act]: { ...mirrored[act] } }), []);
});

test('a codex-primary seed on the PRIOR catalog still reports real divergence', () => {
  // The mirroring must not suppress genuine drift — only false positives.
  const diverged = divergedRoutes(priorCatalogSeed({ primary: 'codex' }));
  assert.ok(diverged.length > 0, 'a mirrored seed pinned to the prior catalog still diverges');
  for (const d of diverged) {
    assert.ok(d.modelDiverged || d.escalate.length > 0, `${d.activity} reported with no actual delta`);
  }
});

test('refreshSeededRoutes clears an escalate-only divergence too', () => {
  const policy = priorCatalogSeed();
  const out = refreshSeededRoutes(policy, { activities: ['implementation'] });
  assert.deepEqual(divergedRoutes(out).map((d) => d.activity).sort(),
    ['architecture', 'debugging', 'design', 'security-analysis', 'testing'],
    'implementation converged, including its ladder');
  assert.equal(out.implementation.escalate[0].model, DEFAULT_ROUTES.implementation.escalate[0].model);
});

test('refreshing the full prior-catalog seed converges every one of the six', () => {
  assert.deepEqual(divergedRoutes(refreshSeededRoutes(priorCatalogSeed())), []);
});

test('divergedRoutes is pure — it does not mutate the policy it is given', () => {
  const policy = { architecture: { host: 'claude', model: 'claude-opus-4-8', source: 'seeded' } };
  const before = JSON.stringify(policy);
  divergedRoutes(policy);
  assert.equal(JSON.stringify(policy), before);
});

test('each diverged entry carries BOTH models cost-per-task characteristics, not just IDs', () => {
  // The refresh diff has to let the user decide, and the decision genuinely goes
  // both ways — so the note (the work-per-task vehicle) must ride along for the
  // current pin AND the default it would move to.
  const [d] = divergedRoutes({ architecture: { host: 'claude', model: 'claude-opus-4-8', source: 'seeded' } });
  for (const key of ['currentNote', 'defaultNote']) {
    assert.equal(typeof d[key], 'string', `${key} present`);
    assert.ok(d[key].trim().length > 0, `${key} non-empty`);
  }
  assert.notEqual(d.currentNote, d.defaultNote, 'the two sides must be distinguishable');
});

// ── refreshSeededRoutes: the opt-in, per-activity correction ────────────────

test('refreshSeededRoutes re-seeds every diverged activity when none are named', () => {
  const policy = {
    architecture: { host: 'claude', model: 'claude-opus-4-8', source: 'seeded' },
    design: { host: 'claude', model: 'claude-opus-4-8', source: 'seeded' },
  };
  const out = refreshSeededRoutes(policy);
  assert.equal(out.architecture.model, DEFAULT_ROUTES.architecture.model);
  assert.equal(out.design.model, DEFAULT_ROUTES.design.model);
  assert.deepEqual(divergedRoutes(out), [], 'refreshing converges — nothing diverges afterwards');
});

test('refreshSeededRoutes leaves a source:user pin untouched even when explicitly named', () => {
  // The acceptance criterion that matters most: a deliberate pin must survive a
  // refresh the user aimed straight at it.
  const policy = { architecture: { host: 'claude', model: 'claude-opus-4-8', source: 'user' } };
  const out = refreshSeededRoutes(policy, { activities: ['architecture'] });
  assert.deepEqual(out.architecture, policy.architecture);
  assert.equal(out.architecture.source, 'user');
});

test('refreshSeededRoutes is per-activity selectable — unnamed diverged routes stay put', () => {
  // The right answer differs across the six, so refresh must not be all-or-nothing.
  const policy = {
    architecture: { host: 'claude', model: 'claude-opus-4-8', source: 'seeded' },
    design: { host: 'claude', model: 'claude-opus-4-8', source: 'seeded' },
  };
  const out = refreshSeededRoutes(policy, { activities: ['architecture'] });
  assert.equal(out.architecture.model, DEFAULT_ROUTES.architecture.model, 'named route refreshed');
  assert.equal(out.design.model, 'claude-opus-4-8', 'unnamed route deliberately left diverged');
});

test('refreshSeededRoutes keeps the refreshed entry stamped seeded (so it stays refreshable)', () => {
  const out = refreshSeededRoutes({ architecture: { host: 'claude', model: 'claude-opus-4-8', source: 'seeded' } });
  assert.equal(out.architecture.source, 'seeded');
});

test('refreshSeededRoutes is pure — the input policy is not mutated', () => {
  const policy = { architecture: { host: 'claude', model: 'claude-opus-4-8', source: 'seeded' } };
  const before = JSON.stringify(policy);
  const out = refreshSeededRoutes(policy);
  assert.equal(JSON.stringify(policy), before, 'input untouched');
  assert.notEqual(out, policy, 'a NEW policy is returned');
});

test('refreshSeededRoutes is a no-op on a policy seeded from current defaults', () => {
  const policy = seedDualRouting({ hosts: ['claude', 'codex'] });
  assert.deepEqual(refreshSeededRoutes(policy), policy);
});

test('COST_AXIS_NOTE contrasts the per-token and per-task axes by name', () => {
  assert.match(COST_AXIS_NOTE, PER_TOKEN_QUALIFIER);
  assert.match(COST_AXIS_NOTE, /per[-\s]task/i);
});

// ── docs/PROVIDERS.md renders the catalog — keep the two from drifting ──────

test('docs/PROVIDERS.md renders every HOST model note verbatim', () => {
  // The notes reach users through three surfaces (pick --help, the interactive
  // prompt, and this table). A doc regenerated by hand drifts silently, which is
  // how the misleading price wording survived a catalog bump in the first place.
  // Scoped to MODEL_CATALOG: the provider-axis models are documented in prose
  // rather than the generated table (asserted separately below).
  const doc = fs.readFileSync(path.join(PKG_ROOT, 'docs', 'PROVIDERS.md'), 'utf8');
  for (const [host, models] of Object.entries(MODEL_CATALOG)) {
    for (const m of models) {
      assert.ok(doc.includes(m.note), `docs/PROVIDERS.md is stale for ${host}/${m.id} — missing note: ${m.note}`);
    }
  }
});

test('docs/PROVIDERS.md documents every provider-axis (aqe-fallback) model by id', () => {
  const doc = fs.readFileSync(path.join(PKG_ROOT, 'docs', 'PROVIDERS.md'), 'utf8');
  for (const [prov, models] of Object.entries(PROVIDER_MODEL_CATALOG)) {
    for (const m of models) {
      assert.ok(doc.includes(m.id), `docs/PROVIDERS.md never mentions ${prov} model ${m.id}`);
    }
  }
});

test('docs/PROVIDERS.md states the per-token vs per-task caveat alongside the table', () => {
  const doc = fs.readFileSync(path.join(PKG_ROOT, 'docs', 'PROVIDERS.md'), 'utf8');
  assert.match(doc, PER_TOKEN_QUALIFIER);
  assert.match(doc, /per[-\s]task/i);
});
