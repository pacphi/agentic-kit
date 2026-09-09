import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aqeInitArguments } from '../../src/lib/aqe-guidance.mjs';
import { loadKitConfig, saveKitConfig, KitConfigError } from '../../src/lib/config.mjs';

const codex = { integrations: { hosts: { codex: true } } };

test('AQE 3.14.1 defaults to compact Codex guidance through the public initializer', () => {
  assert.deepEqual(aqeInitArguments(codex, '3.14.1'), ['init', '--auto', '--with-codex', '--codex-guidance', 'compact']);
});

test('explicit full and none preferences are passed unchanged on supported versions', () => {
  for (const mode of ['full', 'none']) {
    assert.deepEqual(aqeInitArguments({ ...codex, aqeCodexGuidance: mode }, '3.15.0'),
      ['init', '--auto', '--with-codex', '--codex-guidance', mode]);
  }
});

test('older and prerelease AQE retain supported arguments without the new option', () => {
  for (const version of ['3.13.1', '3.14.0', '3.14.0+build.7', '3.14.1-beta.1']) {
    assert.deepEqual(aqeInitArguments(codex, version), ['init', '--auto', '--with-codex']);
  }
  for (const version of ['3.13.0', '3.13.0+build.7', null, undefined, 'unknown', '3.14']) {
    assert.deepEqual(aqeInitArguments(codex, version), ['init', '--auto']);
  }
});

test('Claude-only setups do not receive Codex flags even with an explicit preference', () => {
  assert.deepEqual(aqeInitArguments({ aqeCodexGuidance: 'none' }, '3.14.1'), ['init', '--auto']);
  assert.deepEqual(aqeInitArguments({ integrations: { hosts: { codex: false } } }, '3.14.1'), ['init', '--auto']);
});

test('invalid policies fail at command and persisted config boundaries', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-guidance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'kit.json');
  for (const mode of ['', 'COMPACT', '--auto', null, 0, {}]) {
    assert.throws(() => aqeInitArguments({ ...codex, aqeCodexGuidance: mode }, '3.14.1'), /aqeCodexGuidance/);
    fs.writeFileSync(file, JSON.stringify({ aqeCodexGuidance: mode }));
    assert.throws(() => loadKitConfig(file), KitConfigError);
    assert.throws(() => saveKitConfig({ aqeCodexGuidance: mode }, file), /aqeCodexGuidance/);
  }
});

test('default and explicit policies persist idempotently without losing user preferences', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-guidance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'kit.json');
  assert.equal(loadKitConfig(file).aqeCodexGuidance, 'compact');
  for (const mode of ['compact', 'full', 'none']) {
    fs.writeFileSync(file, JSON.stringify({ aqeCodexGuidance: mode, aqe: true }));
    const cfg = loadKitConfig(file);
    saveKitConfig(cfg, file);
    const first = fs.readFileSync(file, 'utf8');
    const reloaded = loadKitConfig(file);
    saveKitConfig(reloaded, file);
    assert.equal(reloaded.aqeCodexGuidance, mode);
    assert.equal(fs.readFileSync(file, 'utf8'), first);
  }
});
