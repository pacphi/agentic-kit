// The statusline template is self-contained CJS and cannot import
// src/lib/paths.mjs, so it mirrors configBase()/configDir(). If the two ever
// diverge the ledger and the quota tee are written where the dashboard never
// reads (the Windows bug this guards). Each case runs the REAL configDir() in a
// child process under a simulated platform/env and compares it with the
// template's resolver given the same platform/env/home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// A bare absolute path is not a valid ESM specifier on Windows (`D:` parses as a URL
// scheme), so the child imports paths.mjs by file:// URL.
const PATHS_URL = pathToFileURL(path.join(ROOT, 'src', 'lib', 'paths.mjs')).href;
const block = fs.readFileSync(path.join(ROOT, 'src', 'templates', 'statusline-footer.cjs'), 'utf8')
  .match(/\/\* ruflo-seg:BEGIN \*\/([\s\S]*?)\/\* ruflo-seg:END \*\//)[1];
// First-party template source, the same extraction the statusline suites use.
const templateConfigDir = new Function(`${block}\nreturn rufloKitConfigDir;`)();

function cleanEnv() {
  const out = { ...process.env };
  for (const key of Object.keys(out)) if (/^(XDG_CONFIG_HOME|APPDATA)$/i.test(key)) delete out[key];
  return out;
}

function realConfigDir(platform, env, home) {
  const script = `Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});`
    + `const {configDir}=await import(${JSON.stringify(PATHS_URL)});process.stdout.write(configDir());`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    // Inherit the runner's env (Windows needs SystemRoot etc.) minus the variables under test.
    env: { ...cleanEnv(), HOME: home, USERPROFILE: home, ...env }, encoding: 'utf8',
  });
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-parity-home-'));
const CASES = [
  ['win32 with APPDATA', 'win32', { APPDATA: '/w/AppData', XDG_CONFIG_HOME: '/x' }],
  ['win32 without APPDATA', 'win32', {}],
  ['linux with XDG_CONFIG_HOME', 'linux', { XDG_CONFIG_HOME: '/x/cfg', APPDATA: '/w/AppData' }],
  ['linux without XDG_CONFIG_HOME', 'linux', {}],
  ['darwin without XDG_CONFIG_HOME', 'darwin', { APPDATA: '/w/AppData' }],
];

for (const [name, platform, env] of CASES) {
  test(`template config dir equals paths.mjs configDir(): ${name}`, () => {
    const ctx = { path, os: { homedir: () => home }, platform, env };
    assert.equal(templateConfigDir(ctx), realConfigDir(platform, env, home));
  });
}

test('with no injected platform/env the template resolves against the running process', () => {
  const ctx = { path, os };
  const pass = {};
  for (const key of ['XDG_CONFIG_HOME', 'APPDATA']) if (process.env[key]) pass[key] = process.env[key];
  const expected = realConfigDir(process.platform, pass, os.homedir());
  assert.equal(templateConfigDir(ctx), expected);
});
