// `ak about aidefence`: with Ruflo's built-in defend engine (ruvnet/ruflo#2670,
// 3.32.2+) a missing @claude-flow/aidefence costs the adaptive learning and the
// aidefence_* MCP tools, not defend itself. The chip says exactly that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeGlobalRoot, sandboxHome, captureLog } from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-about-security');
const paths = await import('../../src/lib/paths.mjs');
const about = await import('../../src/commands/about.mjs');

function tree({ aidefence = false, builtin = false } = {}) {
  const root = fakeGlobalRoot(HOME, { ruflo: '3.46.1' });
  const cf = path.join(root, 'ruflo', 'node_modules', '@claude-flow');
  const pkg = (name) => {
    fs.mkdirSync(path.join(cf, name), { recursive: true });
    fs.writeFileSync(path.join(cf, name, 'package.json'), JSON.stringify({ name: `@claude-flow/${name}` }));
  };
  pkg('security');
  if (aidefence) pkg('aidefence');
  if (builtin) {
    const dir = path.join(cf, 'cli', 'dist', 'src', 'security');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'builtin-aidefence.js'), 'export {};\n');
  }
  paths._setGlobalRootForTest(root);
}

async function securityState() {
  const { result, out } = await captureLog(() => about.run({ flags: { json: true }, positionals: ['aidefence'] }));
  assert.equal(result, 0, out);
  return JSON.parse(out).entries[0].state;
}

test('aidefence missing with the built-in engine: attention naming what is actually lost', async () => {
  tree({ aidefence: false, builtin: true });
  const state = await securityState();
  assert.equal(state.state, 'attention');
  assert.equal(state.note, 'aidefence missing: defend uses the built-in engine; aidefence_* MCP tools unavailable');
});

test('aidefence missing without the built-in engine keeps the older note', async () => {
  tree({ aidefence: false, builtin: false });
  const state = await securityState();
  assert.equal(state.state, 'attention');
  assert.equal(state.note, '@claude-flow/security present, aidefence missing');
});

test('both present: installed', async () => {
  tree({ aidefence: true, builtin: true });
  assert.equal((await securityState()).state, 'installed');
});
