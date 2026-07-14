import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonWithBackup, addDenyRules, removeDenyRules } from '../../src/lib/settings.mjs';
import { loadKitConfig, saveKitConfig } from '../../src/lib/config.mjs';

const tmpFile = (dir, name) => path.join(dir, name);

test('writeJsonWithBackup writes a one-time .bak and never overwrites it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-set-'));
  const f = tmpFile(tmp, 'settings.json');
  fs.writeFileSync(f, '{"original":true}\n');
  writeJsonWithBackup(f, { v: 1 });
  writeJsonWithBackup(f, { v: 2 });
  assert.deepEqual(readJson(f), { v: 2 });
  assert.deepEqual(readJson(`${f}.bak`), { original: true }, 'backup preserves FIRST pre-run state');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('addDenyRules dedupes, sorts, and reports only net-new rules', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-deny-'));
  const f = tmpFile(tmp, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ permissions: { deny: ['b'] } }));
  const added = addDenyRules(f, ['a', 'b', 'c']);
  assert.equal(added, 2);
  assert.deepEqual(readJson(f).permissions.deny, ['a', 'b', 'c']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('removeDenyRules removes by predicate and leaves others', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-deny2-'));
  const f = tmpFile(tmp, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ permissions: { deny: ['mcp__claude-flow__x', 'Read(./.env)'] } }));
  const removed = removeDenyRules(f, (r) => r.startsWith('mcp__claude-flow__'));
  assert.equal(removed, 1);
  assert.deepEqual(readJson(f).permissions.deny, ['Read(./.env)']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('loadKitConfig returns defaults when file missing and round-trips saves', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-cfg-'));
  const f = tmpFile(tmp, 'kit.json');
  const cfg = loadKitConfig(f);
  assert.equal(cfg.aqe, true);
  assert.equal(cfg.mcp.register, true);
  cfg.mcp.excludeFamilies = ['wasm'];
  cfg.customBlocks.push({ slug: 's', templatePath: '/t.md', detector: { type: 'always' } });
  saveKitConfig(cfg, f);
  const back = loadKitConfig(f);
  assert.deepEqual(back.mcp.excludeFamilies, ['wasm']);
  assert.equal(back.customBlocks.length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('loadKitConfig merges partial files over defaults (user file wins)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-cfg2-'));
  const f = tmpFile(tmp, 'kit.json');
  fs.writeFileSync(f, JSON.stringify({ security: false, mcp: { excludeFamilies: ['browser'] } }));
  const cfg = loadKitConfig(f);
  assert.equal(cfg.security, false);
  assert.equal(cfg.mcp.register, true, 'unspecified nested key keeps default');
  assert.deepEqual(cfg.mcp.excludeFamilies, ['browser']);
  fs.rmSync(tmp, { recursive: true, force: true });
});
