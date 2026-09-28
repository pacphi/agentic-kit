import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aqeInitArguments, aqeInitReport, AQE_CODEX_SKILLS } from '../../src/lib/aqe-guidance.mjs';
import { tempDir } from './helpers/temp-dir.mjs';
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

// setup.mjs said "agentic-qe initialized (+ codex skills)" whenever --with-codex was
// passed; AQE 3.14.4 run as `aqe` installs no Codex hooks or skills (its installer
// resolves its package root only from `node dist/cli/bundle.js`), so say what is there.
function codexProject(t, { hooks = false, skills = [] } = {}) {
  const root = tempDir('ak-aqe-codex-report', t);
  if (hooks) {
    fs.mkdirSync(path.join(root, '.codex', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'node .codex/hooks/aqe-codex-hook.cjs stop' }] }] } }));
  }
  for (const name of skills) fs.mkdirSync(path.join(root, '.agents', 'skills', name), { recursive: true });
  return root;
}

test('aqe init report: Codex hooks and skills are named only when they are there', (t) => {
  const full = aqeInitReport({ code: 0, withCodex: true, root: codexProject(t, { hooks: true, skills: AQE_CODEX_SKILLS }), version: '3.14.4' });
  assert.equal(full.level, 'ok');
  assert.match(full.text, /agentic-qe initialized \(\+ Codex hooks and 5 skills\)/);
  const none = aqeInitReport({ code: 0, withCodex: true, root: codexProject(t), version: '3.14.4' });
  assert.equal(none.level, 'warn');
  assert.doesNotMatch(none.text, /\+ codex skills/i);
  assert.match(none.text, /AQE 3\.14\.4 did not install its Codex hooks or skills/);
  assert.match(none.text, /aqe-plan-quality/);
  assert.match(none.text, /upstream/);
  const some = aqeInitReport({ code: 0, withCodex: true, root: codexProject(t, { hooks: true, skills: ['aqe-research'] }), version: '3.14.4' });
  assert.equal(some.level, 'warn');
  assert.match(some.text, /missing: aqe-plan-quality, aqe-plan-work, aqe-review-quality, aqe-test-change/);
  assert.deepEqual(aqeInitReport({ code: 0, withCodex: false, root: codexProject(t), version: '3.14.4' }), { level: 'ok', text: 'agentic-qe initialized' });
  assert.equal(aqeInitReport({ code: 1, withCodex: false, root: codexProject(t), version: '3.14.4' }).level, 'warn');
});
