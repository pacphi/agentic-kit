// tests/kit/ui-chrome-launch.test.mjs
// System Chrome leaves com.google.Chrome.chrome_chrome_url_fetcher_.* folders in
// its temp dir; on Linux that is the runner's suite temp root, whose leftover
// check then fails the UI run. tests/ui/helpers/launch-chrome.mjs gives each
// browser its own temp folder and removes it on close; this keeps every UI test
// on that path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const HELPER = path.join(UI, 'helpers', 'launch-chrome.mjs');

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files(full, out); else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

test('every UI test launches Chrome through launchChrome()', () => {
  const offenders = [];
  for (const file of files(UI)) {
    if (file === HELPER) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/\bchromium\s*\.\s*launch\w*\s*\(/.test(line)) offenders.push(`${path.relative(UI, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `use launchChrome() from tests/ui/helpers/launch-chrome.mjs:\n  ${offenders.join('\n  ')}`);
});

test('launchChrome gives Chrome its own temp folder and removes it, fetcher leftovers included, on close', async (t) => {
  const { chromium } = await import('playwright');
  const { launchChrome } = await import('../ui/helpers/launch-chrome.mjs');
  let seen;
  let closed = 0;
  t.mock.method(chromium, 'launch', async (options) => { seen = options; return { close: async () => { closed += 1; } }; });
  const browser = await launchChrome({ headless: false });
  assert.equal(seen.channel, 'chrome');
  assert.equal(seen.headless, false, 'caller options win');
  const dir = seen.env.TMPDIR;
  for (const key of ['TEMP', 'TMP', 'MAC_CHROMIUM_TMPDIR']) assert.equal(seen.env[key], dir, key);
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p); // drive-letter case varies on Windows
  assert.equal(fold(path.dirname(dir)), fold(fs.realpathSync(os.tmpdir())));
  assert.ok(Object.keys(seen.env).some((k) => k.toUpperCase() === 'PATH'), 'the browser keeps its search path');
  fs.mkdirSync(path.join(dir, 'com.google.Chrome.chrome_chrome_url_fetcher_.AbC123'));
  await browser.close();
  assert.equal(closed, 1);
  assert.equal(fs.existsSync(dir), false, `${dir} survived browser.close()`);
});

test('launchChrome removes its temp folder when Chrome fails to start', async (t) => {
  const { chromium } = await import('playwright');
  const { launchChrome } = await import('../ui/helpers/launch-chrome.mjs');
  let dir;
  t.mock.method(chromium, 'launch', async (options) => { dir = options.env.TMPDIR; throw new Error('no chrome'); });
  await assert.rejects(launchChrome(), /no chrome/);
  assert.equal(fs.existsSync(dir), false);
});

test('launchChrome excludes credentials and caller env while retaining launch options', async (t) => {
  const { chromium } = await import('playwright');
  const { launchChrome } = await import('../ui/helpers/launch-chrome.mjs');
  const injected = ['AK_CHROME_SECRET_SENTINEL', 'AQE_EMBEDDER_PROVIDER', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];
  const original = Object.fromEntries(injected.map((key) => [key, process.env[key]]));
  for (const key of injected) process.env[key] = `sentinel-${key}`;
  t.after(() => {
    for (const key of injected) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  let seen;
  t.mock.method(chromium, 'launch', async (options) => { seen = options; return { close: async () => {} }; });
  const browser = await launchChrome({ headless: false, args: ['--disable-gpu'], env: { AK_CHROME_SECRET_SENTINEL: 'override' } });
  try {
    assert.equal(seen.headless, false);
    assert.deepEqual(seen.args, ['--disable-gpu']);
    assert.equal(seen.env.AK_CHROME_SECRET_SENTINEL, undefined);
    for (const key of injected) {
      assert.equal(seen.env[key], undefined, `${key} should not reach Chrome`);
    }
    for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA']) {
      assert.ok(seen.env[key].startsWith(seen.env.TMPDIR), `${key} should be private`);
    }
  } finally { await browser.close(); }
});

test('Chrome environment selects Windows names without duplicate case variants', async () => {
  const { chromeEnv } = await import('../ui/helpers/launch-chrome.mjs');
  const env = chromeEnv({ Path: 'first', PATH: 'second', display: ':8', SystemRoot: 'C:\\Windows',
    temp: 'real-temp', TOKEN: 'secret' }, 'private-temp', 'win32');
  assert.equal(env.Path, 'second');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.TEMP, 'private-temp');
  assert.equal(env.TMP, 'private-temp');
  assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH').length, 1);
  assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === 'TEMP').length, 1);
  assert.equal(env.TOKEN, undefined);
});
