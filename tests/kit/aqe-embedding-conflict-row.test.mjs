import test from 'node:test';
import assert from 'node:assert/strict';
import { embeddingRows } from '../../src/commands/status/sections/aqe.mjs';

// Decision 13 (2026-09-27): an AQE server entry ak preserves as a conflict is a
// hand fix. Sync never edits it, so it must never be offered as a sync repair
// (that made every `ak sync` exit 1 on such a machine).

const resolved = { mode: 'managed' };
const backend = { status: 'configured' };
const noEvidence = { evidence: null };
const projection = (findings) => {
  const ok = findings.every((f) => !['conflict', 'missing-registration'].includes(f.status));
  return { ok, changed: false, detail: ok ? 'converged' : 'AQE embedding projection conflicts or missing registrations require reconciliation', findings };
};

test('a conflict-only projection is a hand fix naming the preserved file', () => {
  const rows = embeddingRows({}, '/repo', resolved, backend,
    projection([{ file: '/repo/.mcp.json', status: 'conflict', reason: 'unrecognized Claude AQE override preserved' }]), noEvidence);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, 'warn');
  assert.equal(rows[0].repair, 'manual');
  assert.match(rows[0].fix, /\/repo\/\.mcp\.json/);
  assert.equal(rows.some((r) => r.repair === 'sync'), false, 'sync must not plan a conflict it preserves');
});

test('a missing registration stays a sync repair', () => {
  const rows = embeddingRows({}, '/repo', resolved, backend,
    projection([{ file: '/repo/.codex/config.toml', status: 'missing-registration' }]), noEvidence);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repair, 'sync');
  assert.equal(rows[0].fix, 'reconcile owned AQE embedding projections');
});

test('a conflict beside a missing registration gives one sync row and one hand-fix row', () => {
  const rows = embeddingRows({}, '/repo', resolved, backend, projection([
    { file: '/repo/.codex/config.toml', status: 'missing-registration' },
    { file: '/home/u/.claude.json', status: 'conflict', reason: 'Claude AQE override endpoint differs or is unverified; preserved' },
  ]), noEvidence);
  assert.deepEqual(rows.map((r) => r.repair).sort(), ['manual', 'sync']);
  const manual = rows.find((r) => r.repair === 'manual');
  assert.match(manual.fix, /\/home\/u\/\.claude\.json/);
  assert.doesNotMatch(manual.fix, /config\.toml/);
});

test('converged projections keep the plain info row with no fix', () => {
  const rows = embeddingRows({}, '/repo', resolved, backend,
    projection([{ file: '/repo/.mcp.json', status: 'converged' }]), noEvidence);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, 'info');
  assert.equal(rows[0].fix, null);
});
