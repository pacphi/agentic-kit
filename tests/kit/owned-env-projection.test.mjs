import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planOwnedEnv, applyOwnedEnv, jsonTopLevelEnvEditor } from '../../src/lib/owned-env-projection.mjs';

const opts = { receiptSuffix: '.test-receipt.json', format: 'multi', editorFor: (source) => jsonTopLevelEnvEditor(source) };
const want = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v === null ? { present: false } : { present: true, value: v }]));
function fixture(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-owned-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  if (content !== undefined) fs.writeFileSync(file, JSON.stringify(content));
  return { dir, file, target: { file, boundary: dir, enabled: true } };
}
const run = (target, desired) => { const plan = planOwnedEnv(target, desired, opts); if (plan.changed) applyOwnedEnv(plan, { backupTag: 'test' }); return plan; };
const env = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).env;

test('writes several keys with one receipt and converges', (t) => {
  const { file, target } = fixture(t, { env: { KEEP: 'x' }, other: 1 });
  assert.equal(run(target, want({ A: '1', B: 'minilm' })).status, 'drift');
  assert.deepEqual(env(file), { KEEP: 'x', A: '1', B: 'minilm' });
  assert.equal(planOwnedEnv(target, want({ A: '1', B: 'minilm' }), opts).changed, false);
});

test('changing one managed value leaves the others', (t) => {
  const { file, target } = fixture(t, {});
  run(target, want({ A: '1', MODE: 'balanced' }));
  run(target, want({ A: '1', MODE: 'research' }));
  assert.deepEqual(env(file), { A: '1', MODE: 'research' });
});

test('removing all managed keys restores exactly the prior document', (t) => {
  const { file, target } = fixture(t, { env: { KEEP: 'x' } });
  run(target, want({ A: '1' }));
  run(target, want({ A: null }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { env: { KEEP: 'x' } });
  assert.equal(fs.existsSync(`${file}.test-receipt.json`), false);
});

test('a foreign value for a managed key is preserved and reported', (t) => {
  const { file, target } = fixture(t, { env: { A: 'user' } });
  assert.throws(() => planOwnedEnv(target, want({ A: '1' }), opts), /A.*preserved/);
  assert.equal(env(file).A, 'user');
});

test('a user edit after ak wrote is preserved and reported', (t) => {
  const { file, target } = fixture(t, {});
  run(target, want({ A: '1' }));
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')); doc.env.A = 'mine';
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => planOwnedEnv(target, want({ A: null }), opts), /A.*user-edited/);
  assert.equal(env(file).A, 'mine');
});

test('an interrupted write blocks further changes', (t) => {
  const { file, target } = fixture(t, {});
  fs.writeFileSync(`${file}.test-receipt.json`, JSON.stringify({ version: 2, keys: {}, pending: true }));
  assert.throws(() => planOwnedEnv(target, want({ A: '1' }), opts), /interrupted/);
});

test('dry run plans without writing', (t) => {
  const { file, target } = fixture(t, {});
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(planOwnedEnv(target, want({ A: '1' }), opts).changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('symlinked config is preserved', (t) => {
  const { dir, target } = fixture(t);
  const real = path.join(dir, 'real.json'); fs.writeFileSync(real, '{}');
  fs.symlinkSync(real, target.file);
  assert.throws(() => planOwnedEnv(target, want({ A: '1' }), opts), /non-regular/);
});

// ADR-0055 v1 receipts written by the old single-key AQE engine must still be
// read and released correctly by the generalized engine's `format: { single }` mode.
test('a v1 single-key receipt written by the old AQE engine is read and released', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-owned-env-v1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ env: { AQE_EMBEDDER_ENDPOINT: 'http://localhost:11434' } }));
  fs.writeFileSync(`${file}.agentic-kit-aqe-embedding.json`, JSON.stringify({
    version: 1, before: { present: false }, after: { present: true, value: 'http://localhost:11434' }, pending: false,
  }));
  const target = { file, boundary: dir, enabled: true };
  const v1Opts = { receiptSuffix: '.agentic-kit-aqe-embedding.json', format: { single: 'AQE_EMBEDDER_ENDPOINT' },
    editorFor: (source) => jsonTopLevelEnvEditor(source) };
  const plan = planOwnedEnv(target, { AQE_EMBEDDER_ENDPOINT: { present: false } }, v1Opts);
  assert.equal(plan.status, 'drift');
  assert.equal(plan.changed, true);
  applyOwnedEnv(plan, { backupTag: 'aqe' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
  assert.equal(fs.existsSync(`${file}.agentic-kit-aqe-embedding.json`), false);
});
