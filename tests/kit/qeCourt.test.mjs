import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  vendorOf, panelFromRouting, validatePanel, validateCourtConfig,
  qeCourtConfigPath, readQeCourtConfig, qeCourtReadiness,
} from '../../src/lib/qeCourt.mjs';

// vendorOf — ported from qe-court's referee.ts

test('vendorOf classifies claude-family provider ids', () => {
  assert.equal(vendorOf('claude-code'), 'claude');
  assert.equal(vendorOf('claude'), 'claude');
});

test('vendorOf classifies cognitum tiers as one vendor', () => {
  assert.equal(vendorOf('cognitum-low'), 'cognitum');
  assert.equal(vendorOf('cognitum-high'), 'cognitum');
});

test('vendorOf classifies codex/openai/gpt/o3/o4 as the gpt vendor', () => {
  for (const p of ['codex', 'openai', 'gpt-5.6', 'o3-mini', 'o4-mini']) {
    assert.equal(vendorOf(p), 'gpt', p);
  }
});

test('vendorOf tags an unregistered provider with its own id instead of a shared "unknown" bucket', () => {
  assert.equal(vendorOf('some-new-thing'), 'unregistered:some-new-thing');
  assert.equal(vendorOf('hermes-something'), 'unregistered:hermes-something');
});

// panelFromRouting

test('panelFromRouting flattens the routing map into {role, provider} pairs', () => {
  const panel = panelFromRouting({
    defense: { provider: 'cognitum-low' },
    jury: { provider: 'cognitum-high' },
  });
  assert.deepEqual(panel, [
    { role: 'defense', provider: 'cognitum-low' },
    { role: 'jury', provider: 'cognitum-high' },
  ]);
});

test('panelFromRouting ignores metadata and provider-less seats', () => {
  const panel = panelFromRouting({
    _note: 'provider ids: ...',
    _description: { provider: 'not-a-seat' },
    defense: { provider: 'claude-code' },
    jury: {},
  });
  assert.deepEqual(panel, [{ role: 'defense', provider: 'claude-code' }]);
});

// validatePanel / validateCourtConfig — ported from qe-court's referee.ts

test('validatePanel passes a 2-vendor panel with an independent jury', () => {
  const panel = [
    { role: 'defense', provider: 'cognitum-low' },
    { role: 'prosecutor.codex-review', provider: 'codex' },
    { role: 'jury', provider: 'claude-code' },
  ];
  assert.deepEqual(validatePanel(panel), []);
});

test('validatePanel flags vendor-diversity when fewer than minVendors are seated', () => {
  const panel = [
    { role: 'defense', provider: 'claude-code' },
    { role: 'jury', provider: 'claude' },
  ];
  assert.deepEqual(validatePanel(panel), ['vendor-diversity', 'writerIsNeverJuror']);
});

test('validatePanel flags writerIsNeverJuror when jury shares a vendor with the writer/defense', () => {
  const panel = [
    { role: 'defense', provider: 'claude-code' },
    { role: 'prosecutor.security-scanner', provider: 'cognitum-mid' },
    { role: 'jury', provider: 'claude' }, // same vendor ('claude') as defense
  ];
  assert.deepEqual(validatePanel(panel), ['writerIsNeverJuror']);
});

test('validatePanel respects a custom minVendors policy', () => {
  const panel = [
    { role: 'defense', provider: 'claude-code' },
    { role: 'prosecutor.codex-review', provider: 'codex' },
    { role: 'jury', provider: 'cognitum-high' },
  ];
  assert.deepEqual(validatePanel(panel, { minVendors: 2 }), []);
  assert.deepEqual(validatePanel(panel, { minVendors: 4 }), ['vendor-diversity']);
});

test('validatePanel binds the shipped option names and requires a jury', () => {
  const panel = [
    { role: 'defense', provider: 'claude-code' },
    { role: 'prosecutor.codex-review', provider: 'codex' },
  ];
  assert.deepEqual(
    validatePanel(panel, { minDistinctVendors: 3 }),
    ['vendor-diversity', 'missing-jury'],
  );
});

test('validatePanel never lets two distinct unregistered providers satisfy minVendors, and treats them as possibly-colluding', () => {
  const panel = [
    { role: 'defense', provider: 'hermes-a' },
    { role: 'jury', provider: 'zeta-b' },
  ];
  // distinct unregistered ids never count toward vendor-diversity, AND ak
  // can't prove they're different vendors either — so writerIsNeverJuror
  // fails closed too (this is the reviewer's minimal repro for F-11 round 2).
  assert.deepEqual(validatePanel(panel), ['vendor-diversity', 'writerIsNeverJuror']);
});

test('validatePanel does NOT trip writerIsNeverJuror when only the jury is unregistered and all writers are registered', () => {
  const panel = [
    { role: 'defense', provider: 'claude-code' },
    { role: 'jury', provider: 'hermes-a' },
  ];
  // matches old shared-'unknown'-vendor behavior: a registered writer vendor
  // can never equal an unregistered jury tag, so no collusion is assumed.
  assert.deepEqual(validatePanel(panel), ['vendor-diversity']);
});

test('direction of divergence: ak is never looser than the old shared-"unknown"-vendor model', () => {
  // Reviewer's minimal repro: under the OLD code, every unrecognized id
  // mapped to the single literal 'unknown' vendor, so vendorOf(jury) ===
  // vendorOf(defense) always held here and tripped writerIsNeverJuror. The
  // per-id `unregistered:<id>` tagging must not silently drop that
  // violation — new violations must be a superset of what old code found.
  const panel = [
    { role: 'defense', provider: 'hermes-a' },
    { role: 'jury', provider: 'zeta-b' },
  ];
  const oldViolations = ['vendor-diversity', 'writerIsNeverJuror'];
  const newViolations = validatePanel(panel);
  for (const violation of oldViolations) {
    assert.ok(newViolations.includes(violation), `expected new violations to retain '${violation}'`);
  }
});

test('validatePanel: minVendors 0 never flags vendor-diversity, even for an all-unregistered panel', () => {
  const panel = [
    { role: 'defense', provider: 'hermes-a' },
    { role: 'jury', provider: 'zeta-b' },
  ];
  assert.deepEqual(validatePanel(panel, { minVendors: 0, writerIsNeverJuror: false }), []);
});

test('validatePanel: minVendors 1 flags vendor-diversity when only unregistered vendors are seated', () => {
  const panel = [
    { role: 'defense', provider: 'hermes-a' },
    { role: 'jury', provider: 'zeta-b' },
  ];
  assert.deepEqual(validatePanel(panel, { minVendors: 1, writerIsNeverJuror: false }), ['vendor-diversity']);
});

test('validatePanel handles an empty panel: vendor-diversity and missing-jury both flagged', () => {
  assert.deepEqual(validatePanel([]), ['vendor-diversity', 'missing-jury']);
});

test('validatePanel still trips writerIsNeverJuror when writer and jury share the same unregistered id', () => {
  const panel = [
    { role: 'defense', provider: 'hermes-x' },
    { role: 'prosecutor.a', provider: 'codex' },
    { role: 'prosecutor.b', provider: 'claude-code' },
    { role: 'jury', provider: 'hermes-x' },
  ];
  // registered gpt + claude vendors satisfy minVendors on their own, so this
  // isolates writerIsNeverJuror: same unregistered id seated as writer and juror.
  assert.deepEqual(validatePanel(panel), ['writerIsNeverJuror']);
});

test('validatePanel honors an explicit writerIsNeverJuror:false policy', () => {
  const panel = [
    { role: 'defense', provider: 'claude-code' },
    { role: 'prosecutor.codex-review', provider: 'codex' },
    { role: 'jury', provider: 'claude' },
  ];
  assert.deepEqual(validatePanel(panel, { writerIsNeverJuror: false }), []);
});

test('agentic-qe 3.13.3 shipped config passes its declared policy', () => {
  const config = {
    routing: {
      _note: 'provider ids',
      defense: { provider: 'claude-code' },
      'prosecutor.devils-advocate': { provider: 'cognitum-mid' },
      'prosecutor.brutal-honesty': { provider: 'claude-code', model: 'sonnet' },
      'prosecutor.sherlock': { provider: 'cognitum-high' },
      'prosecutor.security-scanner': { provider: 'cognitum-mid' },
      'prosecutor.mutation': { provider: 'ollama' },
      'prosecutor.codex-review': { provider: 'codex' },
      jury: { provider: 'cognitum-high' },
      deeperReviewer: { provider: 'codex' },
    },
    options: {
      writerIsNeverJuror: true,
      minDistinctVendors: 2,
    },
  };
  assert.deepEqual(validateCourtConfig(config), []);
});

// qeCourtConfigPath / readQeCourtConfig

test('qeCourtConfigPath points at .claude/skills/qe-court/config.json under root', () => {
  assert.equal(qeCourtConfigPath('/x/repo'), path.join('/x/repo', '.claude', 'skills', 'qe-court', 'config.json'));
});

test('readQeCourtConfig returns null when the skill has not created its config yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-qecourt-'));
  assert.equal(readQeCourtConfig(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readQeCourtConfig reads an existing config.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-qecourt-'));
  const file = qeCourtConfigPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ routing: { jury: { provider: 'cognitum-high' } } }));
  const cfg = readQeCourtConfig(dir);
  assert.equal(cfg.routing.jury.provider, 'cognitum-high');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('qeCourtReadiness fails closed when consumer artifacts are not self-contained', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-qecourt-'));
  try {
    for (const hostDir of ['.claude', '.agents']) {
      const skill = path.join(dir, hostDir, 'skills', 'qe-court');
      fs.mkdirSync(path.join(skill, 'schemas'), { recursive: true });
      fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(skill, 'evals'), { recursive: true });
      fs.writeFileSync(path.join(skill, 'SKILL.md'), '# qe-court\n');
      fs.writeFileSync(path.join(skill, 'config.json'), JSON.stringify({
        $schema: './config-schema.json',
        routing: { defense: { provider: 'claude-code' }, jury: { provider: 'codex' } },
      }));
      fs.writeFileSync(path.join(skill, 'schemas', 'output.json'), '{}');
      fs.writeFileSync(path.join(skill, 'scripts', 'validate-config.json'), '{}');
      fs.writeFileSync(path.join(skill, 'evals', 'qe-court.yaml'), 'name: qe-court\n');
    }

    const readiness = qeCourtReadiness(dir);
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.routingViolations, []);
    assert.ok(readiness.artifactIssues.some((issue) => issue.includes('config-schema.json')));
    assert.ok(readiness.artifactIssues.some((issue) => issue.includes('referee implementation')));
    assert.ok(readiness.artifactIssues.some((issue) => issue.includes('referee oracle')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('qeCourtReadiness requires matching Claude and Codex projections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-qecourt-'));
  try {
    for (const [hostDir, jury] of [['.claude', 'codex'], ['.agents', 'cognitum-high']]) {
      const skill = path.join(dir, hostDir, 'skills', 'qe-court');
      fs.mkdirSync(path.join(skill, 'schemas'), { recursive: true });
      fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(skill, 'evals'), { recursive: true });
      for (const rel of ['SKILL.md', 'config-schema.json', 'schemas/output.json', 'scripts/validate-config.json', 'evals/qe-court.yaml']) {
        fs.writeFileSync(path.join(skill, rel), '{}');
      }
      fs.writeFileSync(path.join(skill, 'config.json'), JSON.stringify({
        routing: { defense: { provider: 'claude-code' }, jury: { provider: jury } },
      }));
    }
    fs.mkdirSync(path.join(dir, 'src', 'skills', 'qe-court'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests', 'unit', 'skills', 'qe-court'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'skills', 'qe-court', 'referee.ts'), 'export {};');
    fs.writeFileSync(path.join(dir, 'tests', 'unit', 'skills', 'qe-court', 'referee.test.ts'), 'export {};');

    const readiness = qeCourtReadiness(dir);
    assert.equal(readiness.ready, false);
    assert.ok(readiness.artifactIssues.includes('Claude and Codex qe-court config projections differ'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
