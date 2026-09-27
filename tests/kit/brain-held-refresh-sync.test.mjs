// correctness-brain-held-refresh-lost (Branch 0 review): the hold that
// installRuvnetBrain records for a refused refresh (D3, #237) must survive the
// `ak sync` that records it. sync loads kit.json once at the start of its run
// and saves that object again (the health snapshot, and several steps), so a
// heal that wrote through a fresh loadKitConfig() had its record erased by the
// same run: every sync re-ran the refused refresh and exited 1 again.
//
// The refusing updater is a POSIX shell script on PATH, so this file is skipped
// on Windows; the heal-level contract is covered on every platform by
// brain-held-refresh.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, sandboxProject, writeKitConfig, offlineKitConfig, captureLog, rmrf,
} from './helpers/home-sandbox.mjs';
import { isolateProject } from './helpers/project-isolation.mjs';

const HOME = sandboxHome('ak-brain-held-sync');
const paths = await import('../../src/lib/paths.mjs');
const sync = await import('../../src/commands/sync.mjs');
const brain = await import('../../src/lib/ruvnet-brain.mjs');
const { brainReleaseRow } = await import('../../src/commands/status/sections/ruvnet-brain.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
assertSandboxed(paths, HOME);
isolateProject('ak-brain-held-sync-cwd');

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-brain-held-sync');
const KB = path.join(HOME, 'brain-kb');
const BIN = path.join(HOME, 'fakebin');
const NPX_LOG = path.join(HOME, 'npx.log');

test.after(() => rmrf(HOME, PROJECT));

function seed() {
  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(path.join(BIN, 'npx'), [
    '#!/bin/sh',
    `echo "npx $*" >> "${NPX_LOG}"`,
    'echo "install stopped: private overlay preflight failed — refusing to update." 1>&2',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  fs.mkdirSync(KB, { recursive: true });
  // forge-update.mjs present → the heal takes the bundle's own updater path.
  for (const f of ['forge-mcp-all.mjs', 'forge-update.mjs']) fs.writeFileSync(path.join(KB, f), '');
  fs.writeFileSync(path.join(KB, 'SOURCE.json'), JSON.stringify({ releaseTag: 'v4.3.22' }));
  writeKitConfig(HOME, offlineKitConfig({ ruvnetBrain: true, aqe: false }));
}

const npxCalls = () => (fs.existsSync(NPX_LOG) ? fs.readFileSync(NPX_LOG, 'utf8').trim().split('\n').length : 0);

test('a refused Brain refresh stays held after the ak sync that recorded it', {
  skip: process.platform === 'win32' ? 'POSIX shell fake for npx' : false,
}, async () => {
  seed();
  const saved = { path: process.env.PATH, kb: process.env.RUVNET_BRAIN_KB, fetch: globalThis.fetch, cwd: process.cwd() };
  process.env.PATH = `${BIN}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  process.env.RUVNET_BRAIN_KB = KB;
  globalThis.fetch = async (url) => (String(url).includes('api.github.com')
    ? { ok: true, json: async () => ({ tag_name: 'v4.3.28', assets: [{ name: 'ruvnet-brain.zip', browser_download_url: 'x' }] }) }
    : { ok: false, json: async () => ({}) });
  process.chdir(PROJECT);
  try {
    const collectFn = async () => [brainReleaseRow(await brain.drift())];
    const flags = { 'dry-run': false, 'no-upgrade': false, yes: true, json: false, skip: ['codex-mcp', 'host-alignment'] };
    assert.equal(brainReleaseRow(await brain.drift()).fix, 'sync refreshes the KB', 'precondition: the refresh is planned');

    await captureLog(() => sync.run({ flags, pkgRoot: PKG_ROOT, fetchLatest: async () => null, collectFn }));
    assert.equal(npxCalls(), 1, 'the first sync runs the updater once');
    const held = loadKitConfig().versionCheck?.ruvnetBrain?.heldRefresh ?? null;
    assert.ok(held, 'the hold recorded during sync must still be in kit.json after sync returns');
    assert.equal(held.latest, '4.3.28');
    assert.equal(held.installed, '4.3.22');
    assert.equal(brainReleaseRow(await brain.drift()).fix, null, 'the next status must not offer the refused refresh');

    const second = await captureLog(() => sync.run({ flags, pkgRoot: PKG_ROOT, fetchLatest: async () => null, collectFn }));
    assert.equal(second.result, 0, 'with the refresh held, the next sync has nothing to apply');
    assert.equal(npxCalls(), 1, 'the next sync must not re-run a refused refresh');
  } finally {
    process.chdir(saved.cwd);
    process.env.PATH = saved.path;
    if (saved.kb === undefined) delete process.env.RUVNET_BRAIN_KB; else process.env.RUVNET_BRAIN_KB = saved.kb;
    globalThis.fetch = saved.fetch;
  }
});
