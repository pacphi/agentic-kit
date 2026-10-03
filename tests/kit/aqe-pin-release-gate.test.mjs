// ADR-0062 §1 (retired for agentic-qe >= 3.14.5, agentic-qe#735): ak stops writing the AQE
// project pin, but releases one it wrote earlier only when that is safe. Released AQE resolves
// its root from a subfolder, yet the nearest `.agentic-qe` still wins (AQE 3.10.4's rule), so a stray
// store below the root would be adopted once the pin (AQE_PROJECT_ROOT) is gone; older AQE never
// had the fix. Every test runs in its own temporary project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import {
  reconcileAqePin, aqePinReleaseGate, retireAqePin, aqePinReceiptPresent, AQE_PIN_FIX_VERSION,
} from '../../src/lib/aqe-project-pin.mjs';
import memoryPin from '../../src/commands/status/sections/memory-pin.mjs';

const clean = () => ({ strays: [], complete: true });
const withStray = () => ({
  strays: [{ kind: 'aqe', path: 'pkg/sub/.agentic-qe' }, { kind: 'ruflo', path: 'other/.swarm/memory.db' }],
  complete: true,
});

/** A project whose pin an older ak wrote: settings.local.json carries it, under a receipt. */
function pinned(t) {
  const root = tempDir('ak-aqe-pin-gate', t);
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.agentic-qe'));
  const settings = path.join(root, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, `${JSON.stringify({ env: { KEEP: 'x' } }, null, 2)}\n`);
  const cfg = { aqe: true, integrations: { hosts: { claude: true, codex: false } } };
  assert.equal(reconcileAqePin(cfg, root).ok, true);
  assert.equal(aqePinReceiptPresent(root), true);
  const env = () => JSON.parse(fs.readFileSync(settings, 'utf8')).env;
  return { root, cfg, settings, env };
}

test('the fix version is the first AQE release that resolves the root from a subfolder', () => {
  assert.equal(AQE_PIN_FIX_VERSION, '3.14.5');
});

test('a receipted pin can be released on the fix version with no stray store', (t) => {
  const { root } = pinned(t);
  for (const version of ['3.14.5', '3.14.7', '3.15.0']) {
    const gate = aqePinReleaseGate(root, { version, find: clean });
    assert.equal(gate.release, true, version);
    assert.equal(gate.reason, undefined);
  }
});

test('an older AQE keeps the pin, and the reason names both versions', (t) => {
  const { root } = pinned(t);
  const gate = aqePinReleaseGate(root, { version: '3.14.4', find: clean });
  assert.equal(gate.release, false);
  assert.equal(gate.reason, 'version-old');
  assert.match(gate.detail, /3\.14\.4/);
  assert.match(gate.detail, /3\.14\.5/);
});

test('an unknown AQE version keeps the pin', (t) => {
  const { root } = pinned(t);
  const gate = aqePinReleaseGate(root, { version: null, find: clean });
  assert.deepEqual([gate.release, gate.reason], [false, 'version-unknown']);
});

test('a stray AQE store below the root keeps the pin; other stray kinds do not count', (t) => {
  const { root } = pinned(t);
  const gate = aqePinReleaseGate(root, { version: '3.14.7', find: withStray });
  assert.equal(gate.release, false);
  assert.equal(gate.reason, 'strays');
  assert.deepEqual(gate.strays, ['pkg/sub/.agentic-qe']);
  const rufloOnly = () => ({ strays: [{ kind: 'ruflo', path: 'x/.swarm/memory.db' }], complete: true });
  assert.equal(aqePinReleaseGate(root, { version: '3.14.7', find: rufloOnly }).release, true);
});

test('an incomplete stray scan keeps the pin: an unscanned folder could hold a stray', (t) => {
  const { root } = pinned(t);
  const gate = aqePinReleaseGate(root, { version: '3.14.7', find: () => ({ strays: [], complete: false }) });
  assert.deepEqual([gate.release, gate.reason], [false, 'scan-incomplete']);
});

test('with no receipt there is nothing to hold, and nothing is scanned', (t) => {
  const root = tempDir('ak-aqe-pin-gate-none', t);
  fs.mkdirSync(path.join(root, '.git'));
  const find = () => { throw new Error('scanned a project that holds no pin'); };
  assert.equal(aqePinReleaseGate(root, { version: null, find }).release, true);
});

test('retireAqePin releases the legacy pin when the gate allows it', (t) => {
  const { root, cfg, env } = pinned(t);
  assert.ok(env().AQE_PROJECT_ROOT);
  const result = retireAqePin(cfg, root, { version: '3.14.7', find: clean });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.held, false);
  assert.deepEqual(env(), { KEEP: 'x' });
  assert.equal(aqePinReceiptPresent(root), false);
});

test('retireAqePin keeps the pin converged while the gate holds it', (t) => {
  const { root, cfg, settings, env } = pinned(t);
  const edited = JSON.parse(fs.readFileSync(settings, 'utf8'));
  edited.env.AQE_MEMORY_PATH = '.agentic-qe/memory.db';
  fs.writeFileSync(settings, `${JSON.stringify(edited, null, 2)}\n`);
  const result = retireAqePin(cfg, root, { version: '3.14.4', find: clean });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.held, true);
  assert.equal(result.gate.reason, 'version-old');
  assert.equal(env().AQE_PROJECT_ROOT, fs.realpathSync(root));
  assert.equal(env().AQE_MEMORY_PATH, path.join(fs.realpathSync(root), '.agentic-qe', 'memory.db'));
  assert.equal(aqePinReceiptPresent(root), true);
});

test('retireAqePin never writes a new pin in a project that was not pinned', (t) => {
  const root = tempDir('ak-aqe-pin-gate-fresh', t);
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.agentic-qe'));
  const cfg = { aqe: true, integrations: { hosts: { claude: true, codex: false } } };
  const result = retireAqePin(cfg, root, { version: '3.14.4', find: withStray });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, false);
  assert.equal(aqePinReceiptPresent(root), false);
  assert.equal(fs.existsSync(path.join(root, '.claude', 'settings.local.json')), false);
});

test('status gives one aqe-pin row saying why the pin is kept, and none once it can be released', async (t) => {
  const { root, cfg } = pinned(t);
  const rowsFor = async (aqePin) => (await memoryPin.collect({ cwd: root, cfg, aqePin }))
    .filter((r) => r.subsystem === 'aqe-pin');

  const old = await rowsFor({ version: '3.14.4', find: clean });
  assert.equal(old.length, 1, JSON.stringify(old));
  assert.equal(old[0].level, 'warn');
  assert.match(old[0].message, /3\.14\.4/);
  assert.match(old[0].fix, /agentic-qe/);
  assert.equal(old[0].repair, 'manual');

  const strays = await rowsFor({ version: '3.14.7', find: withStray });
  assert.equal(strays.length, 1, JSON.stringify(strays));
  assert.match(strays[0].message, /pkg\/sub\/\.agentic-qe/);
  assert.match(strays[0].fix, /aqe-store merge/);

  assert.deepEqual(await rowsFor({ version: '3.14.7', find: clean }), []);
});

test('status says nothing about the pin in a project that holds none', async (t) => {
  const root = tempDir('ak-aqe-pin-gate-quiet', t);
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.agentic-qe'));
  const rows = await memoryPin.collect({ cwd: root, cfg: { aqe: true }, aqePin: { version: '3.14.4', find: withStray } });
  assert.deepEqual(rows.filter((r) => r.subsystem === 'aqe-pin'), []);
});
