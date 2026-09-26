// Project readiness hints (#237 setup item 1, audit N3). Plain `ak setup`
// configures project scope only in a directory that itself holds `.git` (and
// is not HOME); anywhere else it configures the machine only. The memory and
// learning rows must therefore name the command that actually initializes
// the folder — `ak setup --project` — instead of "run setup here".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sandboxHome, assertSandboxed, rmrf, sandboxProject, writeKitConfig, offlineKitConfig,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-setup-hints');
const paths = await import('../../src/lib/paths.mjs');
const scope = await import('../../src/lib/setup-scope.mjs');
const memorySection = (await import('../../src/commands/status/sections/project-memory.mjs')).default;
const learningSection = (await import('../../src/commands/status/sections/learning.mjs')).default;
assertSandboxed(paths, HOME);
writeKitConfig(HOME, offlineKitConfig());

const REPO = sandboxProject('ak-setup-hints');
const BARE = fs.realpathSync(fs.mkdtempSync(path.join(HOME, 'bare-')));
const NESTED = path.join(REPO, 'packages', 'app');
fs.mkdirSync(NESTED, { recursive: true });

const hints = async (cwd) => ({
  memory: (await memorySection.collect({ cwd })).map((r) => r.message).join('\n'),
  learning: (await learningSection.collect({ cwd })).map((r) => r.message).join('\n'),
});

test('plain setup selects project scope only in a .git directory that is not HOME', () => {
  assert.equal(scope.setupSelectsProject(REPO), true);
  assert.equal(scope.setupSelectsProject(BARE), false);
  assert.equal(scope.setupSelectsProject(NESTED), false, 'setup checks the directory itself, not its parents');
  fs.mkdirSync(path.join(HOME, '.git'));
  try { assert.equal(scope.setupSelectsProject(paths.home), false, 'a dotfiles repo in HOME is not a project'); }
  finally { rmrf(path.join(HOME, '.git')); }
});

test('a repository root keeps the plain setup hint', async () => {
  const { memory, learning } = await hints(REPO);
  assert.equal(memory, 'no project memory store yet (run setup here to initialize)');
  assert.equal(learning, 'no learning state in this project (run setup here to activate)');
});

test('a folder outside any repository points at ak setup --project', async () => {
  const { memory, learning } = await hints(BARE);
  for (const message of [memory, learning]) {
    assert.match(message, /plain `ak setup` here configures the machine only/);
    assert.match(message, /`ak setup --project`/);
    assert.doesNotMatch(message, /run setup here/);
  }
});

test('a subfolder of a repository names the repository root and --project', async () => {
  const { memory } = await hints(NESTED);
  assert.match(memory, /repository root/);
  assert.match(memory, /`ak setup --project`/);
});

test.after(() => rmrf(HOME, REPO));
