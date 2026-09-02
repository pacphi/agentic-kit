import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSandboxed, captureLog, offlineKitConfig, rmrf, sandboxHome,
  sandboxProject, snapshot, assertUnchanged, writeKitConfig,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-reference');
const paths = await import('../../src/lib/paths.mjs');
const reference = await import('../../src/commands/x/reference.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('x reference uses target-aware config and converges every host idempotently', async () => {
  const project = sandboxProject('ak-reference');
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.mkdirSync(paths.codexDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# Claude user notes\n');
  fs.writeFileSync(paths.codexAgentsMdPath(), '# Codex user notes\n');
  writeKitConfig(HOME, offlineKitConfig({
    aqe: false,
    integrations: { hosts: { claude: true, codex: true, opencode: false } },
  }));

  const previous = process.cwd();
  process.chdir(project);
  try {
    const before = snapshot(HOME);
    const preview = await captureLog(() => reference.run({
      flags: { json: true }, positionals: ['diff'], pkgRoot: PKG_ROOT,
    }));
    const plan = JSON.parse(preview.out);
    assert.deepEqual(plan.map((entry) => entry.name), ['claude', 'agents', 'agents-user']);
    assertUnchanged(before, HOME, 'reference diff must remain read-only');

    await captureLog(() => reference.run({
      flags: { json: false }, positionals: ['sync'], pkgRoot: PKG_ROOT,
    }));
    const claude = fs.readFileSync(paths.claudeMdPath(), 'utf8');
    const codex = fs.readFileSync(paths.codexAgentsMdPath(), 'utf8');
    assert.match(claude, /Claude user notes/);
    assert.match(codex, /Codex user notes/);
    assert.match(claude, /BEGIN ruflo-dual-mode-reference/);
    assert.match(codex, /BEGIN ruflo-dual-mode-reference/);
    assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), false,
      'machine dual-host state never creates a repository AGENTS.md');

    const afterFirst = snapshot(HOME);
    const repeated = await captureLog(() => reference.run({
      flags: { json: true }, positionals: ['sync'], pkgRoot: PKG_ROOT,
    }));
    assert.ok(JSON.parse(repeated.out).every((entry) => entry.changed === ''));
    assertUnchanged(afterFirst, HOME, 'second reference sync must be byte-idempotent');
  } finally {
    process.chdir(previous);
    rmrf(project);
  }
});

test.after(() => rmrf(HOME));
