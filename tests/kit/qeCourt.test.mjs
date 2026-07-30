import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  vendorOf, panelFromRouting, validatePanel, validateCourtConfig,
  qeCourtConfigPath, readQeCourtConfig,
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

test('vendorOf classifies unknown providers as unknown', () => {
  assert.equal(vendorOf('some-new-thing'), 'unknown');
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
