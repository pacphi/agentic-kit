import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planOwnedEnv, applyOwnedEnv, jsonTopLevelEnvEditor, pendingReceiptKeys } from '../../src/lib/owned-env-projection.mjs';

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
  const plan = planOwnedEnv(target, want({ A: '1' }), opts);
  assert.equal(plan.keys.A, 'foreign');
  assert.deepEqual(plan.conflicts, [{ key: 'A', reason: 'A: conflicting unmanaged value preserved' }]);
  assert.equal(plan.changed, false);
  assert.equal(env(file).A, 'user');
});

// ADR-0058 §3 "conflicts preserved rather than overwritten" — one user-set key must not
// abandon the whole file: the other managed keys are still written.
test('one foreign key is skipped while the other managed keys are written', (t) => {
  const { file, target } = fixture(t, { env: { A: '0' } });
  const plan = run(target, want({ A: '1', B: 'minilm', C: 'balanced' }));
  assert.deepEqual(plan.keys, { A: 'foreign', B: 'write', C: 'write' });
  assert.deepEqual(env(file), { A: '0', B: 'minilm', C: 'balanced' });
  const receipt = JSON.parse(fs.readFileSync(`${file}.test-receipt.json`, 'utf8'));
  assert.deepEqual(Object.keys(receipt.keys).sort(), ['B', 'C'], 'the foreign key is never adopted');
  assert.equal(planOwnedEnv(target, want({ A: '1', B: 'minilm', C: 'balanced' }), opts).changed, false);
});

test('a user edit after ak wrote is preserved and reported, and its receipt entry retained', (t) => {
  const { file, target } = fixture(t, {});
  run(target, want({ A: '1', B: 'x' }));
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')); doc.env.A = 'mine';
  fs.writeFileSync(file, JSON.stringify(doc));
  const plan = run(target, want({ A: null, B: null }));
  assert.equal(plan.keys.A, 'user-edited');
  assert.equal(plan.keys.B, 'release');
  assert.deepEqual(env(file), { A: 'mine' });
  const receipt = JSON.parse(fs.readFileSync(`${file}.test-receipt.json`, 'utf8'));
  assert.deepEqual(Object.keys(receipt.keys), ['A'], 'the edited key stays receipted; the released one is dropped');
});

test('a managed value the user deleted is restored as drift', (t) => {
  const { file, target } = fixture(t, {});
  run(target, want({ A: '1' }));
  fs.writeFileSync(file, JSON.stringify({ env: {} }));
  const plan = planOwnedEnv(target, want({ A: '1' }), opts);
  assert.equal(plan.keys.A, 'restore');
  assert.equal(plan.changed, true);
  applyOwnedEnv(plan, { backupTag: 'test' });
  assert.deepEqual(env(file), { A: '1' });
});

test('a file-level error still refuses the whole file', (t) => {
  const { file, target } = fixture(t);
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => planOwnedEnv(target, want({ A: '1' }), opts), /invalid JSON/);
});

test('the single-key format still refuses on a conflicting value (AQE unchanged)', (t) => {
  const { target } = fixture(t, { env: { A: 'user' } });
  assert.throws(() => planOwnedEnv(target, want({ A: '1' }), { ...opts, format: { single: 'A' } }), /A: conflicting unmanaged value preserved/);
});

// Deferred (a): a mixed add+remove plan must mark BOTH the kept keys and the key being
// released as in flight, or an interruption loses the released key's `before`.
test('the pending marker of a mixed add+remove plan keeps the released key', (t) => {
  const { target } = fixture(t, {});
  run(target, want({ A: '1', MODE: 'balanced' }));
  const plan = planOwnedEnv(target, want({ A: '1', MODE: null }), opts);
  assert.equal(plan.keys.MODE, 'release');
  assert.deepEqual(Object.keys(pendingReceiptKeys(plan)).sort(), ['A', 'MODE']);
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
