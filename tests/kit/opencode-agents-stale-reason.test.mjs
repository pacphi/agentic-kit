// P4 (Branch 0 real-machine pass): the OpenCode agent-projection row read
// "1 agent projection files from npm-nested@3.45.0, current source is
// npm-nested@3.45.0". The projection stamp is compared on five facts (stamp
// present, catalog source id, projected file set, lazy-dispatcher mode, gateway
// families), and the last two are derived from whether the lazy rUv gateway is
// current. When only the gateway is out of date the projection goes stale as a
// consequence, while the message named the one fact that had not changed.
//
// This file runs in a disposable HOME (every OpenCode path resolves inside it)
// and checks two things: the row names what actually diverged, and a real
// `ak sync` clears the row, so it cannot keep `ak sync` exiting 1.
//
// The fake `opencode` CLI is a POSIX shell script on PATH, so the sync test is
// skipped on Windows; the row-text test runs everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, sandboxProject, writeKitConfig, offlineKitConfig, captureLog, rmrf,
} from './helpers/home-sandbox.mjs';
import { isolateProject } from './helpers/project-isolation.mjs';

const HOME = sandboxHome('ak-oc-stale-reason');
const paths = await import('../../src/lib/paths.mjs');
const { opencodeStack } = await import('../../src/lib/opencode.mjs');
const { opencodeDetailRows } = await import('../../src/commands/status/host-detail.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
const sync = await import('../../src/commands/sync.mjs');
assertSandboxed(paths, HOME);
isolateProject('ak-oc-stale-reason-cwd');

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-oc-stale-reason');
const BIN = path.join(HOME, 'fakebin');
const FACTS = { hosts: { opencode: { present: true } } };

test.after(() => rmrf(HOME, PROJECT));

/** A minimal Ruflo catalog: package.json (the source id's version), two agents,
 *  and the platform skill. */
function makeCatalog(root) {
  fs.mkdirSync(path.join(root, '.claude', 'agents', 'core'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }));
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'core', 'coder.md'),
    '---\nname: coder\ndescription: Implementation specialist\n---\n\nWrite the code.\n');
  fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: ruflo\ndescription: platform\n---\n\n# Ruflo\n');
  return root;
}

/** Add a catalog agent: the lazy gateway embeds the catalog, so its bytes go
 *  out of date, while the source id (package.json version) stays the same. */
function addCatalogAgent(root, name) {
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'core', `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} specialist\n---\n\nDo the ${name} work.\n`);
}

function opencodeCfg(catalogDir) {
  return offlineKitConfig({
    aqe: false,
    integrations: {
      version: 2,
      hosts: { claude: true, codex: false, opencode: true },
      bindings: [],
      ownership: { opencode: { mcp: null, managed: null, catalogDir } },
    },
    routing: { version: 1, primaryHost: 'claude', routes: {} },
    providers: {},
  });
}

/** Each test starts from an empty OpenCode home: the three share one sandbox,
 *  and a projection left by one test would read as user-owned in the next. */
const freshOpencodeHome = () => fs.rmSync(paths.opencodeDir(), { recursive: true, force: true });

const agentsRow = (rows) => rows.find((r) => /agent projection|specialist dispatcher|converted agents/.test(r.message));
const gatewayRow = (rows) => rows.find((r) => /lazy rUv gateway|gateway projection active/.test(r.message));

test('a projection stale only because the lazy gateway is out of date names the gateway, not the source', async () => {
  freshOpencodeHome();
  const catalog = makeCatalog(path.join(HOME, 'catalog-row'));
  const cfg = opencodeCfg(catalog);
  await opencodeStack(cfg, { pkgRoot: PKG_ROOT });
  const before = agentsRow(await opencodeDetailRows({ cfg, pkgRoot: PKG_ROOT, facts: FACTS }));
  assert.equal(before?.level, 'ok', `precondition: the projection starts current (${JSON.stringify(before)})`);

  addCatalogAgent(catalog, 'tester');
  const rows = await opencodeDetailRows({ cfg, pkgRoot: PKG_ROOT, facts: FACTS });
  assert.equal(gatewayRow(rows)?.message, 'lazy rUv gateway out of date', 'precondition: only the gateway changed');
  const stale = agentsRow(rows);
  assert.equal(stale?.level, 'warn');
  assert.equal(stale.fix, 'sync refreshes the agent projection');
  assert.doesNotMatch(stale.message, /from (\S+), current source is \1\b/,
    'a stale row must not name the same source on both sides as if it had changed');
  assert.equal(stale.message,
    '1 agent projection files from override@9.9.9 are out of date: '
    + 'they were written for the lazy rUv gateway, which is out of date');

  await opencodeStack(cfg, { pkgRoot: PKG_ROOT });
  const after = await opencodeDetailRows({ cfg, pkgRoot: PKG_ROOT, facts: FACTS });
  assert.equal(agentsRow(after)?.level, 'ok', 'refreshing the stack clears the projection row');
  assert.equal(gatewayRow(after)?.level, 'ok');
});

test('a real catalog source change still names both source ids', async () => {
  freshOpencodeHome();
  const catalog = makeCatalog(path.join(HOME, 'catalog-source'));
  const cfg = opencodeCfg(catalog);
  await opencodeStack(cfg, { pkgRoot: PKG_ROOT });
  fs.writeFileSync(path.join(catalog, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.10' }));
  const stale = agentsRow(await opencodeDetailRows({ cfg, pkgRoot: PKG_ROOT, facts: FACTS }));
  assert.equal(stale?.message, '1 agent projection files from override@9.9.9, current source is override@9.9.10');
});

test('ak sync clears a gateway-derived stale projection and exits 0', {
  skip: process.platform === 'win32' ? 'POSIX shell fake for the opencode CLI' : false,
}, async () => {
  freshOpencodeHome();
  const catalog = makeCatalog(path.join(HOME, 'catalog-sync'));
  // The first deploy records its ownership receipts on cfg; kit.json keeps them,
  // as the sync that deployed them would have.
  const seeded = opencodeCfg(catalog);
  await opencodeStack(seeded, { pkgRoot: PKG_ROOT });
  writeKitConfig(HOME, seeded);
  addCatalogAgent(catalog, 'reviewer');

  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(path.join(BIN, 'opencode'), '#!/bin/sh\necho "0.0.0-fake"\n', { mode: 0o755 });
  const collectFn = async () => opencodeDetailRows({ cfg: loadKitConfig(), pkgRoot: PKG_ROOT, facts: FACTS });
  const staleBefore = agentsRow(await collectFn());
  assert.equal(staleBefore?.level, 'warn', `precondition: the projection is stale (${JSON.stringify(staleBefore)})`);

  const saved = { path: process.env.PATH, cwd: process.cwd() };
  process.env.PATH = `${BIN}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  process.chdir(PROJECT);
  try {
    const flags = { 'dry-run': false, 'no-upgrade': true, yes: true, json: false, skip: ['codex-mcp', 'host-alignment'] };
    const { result, out } = await captureLog(() => sync.run({
      flags, pkgRoot: PKG_ROOT, fetchLatest: async () => null, collectFn,
    }));
    assert.match(out, /\[opencode\] sync refreshes the agent projection/, `the refresh was planned:\n${out}`);
    assert.equal(result, 0, `ak sync must converge the row, not exit 1:\n${out}`);
    assert.doesNotMatch(out, /unresolved|did not converge/i, out);
    const after = await collectFn();
    assert.equal(agentsRow(after)?.level, 'ok', `the next status reads current (${JSON.stringify(agentsRow(after))})`);
    assert.equal(gatewayRow(after)?.level, 'ok');
  } finally {
    process.chdir(saved.cwd);
    process.env.PATH = saved.path;
  }
});
