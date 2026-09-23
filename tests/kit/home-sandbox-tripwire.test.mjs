// Tripwire for the home sandbox itself: a developer shell that exports XDG_* (or
// CLAUDE_CONFIG_DIR / CODEX_HOME) to REAL directories must not leak through
// sandboxHome(). An earlier run wrote the real ~/.local/state evidence cache this way.
// Each case runs in a child process so paths.mjs is loaded fresh under the hostile env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = pathToFileURL(path.join(here, 'helpers', 'home-sandbox.mjs')).href;
const pathsModule = pathToFileURL(path.join(here, '..', '..', 'src', 'lib', 'paths.mjs')).href;
const applyModule = pathToFileURL(path.join(here, '..', '..', 'src', 'lib', 'ruflo-components', 'apply.mjs')).href;

function runChild(t, body) {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-sandbox-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const hostile = {};
  for (const key of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'LOCALAPPDATA',
    'APPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME']) hostile[key] = path.join(outside, key);
  const script = `
    const { default: fs } = await import('node:fs');
    const { sandboxHome, assertSandboxed } = await import(${JSON.stringify(helper)});
    const home = sandboxHome('ak-tripwire');
    const paths = await import(${JSON.stringify(pathsModule)});
    const apply = await import(${JSON.stringify(applyModule)});
    ${body}
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...hostile }, encoding: 'utf8',
  });
  return { ...r, outside };
}

test('sandboxHome overrides every exported home-relative location, including the state base', (t) => {
  const r = runChild(t, `
    assertSandboxed(paths, home);
    const resolved = {
      configDir: paths.configDir(), claudeDir: paths.claudeDir(), codexDir: paths.codexDir(),
      hermesDir: paths.hermesDir(), maintenanceControlDir: paths.maintenanceControlDir(),
      hookHealingTransactionsDir: paths.hookHealingTransactionsDir(),
      evidence: apply.rufloComponentsEvidenceFile(),
      xdgData: process.env.XDG_DATA_HOME, xdgCache: process.env.XDG_CACHE_HOME,
    };
    const escaped = Object.entries(resolved).filter(([, p]) => !p || !p.startsWith(home));
    if (escaped.length) { console.error(JSON.stringify(escaped)); process.exit(3); }
    fs.rmSync(home, { recursive: true, force: true });
  `);
  assert.equal(r.status, 0, `sandbox leaked a path outside its home:\n${r.stderr}${r.stdout}`);
  assert.equal(r.stdout.includes(r.outside), false);
});

test('assertSandboxed refuses to run when the state base escapes the sandbox', (t) => {
  const r = runChild(t, `
    for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME']) delete process.env[key];
    process.env.XDG_STATE_HOME = ${JSON.stringify(path.join(os.tmpdir(), 'ak-not-the-sandbox'))};
    process.env.LOCALAPPDATA = process.env.XDG_STATE_HOME;
    let threw = false;
    try { assertSandboxed(paths, home); } catch { threw = true; }
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(threw ? 0 : 4);
  `);
  assert.equal(r.status, 0, `assertSandboxed accepted an escaped state base:\n${r.stderr}`);
});
