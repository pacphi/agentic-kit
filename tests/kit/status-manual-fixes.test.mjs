// P5 (Branch 0 real-machine pass): a status row that tells the user to act must
// carry that action as its fix, marked manual (status/row.mjs repair contract).
// Otherwise it gets no "manual" tag on Overview or About, `ak sync` does not
// count it among the manual steps it leaves, and the bare `ak` hint counts only
// rows with a fix, so it reads "0 item(s) need attention" beside a warning.
//
// The rows exercised through their own section's existing tests (the Brain
// plugin and held refresh, Codex plugins, qe-court, the Ruflo memory
// configuration and backup rows, external AQE intent, an out-of-range external
// agent-browser) assert the same contract there. This file covers the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sandboxHome, assertSandboxed, sandboxProject, offlineKitConfig, rmrf, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-status-manual-fixes');
const paths = await import('../../src/lib/paths.mjs');
const aqe = (await import('../../src/commands/status/sections/aqe.mjs')).default;
const models = (await import('../../src/commands/status/sections/models.mjs')).default;
const { collectRows: codexContextRows } = await import('../../src/commands/status/sections/codex-context.mjs');
const { agentBrowserRow } = await import('../../src/commands/status/sections/agent-browser.mjs');
const { rufloComponentRows } = await import('../../src/commands/status/sections/ruflo-components.mjs');
const { describeState } = await import('../../src/lib/ruflo-components/states.mjs');
assertSandboxed(paths, HOME);

const PROJECT = sandboxProject('ak-status-manual-fixes');
test.after(() => rmrf(HOME, PROJECT));

const manual = (r, fix, why) => {
  assert.ok(r, why);
  assert.equal(r.repair, 'manual', `${why}: ${JSON.stringify(r)}`);
  assert.match(r.fix ?? '', fix, `${why}: ${JSON.stringify(r)}`);
};

test('a missing AQE semantic backend names the configure command as a manual fix', async (t) => {
  // An agentic-qe without @huggingface/transformers and no endpoint: no backend.
  const endpoint = process.env.AQE_EMBEDDER_ENDPOINT;
  delete process.env.AQE_EMBEDDER_ENDPOINT;
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { 'agentic-qe': '9.9.9' }));
  t.after(() => {
    paths._setGlobalRootForTest(null);
    if (endpoint !== undefined) process.env.AQE_EMBEDDER_ENDPOINT = endpoint;
  });
  const rows = await aqe.collect({ cwd: PROJECT, cfg: offlineKitConfig() });
  const missing = rows.find((r) => r.subsystem === 'aqe-embedding' && r.level === 'warn');
  manual(missing, /^ak x aqe-embedding configure/, 'the user chooses the backend; sync cannot');
  assert.equal(missing.message, 'semantic backend missing');
});

test('Codex context ownership kept while Codex is disabled names `ak x codex-context off` as a manual fix', () => {
  const [held] = codexContextRows({ owned: true, available: true, enabled: false });
  assert.equal(held.level, 'warn');
  manual(held, /^ak x codex-context off/, 'releasing the context request is the user\'s call');
  assert.doesNotMatch(held.message, /ak x codex-context off/, 'the command lives in the fix, not twice');
});

test('an unreadable model inventory names `ak models refresh` as a manual fix', async () => {
  const rows = await models.collect({ readStore: () => { throw new Error('store locked'); } });
  const unavailable = rows.find((r) => /model inventory unavailable/.test(r.message));
  manual(unavailable, /^ak models refresh$/, 'model discovery belongs to an explicit command, never sync');
  assert.equal(unavailable.message, 'model inventory unavailable: store locked');
});

test('a platform without Chrome for Testing asks for a Chromium/Chrome executable as a manual fix', () => {
  const r = agentBrowserRow({
    supported: true, target: '0.27.3',
    package: { present: true, compatible: true, native: true, receiptState: 'owned', version: '0.27.3', ownership: 'agentic-kit' },
    config: { state: 'current', valid: true },
    browser: null,
    browserPayload: { autoInstallSupported: false, platform: 'linux', arch: 'arm64' },
  });
  assert.equal(r.level, 'warn');
  manual(r, /Chromium\/Chrome executable/, 'sync cannot download a browser for this platform');
  assert.match(r.message, /Chrome for Testing is unavailable on linux\/arm64/);
});

test('an applied but unverified Ruflo component names the host restart as a manual fix', () => {
  const rows = rufloComponentRows({
    rufloVersion: '3.46.1', summary: { active: 0, total: 1 },
    components: [{ id: 'typesafePicker', label: 'Typesafe agent picker', state: describeState('applied-unverified') }],
  });
  const unverified = rows.find((r) => r.state === 'applied-unverified');
  assert.equal(unverified.level, 'warn');
  manual(unverified, /restart Claude Code, Codex and OpenCode/i, 'only a host restart confirms it');
  assert.match(unverified.message, /Typesafe agent picker — applied, not verified/, 'ADR-0058 rows keep state, meaning and action');
});
