// The `security` status row. Since Ruflo 3.32.2 (ruvnet/ruflo#2670) `security
// defend` falls back to a built-in engine when @claude-flow/aidefence is missing,
// so a missing aidefence is no longer "defend silently non-functional": only the
// adaptive learning and the aidefence_* MCP tools are lost. The row must say so,
// and keep the sync repair (healAidefence) that restores those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeGlobalRoot, sandboxHome } from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-security-status');
const paths = await import('../../src/lib/paths.mjs');
const { default: security } = await import('../../src/commands/status/sections/security.mjs');
const { rufloBuiltinDefence } = await import('../../src/lib/natives.mjs');

function rufloTree({ security: sec = true, aidefence = false, builtin = false } = {}) {
  const root = fakeGlobalRoot(HOME, { ruflo: '3.46.1' });
  const cf = path.join(root, 'ruflo', 'node_modules', '@claude-flow');
  const pkg = (name) => {
    fs.mkdirSync(path.join(cf, name), { recursive: true });
    fs.writeFileSync(path.join(cf, name, 'package.json'), JSON.stringify({ name: `@claude-flow/${name}` }));
  };
  if (sec) pkg('security');
  if (aidefence) pkg('aidefence');
  if (builtin) {
    const dir = path.join(cf, 'cli', 'dist', 'src', 'security');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'builtin-aidefence.js'), 'export {};\n');
  }
  paths._setGlobalRootForTest(root);
  return root;
}

test('rufloBuiltinDefence is true only when the CLI ships security/builtin-aidefence.js', () => {
  rufloTree({ builtin: false });
  assert.equal(rufloBuiltinDefence(), false);
  rufloTree({ builtin: true });
  assert.equal(rufloBuiltinDefence(), true);
});

test('aidefence missing with the built-in engine: a warning with a sync repair, not a failure', async () => {
  rufloTree({ aidefence: false, builtin: true });
  const [r] = await security.collect({ cfg: {} });
  assert.equal(r.level, 'warn');
  assert.equal(r.message,
    "security defend uses Ruflo's built-in engine; @claude-flow/aidefence (adaptive learning and the aidefence_* MCP tools) is missing");
  assert.equal(r.fix, 'sync reinstalls @claude-flow/aidefence');
  assert.equal(r.repair, 'sync');
  assert.doesNotMatch(r.message, /non-functional/);
});

test('aidefence missing and no built-in engine (older Ruflo): the failure stays', async () => {
  rufloTree({ aidefence: false, builtin: false });
  const [r] = await security.collect({ cfg: {} });
  assert.equal(r.level, 'fail');
  assert.match(r.message, /non-functional \(ruvnet\/ruflo#2670\)/);
  assert.equal(r.repair, 'sync');
});

test('aidefence present: ok', async () => {
  rufloTree({ aidefence: true, builtin: true });
  const [r] = await security.collect({ cfg: {} });
  assert.equal(r.level, 'ok');
});
