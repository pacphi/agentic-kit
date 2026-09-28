// Suite tripwire for PROJECT-scoped leaks. HOME sandboxing cannot catch a
// command that writes relative to process.cwd(): the baseline `pnpm test` ran a
// real `sync.run` from the repository root, rewrote the real
// .claude/helpers/statusline.cjs to the fixture's `9.9.9` ruflo version, and
// stripped env keys from the real .claude/settings.local.json (leaving
// `.ak-*-backup.*` siblings behind). Two guards live here:
//   · the change detector behind isolateProject()/guardRealRepository() — each
//     isolated test file proves the guarded repository files byte-identical
//     when it ends;
//   · a census — every test file that drives a command entry point
//     (sync/setup/uninstall `.run*`) must call isolateProject(), so a new test
//     cannot quietly fall back to running against the real repository.
// tests/ui is out of scope: those suites run separately (pnpm run test:ui).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GUARDED_FILES, captureGuarded, guardedChanges,
} from './helpers/project-isolation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function fakeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-isolation-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.claude', 'helpers'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{"env":{"CLAUDE_FLOW_DB_PATH":"x"}}\n');
  fs.writeFileSync(path.join(root, '.claude', 'helpers', 'statusline.cjs'), 'let ver = "3.45.0";\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# project\n');
  return root;
}

test('the guard covers the files a leaked sync, setup or uninstall has written', () => {
  for (const rel of ['.claude/settings.local.json', '.claude/helpers/statusline.cjs', 'CLAUDE.md', 'AGENTS.md', '.mcp.json', '.codex/config.toml']) {
    assert.ok(GUARDED_FILES.includes(rel), `${rel} must be guarded`);
  }
});

test('an untouched repository reports no changes', (t) => {
  const root = fakeRepo(t);
  const before = captureGuarded(root);
  assert.deepEqual(guardedChanges(before, root), []);
});

test('a rewritten, created or removed guarded file is named', (t) => {
  const root = fakeRepo(t);
  const before = captureGuarded(root);
  fs.writeFileSync(path.join(root, '.claude', 'helpers', 'statusline.cjs'), 'let ver = "9.9.9";\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# created by a leak\n');
  fs.rmSync(path.join(root, 'CLAUDE.md'));
  const changes = guardedChanges(before, root);
  assert.deepEqual(changes.sort(), [
    '+ AGENTS.md', '- CLAUDE.md', '~ .claude/helpers/statusline.cjs',
  ].sort());
});

test('a new ak backup or temp sibling beside a guarded file is named', (t) => {
  // owned-env-projection writes `<file>.ak-<tag>-backup.<uuid>` before it edits
  // a settings file — the sibling is the leak's fingerprint even when the edit
  // itself happens to leave the content unchanged.
  const root = fakeRepo(t);
  const before = captureGuarded(root);
  const settings = path.join(root, '.claude', 'settings.local.json');
  fs.copyFileSync(settings, `${settings}.ak-memory-pin-backup.0000`);
  assert.deepEqual(guardedChanges(before, root),
    ['+ .claude/settings.local.json.ak-memory-pin-backup.0000']);
});

test('an adopted or dropped ownership receipt beside a guarded file is named', (t) => {
  // A leaked uninstall adopts the real project's legacy memory pin (writes the
  // receipt) and then releases it; a leaked teardown drops an existing receipt.
  const root = fakeRepo(t);
  const settings = path.join(root, '.claude', 'settings.local.json');
  fs.writeFileSync(`${settings}.agentic-kit-ruflo-components.json`, '{}\n');
  const before = captureGuarded(root);
  fs.writeFileSync(`${settings}.agentic-kit-memory-pin.json`, '{}\n');
  fs.rmSync(`${settings}.agentic-kit-ruflo-components.json`);
  assert.deepEqual(guardedChanges(before, root).sort(), [
    '+ .claude/settings.local.json.agentic-kit-memory-pin.json',
    '- .claude/settings.local.json.agentic-kit-ruflo-components.json',
  ]);
});

// Built from parts so this file's own source never matches the census pattern.
const ENTRY_POINT = new RegExp(`\\b(?:sync|setup|uninstall)\\.run(?:_machine|_project)?\\s*\\(`);

test('every test file that drives sync, setup or uninstall runs inside isolateProject()', () => {
  const offenders = [];
  for (const name of fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort()) {
    const code = fs.readFileSync(path.join(here, name), 'utf8')
      .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    if (ENTRY_POINT.test(code) && !code.includes('isolateProject(')) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    'these files call a command entry point that writes relative to process.cwd() without '
    + 'isolateProject() — the real repository becomes the project under test');
});
