import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, SKILL_CAT, RULES, CONFIDENCE_FLOOR, UNCLASSIFIED, classify,
} from '../../src/lib/usage-classify.mjs';

// ── Closed vocabulary ────────────────────────────────────────────────────────

test('CATEGORIES is a closed vocabulary that includes Unclassified', () => {
  assert.ok(CATEGORIES.includes(UNCLASSIFIED));
  assert.equal(UNCLASSIFIED, 'Unclassified');
  assert.equal(new Set(CATEGORIES).size, CATEGORIES.length, 'no duplicate categories');
});

test('every provenance and rule category is drawn from CATEGORIES', () => {
  for (const [key, cat] of Object.entries(SKILL_CAT)) {
    assert.ok(CATEGORIES.includes(cat), `SKILL_CAT[${key}] = ${cat} is off-vocabulary`);
  }
  for (const r of RULES) {
    assert.ok(CATEGORIES.includes(r.category), `RULES ${r.category} is off-vocabulary`);
  }
});

test('classify only ever emits a vocabulary category and a 0..1 confidence', () => {
  const inputs = [
    {},
    { title: 'fix the broken release pipeline' },
    { title: 'refactor the docs' },
    { skill: 'autopilot:run-phase' },
    { plugin: 'frontend-design', title: 'whatever' },
    { title: '', tools: { Agent: 9, Bash: 1 } },
    { title: 'security audit', tools: { Read: 20, Grep: 30, Edit: 1 } },
  ];
  for (const input of inputs) {
    const { category, confidence, basis } = classify(input);
    assert.ok(CATEGORIES.includes(category), `${category} off-vocabulary for ${JSON.stringify(input)}`);
    assert.ok(confidence >= 0 && confidence <= 1, `confidence ${confidence} out of range`);
    assert.equal(typeof basis, 'string');
    assert.ok(basis.length > 0);
  }
});

// ── Layer 1: provenance wins outright ────────────────────────────────────────

test('provenance beats the title — a brainstorming skill titled "fix bug" is not a Bug fix', () => {
  const r = classify({ title: 'fix bug', skill: 'superpowers:brainstorming' });
  assert.equal(r.category, 'Design & planning');
  assert.equal(r.confidence, 1.0);
  assert.equal(r.basis, 'skill:superpowers:brainstorming');
  // and the title alone would genuinely have said Bug fix — so this is a real override
  assert.equal(classify({ title: 'fix bug' }).category, 'Bug fix & debug');
});

test('skill matching is prefix-based, so a sub-command resolves to its skill entry', () => {
  const r = classify({ skill: 'autopilot:run-phase' });
  assert.equal(r.category, SKILL_CAT.autopilot);
  assert.equal(r.confidence, 1.0);
  assert.equal(r.basis, 'skill:autopilot:run-phase');
});

test('the longest matching skill prefix wins, not the first one declared', () => {
  // 'superpowers:test-driven-development' must not be captured by a shorter
  // 'superpowers:*' sibling; the specific entry is the correct one.
  assert.equal(classify({ skill: 'superpowers:test-driven-development' }).category, 'Test & QE');
  assert.equal(classify({ skill: 'superpowers:systematic-debugging' }).category, 'Bug fix & debug');
});

test('plugin provenance applies when no skill is attributed', () => {
  const r = classify({ title: 'fix bug', plugin: 'ui-ux-pro-max' });
  assert.equal(r.category, 'Design & frontend');
  assert.equal(r.confidence, 1.0);
  assert.equal(r.basis, 'plugin:ui-ux-pro-max');
});

test('an unknown skill carries no provenance and falls through to the rules', () => {
  const r = classify({ title: 'fix the crash', skill: 'not-a-known-skill' });
  assert.equal(r.category, 'Bug fix & debug');
  assert.ok(r.confidence < 1.0, 'only provenance may score 1.0');
  assert.equal(r.basis, 'title+tools');
});

// ── Layer 2: rules over the title ────────────────────────────────────────────

test('a strong security title classifies as Security review below provenance confidence', () => {
  const r = classify({ title: 'security vulnerability audit of the auth flow' });
  assert.equal(r.category, 'Security review');
  assert.ok(r.confidence >= 0.7, `expected a strong score, got ${r.confidence}`);
  assert.ok(r.confidence < 1.0, '1.0 is reserved for provenance');
  assert.equal(r.basis, 'title+tools');
});

test('confidence rises with title strength', () => {
  const weak = classify({ title: 'refactor' }).confidence;
  const strong = classify({ title: 'refactor and restructure — extract and decompose the module' }).confidence;
  assert.ok(strong > weak, `${strong} should beat ${weak}`);
});

// ── Ties must be honest, not arbitrary ───────────────────────────────────────

test('a tie between two categories collapses to low confidence, not a confident pick', () => {
  // "refactor the docs" scores Refactor and Docs & writing identically.
  const tie = classify({ title: 'refactor the docs' });
  const clear = classify({ title: 'refactor' });
  assert.ok(tie.confidence < clear.confidence,
    `tie (${tie.confidence}) must score below the unopposed case (${clear.confidence})`);
  assert.equal(tie.category, UNCLASSIFIED, 'a dead-even tie must not be resolved arbitrarily');
  assert.equal(tie.basis, 'weak signal');
  assert.equal(clear.category, 'Refactor');
});

test('margin over the runner-up matters, not just absolute score', () => {
  // Same top score, different runner-up: the contested one must score lower.
  const contested = classify({ title: 'refactor the docs' }).confidence;
  const uncontested = classify({ title: 'refactor' }).confidence;
  assert.ok(uncontested > contested);
});

// ── Layer 2b: the tool prior nudges, never decides ───────────────────────────

test('tool signal with no title signal never clears the floor', () => {
  const agentHeavy = classify({ title: '', tools: { Agent: 8, Task: 4, Bash: 2 } });
  assert.equal(agentHeavy.category, UNCLASSIFIED);
  assert.ok(agentHeavy.confidence < CONFIDENCE_FLOOR);
  assert.equal(agentHeavy.basis, 'weak signal');

  const editHeavy = classify({ title: '', tools: { Edit: 20, Write: 10, Bash: 2 } });
  assert.equal(editHeavy.category, UNCLASSIFIED);

  const readHeavy = classify({ title: '', tools: { Read: 30, Grep: 20, Glob: 10 } });
  assert.equal(readHeavy.category, UNCLASSIFIED);
});

test('the tool prior does break a tie the title could not', () => {
  const noTools = classify({ title: 'refactor the docs' });
  const editHeavy = classify({ title: 'refactor the docs', tools: { Edit: 12, Write: 6, Read: 2 } });
  assert.equal(noTools.category, UNCLASSIFIED);
  assert.equal(editHeavy.category, 'Refactor');
  assert.ok(editHeavy.confidence > noTools.confidence);
  assert.equal(editHeavy.basis, 'title+tools');
});

test('an agent-heavy tool mix lifts Orchestration once the title also carries signal', () => {
  const r = classify({ title: 'orchestrate the release swarm', tools: { Agent: 10, Task: 6, Bash: 4 } });
  assert.ok(['Orchestration', 'Release & CI'].includes(r.category));
  assert.ok(r.confidence > 0);
});

// ── Layer 3: the floor, and Unclassified as a real outcome ───────────────────

test('empty title and no tools yields Unclassified with basis "no signal"', () => {
  const r = classify({ title: '', tools: {} });
  assert.equal(r.category, UNCLASSIFIED);
  assert.equal(r.confidence, 0);
  assert.equal(r.basis, 'no signal');
});

test('classify with no argument at all does not throw', () => {
  const r = classify();
  assert.equal(r.category, UNCLASSIFIED);
  assert.equal(r.basis, 'no signal');
});

test('a title with no keyword signal stays Unclassified rather than being force-fit', () => {
  const r = classify({ title: 'zzzz qqqq wwww', tools: { Bash: 3 } });
  assert.equal(r.category, UNCLASSIFIED);
  assert.equal(r.basis, 'no signal');
});

test('the confidence floor is the documented 0.28 and is enforced', () => {
  assert.equal(CONFIDENCE_FLOOR, 0.28);
  // every Unclassified-by-weakness result sits strictly below the floor
  for (const title of ['refactor the docs', 'wire', 'metadata']) {
    const r = classify({ title });
    if (r.category === UNCLASSIFIED && r.basis === 'weak signal') {
      assert.ok(r.confidence < CONFIDENCE_FLOOR, `${title} → ${r.confidence} should be sub-floor`);
    }
  }
});

// ── Purity ───────────────────────────────────────────────────────────────────

test('classify is pure — it does not mutate its inputs', () => {
  const tools = { Edit: 5, Read: 5 };
  const input = { title: 'add support for a new dashboard tab', tools };
  const snapshot = structuredClone(input);
  classify(input);
  assert.deepEqual(input, snapshot);
});

test('classify is deterministic for identical input', () => {
  const input = { title: 'investigate the flaky e2e regression', tools: { Read: 4, Bash: 6 } };
  assert.deepEqual(classify(input), classify(input));
});
