import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyWorkingContext } from '../../src/lib/footprint/working-context.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-working-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a repository subdirectory resolves to the repository context', (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'agentic-kit');
  const child = path.join(repo, 'src', 'lib');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });

  const context = classifyWorkingContext(child, { homeDir: root, stateRoots: [] });
  assert.equal(context.kind, 'repository');
  assert.equal(context.label, 'agentic-kit');
  assert.match(context.projectKey, /^project:[a-f0-9]{16}$/);
});

test('host state, home, root and an ordinary folder remain distinct contexts', (t) => {
  const homeDir = fixture(t);
  const state = path.join(homeDir, '.codex');
  const folder = path.join(homeDir, 'Documents', 'notes');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(folder, { recursive: true });
  const options = {
    homeDir,
    stateRoots: [{ root: state, kind: 'host-state', label: 'Codex state directory' }],
  };

  assert.equal(classifyWorkingContext(state, options).label, 'Codex state directory');
  assert.equal(classifyWorkingContext(homeDir, options).kind, 'user-home');
  assert.equal(classifyWorkingContext(path.parse(homeDir).root, options).kind, 'system-root');
  assert.deepEqual(
    Object.fromEntries(Object.entries(classifyWorkingContext(folder, options))
      .filter(([key]) => key !== 'path')),
    { kind: 'directory', label: 'Folder · notes' },
  );
});

test('Windows state and drive roots classify by Windows path rules off Windows', () => {
  const options = {
    pathImpl: path.win32,
    homeDir: 'C:\\Users\\me',
    stateRoots: [{ root: 'C:\\Users\\me\\.codex', kind: 'host-state', label: 'Codex state directory' }],
    resolveIdentity: () => ({ canonical: false }),
  };
  assert.equal(classifyWorkingContext('C:\\Users\\me\\.codex\\plugins', options).kind, 'host-state');
  assert.equal(classifyWorkingContext('C:\\', options).kind, 'system-root');
  assert.equal(classifyWorkingContext('C:\\work\\scratch', options).label, 'Folder · scratch');
});
