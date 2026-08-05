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

// code-quality Finding 3: the previous implementation was truncate-then-write
// (fs.writeFileSync opens O_TRUNC before writing), so an interrupt landing
// mid-write (Ctrl-C, OOM kill) could leave `file` zero-length or partial —
// on ~/.claude/settings.json specifically, that is the file Claude Code
// reads on every startup. write-tmp-then-rename makes the swap atomic: a
// reader always sees either the whole old file or the whole new one.
test('writeJsonWithBackup leaves no temp file behind after a successful write', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-set-atomic-'));
  const f = tmpFile(tmp, 'settings.json');
  writeJsonWithBackup(f, { v: 1 });
  const leftover = fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftover, [], `no .pid.tmp file should survive a successful write, found: ${leftover}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a failure while serializing never touches the existing file (atomic swap, not in-place truncate)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-set-atomic-fail-'));
  const f = tmpFile(tmp, 'settings.json');
  fs.writeFileSync(f, '{"safe":true}\n');
  const circular = {};
  circular.self = circular; // JSON.stringify throws on this — write must never reach fs.renameSync
  assert.throws(() => writeJsonWithBackup(f, circular), /circular/i);
  assert.deepEqual(readJson(f), { safe: true }, 'the original file must survive a failed write untouched');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('an unusable backup path fails closed before settings are replaced', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-set-bak-fail-'));
  const f = tmpFile(tmp, 'settings.json');
  fs.writeFileSync(f, '{"safe":true}\n');
  fs.mkdirSync(`${f}.bak`);

  assert.throws(() => writeJsonWithBackup(f, { safe: false }), /unusable backup path/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"safe":true}\n');
  assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.endsWith('.tmp')), []);
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
