import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  vendorOf, panelFromRouting, validatePanel, qeCourtConfigPath, readQeCourtConfig,
  healJuryVendorCollision, UPSTREAM_JURY_VENDOR_ISSUE,
} from '../../src/lib/qeCourt.mjs';

// vendorOf — ported from qe-court's referee.js

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

test('panelFromRouting ignores the _note key', () => {
  const panel = panelFromRouting({ _note: 'provider ids: ...', defense: { provider: 'claude-code' } });
  assert.equal(panel.some((p) => p.role === '_note'), false);
});

// validatePanel — ported from qe-court's referee.js

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

// healJuryVendorCollision — temporary heal for agentic-qe's own shipped
// default (proffesor-for-testing/agentic-qe#576); remove once fixed upstream.

test('healJuryVendorCollision reassigns jury to deeperReviewer\'s vendor when it collides with the writer', () => {
  const routing = {
    defense: { provider: 'cognitum-low' },
    'prosecutor.codex-review': { provider: 'codex' },
    jury: { provider: 'cognitum-high' },
    deeperReviewer: { provider: 'codex' },
  };
  const fix = healJuryVendorCollision(routing);
  assert.deepEqual(fix, { role: 'jury', from: 'cognitum-high', to: 'codex' });
});

test('healJuryVendorCollision matches agentic-qe\'s actual shipped default', () => {
  // exact routing block agentic-qe@3.13.2 ships in assets/skills/qe-court/config.json
  const routing = {
    defense: { provider: 'cognitum-low' },
    'prosecutor.devils-advocate': { provider: 'cognitum-mid' },
    'prosecutor.brutal-honesty': { provider: 'claude-code', model: 'sonnet' },
    'prosecutor.sherlock': { provider: 'cognitum-high' },
    'prosecutor.security-scanner': { provider: 'cognitum-mid' },
    'prosecutor.mutation': { provider: 'ollama' },
    'prosecutor.codex-review': { provider: 'codex' },
    jury: { provider: 'cognitum-high' },
    deeperReviewer: { provider: 'codex' },
  };
  assert.deepEqual(validatePanel(panelFromRouting(routing)), ['writerIsNeverJuror']);
  assert.deepEqual(healJuryVendorCollision(routing), { role: 'jury', from: 'cognitum-high', to: 'codex' });
});

test('healJuryVendorCollision falls back to any other distinct-vendor seat when deeperReviewer is absent', () => {
  const routing = {
    defense: { provider: 'cognitum-low' },
    'prosecutor.brutal-honesty': { provider: 'claude-code' },
    jury: { provider: 'cognitum-high' },
  };
  const fix = healJuryVendorCollision(routing);
  assert.deepEqual(fix, { role: 'jury', from: 'cognitum-high', to: 'claude-code' });
});

test('healJuryVendorCollision returns null when the panel is already valid', () => {
  const routing = {
    defense: { provider: 'cognitum-low' },
    'prosecutor.codex-review': { provider: 'codex' },
    jury: { provider: 'claude-code' },
  };
  assert.equal(healJuryVendorCollision(routing), null);
});

test('healJuryVendorCollision returns null when there is no distinct-vendor seat to borrow from', () => {
  const routing = {
    defense: { provider: 'cognitum-low' },
    'prosecutor.sherlock': { provider: 'cognitum-high' },
    jury: { provider: 'cognitum-mid' },
  };
  assert.equal(healJuryVendorCollision(routing), null);
});

test('healJuryVendorCollision returns null when there is no jury seat at all', () => {
  const routing = { defense: { provider: 'cognitum-low' }, 'prosecutor.mutation': { provider: 'ollama' } };
  assert.equal(healJuryVendorCollision(routing), null);
});

test('UPSTREAM_JURY_VENDOR_ISSUE points at the filed agentic-qe issue', () => {
  assert.equal(UPSTREAM_JURY_VENDOR_ISSUE, 'https://github.com/proffesor-for-testing/agentic-qe/issues/576');
});
