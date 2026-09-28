import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UPSTREAM_REGISTRY_FILE, loadUpstreamConstraints } from '../../src/lib/hook-audit/upstream.mjs';

const registryFile = UPSTREAM_REGISTRY_FILE;
// State re-reads move lastCheckedAt (the tests' clock); only a conformance run moves lastVerifiedAt.
const { lastVerifiedAt, lastCheckedAt } = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
const now = () => new Date(`${lastCheckedAt}T12:00:00Z`);
// Evidence is current by definition on the day every constraint was re-verified.
const verifiedNow = () => new Date(`${lastVerifiedAt}T12:00:00Z`);

function withDocument(mutate, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-upstream-'));
  try {
    const document = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    mutate(document);
    const file = path.join(root, 'constraints.json');
    fs.writeFileSync(file, JSON.stringify(document));
    return run(file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function globPattern(glob) {
  const source = glob.split(/(\*\*\/|\*\*|\*)/).map((part) => {
    if (part === '**/') return '(?:.*/)?';
    if (part === '**') return '.*';
    if (part === '*') return '[^/]*';
    return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${source}$`);
}

test('the registry ships with ak: the loader reads it from inside the published src/ tree', () => {
  const relative = path.relative(process.cwd(), registryFile).split(path.sep).join('/');
  assert.match(relative, /^src\//, 'runtime data must live under src/ (package.json files never ships config/)');
  const { files } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const included = files.filter((entry) => !entry.startsWith('!'))
    .some((entry) => (entry.endsWith('/') ? relative.startsWith(entry) : relative === entry));
  const excluded = files.filter((entry) => entry.startsWith('!'))
    .some((entry) => globPattern(entry.slice(1)).test(relative));
  assert.ok(included && !excluded, `${relative} is not in the package.json files allowlist`);
  assert.notEqual(loadUpstreamConstraints({ now }).status, 'absent', 'the default path must find the registry');
});

test('upstream registry separates valid shape, current evidence, and version applicability', () => {
  const result = loadUpstreamConstraints({
    file: registryFile, now: verifiedNow, observedVersions: { ruflo: '3.38.17', 'agentic-qe': '3.14.0' },
  });
  assert.equal(result.status, 'valid');
  assert.equal(result.registryStatus, 'valid');
  assert.equal(result.evidenceStatus, 'current');
  const publication = result.constraints.find((entry) => entry.id === 'ruflo-3.38.17-3.38.18-block');
  assert.equal(publication.issue, undefined);
  assert.match(publication.releaseUrl, /releases\/tag\/v3\.38\.19$/);
  const blocked = result.constraints.find((entry) => entry.id === 'ruflo-3.38.17-3.38.18-block');
  assert.equal(blocked.evidence.observedVersion, '3.38.17');
  assert.equal(blocked.evidence.applicability, 'affected');
  const brain = result.constraints.find((entry) => entry.dependency === 'ruvnet-brain');
  assert.equal(brain, undefined);
  // Sunset 2026-09-27: AQE 3.14.4 passed the offline Stop conformance
  // (tests/live/aqe-stop-hook-conformance.test.mjs).
  assert.equal(result.constraints.find((entry) => entry.id === 'agentic-qe-3.14.0-stop-hook-generator'), undefined);
  const guidance = result.constraints.find((entry) => entry.id === 'agentic-qe-3.14.0-codex-guidance-policy');
  assert.equal(guidance.notification.status, 'published');
  assert.match(guidance.notification.publishedUrl, /issues\/655$/);
  const rufloGuidance = result.constraints.find((entry) => entry.id === 'ruflo-3.38.20-project-guidance-selector');
  assert.equal(rufloGuidance.notification.status, 'published');
  assert.match(rufloGuidance.notification.publishedUrl, /issues\/3153#issuecomment-5512219386$/);
});

test('the #3167 init suppression applies to Ruflo below 3.46.0 only (minor.x ranges)', () => {
  const applicability = (version) => loadUpstreamConstraints({ file: registryFile, now, observedVersions: { ruflo: version } })
    .constraints.find((entry) => entry.id === 'ruflo-3.38.21-init-suppression-flags').evidence.applicability;
  for (const version of ['3.38.21', '3.39.0', '3.42.7', '3.45.0']) assert.equal(applicability(version), 'affected', version);
  for (const version of ['3.46.0', '3.46.1', '3.4.1', '3.38.20']) assert.equal(applicability(version), 'not-affected', version);
});

test('future verification dates are invalid rather than falsely current', () => {
  withDocument((document) => {
    document.lastVerifiedAt = '2099-01-01';
    document.lastCheckedAt = '2099-01-01';
    for (const constraint of document.constraints) constraint.nextRetestAt = '2099-01-02';
  }, (file) => {
    const result = loadUpstreamConstraints({ file, now });
    assert.equal(result.status, 'invalid');
    assert.match(result.errors.join('\n'), /cannot be in the future/);
  });
});

test('the registry is schema 6 and records when state was last re-read', () => {
  const document = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  assert.equal(document.schemaVersion, 6);
  assert.match(document.lastCheckedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(document.lastCheckedAt >= document.lastVerifiedAt);
  assert.equal(loadUpstreamConstraints({ now }).lastCheckedAt, document.lastCheckedAt);
});

test('a state re-read past the retest date is stale evidence, not an invalid registry', () => {
  withDocument((document) => {
    document.lastVerifiedAt = '2026-09-20';
    for (const constraint of document.constraints) constraint.nextRetestAt = '2026-09-27';
    document.lastCheckedAt = '2026-10-04';
  }, (file) => {
    const result = loadUpstreamConstraints({ file, now: () => new Date('2026-10-04T12:00:00Z') });
    assert.equal(result.registryStatus, 'valid', result.errors.join('\n'));
    assert.equal(result.evidenceStatus, 'stale');
    assert.ok(result.constraints.every((entry) => entry.evidence.status === 'stale'));
  });
});

test('a fresh state re-read keeps the registry from going stale on its own', () => {
  withDocument((document) => {
    document.lastVerifiedAt = '2026-09-01';
    for (const constraint of document.constraints) constraint.nextRetestAt = '2026-12-31';
    document.lastCheckedAt = '2026-09-27';
  }, (file) => {
    // 26 days after lastVerifiedAt but 0 after lastCheckedAt: the 14-day rule uses lastCheckedAt.
    const result = loadUpstreamConstraints({ file, now: () => new Date('2026-09-27T12:00:00Z') });
    assert.equal(result.registryStatus, 'valid', result.errors.join('\n'));
    assert.equal(result.evidenceStatus, 'current');
  });
});

test('lastCheckedAt is a date, never in the future and never before lastVerifiedAt', () => {
  for (const [value, message] of [[undefined, /lastCheckedAt must be an ISO date/], ['2099-01-01', /lastCheckedAt cannot be in the future/], ['2026-01-01', /lastCheckedAt precedes lastVerifiedAt/]]) {
    withDocument((document) => { document.lastCheckedAt = value; }, (file) => {
      const result = loadUpstreamConstraints({ file, now });
      assert.equal(result.registryStatus, 'invalid');
      assert.match(result.errors.join('\n'), message);
    });
  }
  withDocument((document) => { document.schemaVersion = 5; }, (file) => {
    assert.match(loadUpstreamConstraints({ file, now }).errors.join('\n'), /unsupported upstream constraint schema/);
  });
});
