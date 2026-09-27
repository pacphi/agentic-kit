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

/**
 * @param {import('playwright').LaunchOptions} [options] merged over { channel: 'chrome', headless: true }
 * @returns {Promise<import('playwright').Browser>} a browser whose close() also removes Chrome's temp folder
 */
export async function launchChrome(options = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ui-chrome-')));
  const remove = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  const temp = { TMPDIR: dir, TEMP: dir, TMP: dir, MAC_CHROMIUM_TMPDIR: dir };
  let browser;
  try {
    browser = await chromium.launch({
      channel: 'chrome', headless: true, ...options,
      env: { ...process.env, ...temp }, // spawn-env: inherits (the browser needs the display and PATH; only its temp dir moves)
    });
  } catch (error) { remove(); throw error; }
  const close = browser.close.bind(browser);
  browser.close = async (...args) => { try { await close(...args); } finally { remove(); } };
  return browser;
}
