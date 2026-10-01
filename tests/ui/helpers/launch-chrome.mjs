// tests/ui/helpers/launch-chrome.mjs
// Launch the system Chrome with its own temp folder, removed on browser.close().
// Chrome's network fetchers create com.google.Chrome.chrome_chrome_url_fetcher_.*
// folders in its temp dir and never remove them. On Linux that dir is $TMPDIR,
// which the test runner points at its own suite temp root and checks for
// leftovers (CI run 36339702575 failed on 14 of them); on macOS Chrome ignores
// TMPDIR and reads MAC_CHROMIUM_TMPDIR, else the per-user temp dir
// (Chromium base/files/file_util_mac.mm GetTempDir). Every UI test launches
// through here so the runner's leftover check stays strict for tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Chrome needs the executable search path, display connection and a few Windows
// process basics. Its home and temp state belong to this launch, not the caller.
const CHROME_KEYS = ['PATH', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'];
const WINDOWS_NAMES = { PATH: 'Path', SYSTEMROOT: 'SystemRoot', WINDIR: 'windir', COMSPEC: 'ComSpec', PATHEXT: 'PATHEXT' };

/** @param {NodeJS.ProcessEnv} source @param {string} dir @param {string} [platform] */
export function chromeEnv(source, dir, platform = process.platform) {
  const windows = platform === 'win32';
  const env = {};
  for (const key of CHROME_KEYS) {
    let value = source[key];
    if (windows) {
      const matches = Object.keys(source).filter((name) => name.toUpperCase() === key);
      const chosen = matches.includes(key) ? key : matches.sort()[0];
      value = chosen === undefined ? undefined : source[chosen];
    }
    if (value !== undefined) env[windows ? (WINDOWS_NAMES[key] ?? key) : key] = value;
  }
  return {
    ...env,
    HOME: dir, USERPROFILE: dir,
    XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_CACHE_HOME: path.join(dir, 'cache'),
    XDG_DATA_HOME: path.join(dir, 'data'), APPDATA: path.join(dir, 'appdata'),
    LOCALAPPDATA: path.join(dir, 'localappdata'),
    TMPDIR: dir, TEMP: dir, TMP: dir, MAC_CHROMIUM_TMPDIR: dir,
  };
}

/**
 * @param {import('playwright').LaunchOptions} [options] merged over { channel: 'chrome', headless: true }
 * @returns {Promise<import('playwright').Browser>} a browser whose close() also removes Chrome's temp folder
 */
export async function launchChrome(options = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ui-chrome-')));
  const remove = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  let browser;
  try {
    browser = await chromium.launch({
      channel: 'chrome', headless: true, ...options,
      env: chromeEnv(process.env, dir),
    });
  } catch (error) { remove(); throw error; }
  const close = browser.close.bind(browser);
  browser.close = async (...args) => { try { await close(...args); } finally { remove(); } };
  return browser;
}
