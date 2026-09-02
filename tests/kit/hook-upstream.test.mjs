import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadUpstreamConstraints } from '../../src/lib/hook-audit/upstream.mjs';

const registryFile = path.resolve('config/agentic-dependency-constraints.json');
const now = () => new Date('2026-09-02T12:00:00Z');

test('upstream registry separates valid shape, current evidence, and version applicability', () => {
  const result = loadUpstreamConstraints({
    file: registryFile, now, observedVersions: { ruflo: '3.38.17', 'agentic-qe': '3.14.0' },
  });
  assert.equal(result.status, 'valid');
  assert.equal(result.registryStatus, 'valid');
  assert.equal(result.evidenceStatus, 'current');
  const blocked = result.constraints.find((entry) => entry.id === 'ruflo-3.38.17-3.38.18-block');
  assert.equal(blocked.evidence.observedVersion, '3.38.17');
  assert.equal(blocked.evidence.applicability, 'affected');
  const brain = result.constraints.find((entry) => entry.dependency === 'ruvnet-brain');
  assert.equal(brain, undefined);
});

test('future verification dates are invalid rather than falsely current', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-upstream-'));
  try {
    const document = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    document.lastVerifiedAt = '2099-01-01';
    for (const constraint of document.constraints) constraint.nextRetestAt = '2099-01-02';
    const file = path.join(root, 'constraints.json');
    fs.writeFileSync(file, JSON.stringify(document));
    const result = loadUpstreamConstraints({ file, now });
    assert.equal(result.status, 'invalid');
    assert.match(result.errors.join('\n'), /cannot be in the future/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
