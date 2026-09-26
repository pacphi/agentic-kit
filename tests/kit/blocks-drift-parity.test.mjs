// Guidance-block drift parity (#237 S2): `ak status` (blocks section), the
// post-command nudge (localDrift), and the writer `ak sync` runs
// (reconcileGuidance) must give ONE answer for the same machine. The writer
// evaluates detectors against kit.json intent (guidanceContextFromConfig) and
// only force-strips rows re-scoped to a KNOWN target; status and the nudge used
// to rebuild that loop with a thinner context, so an `enabled` detector fell
// back to PATH/dir/always probes and reported drift sync would never act on —
// in both directions. Each scenario converges CLAUDE.md with sync's exact call,
// then asks all three readers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, rmrf, sandboxProject, writeKitConfig, offlineKitConfig,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-blocks-parity');
const paths = await import('../../src/lib/paths.mjs');
const { reconcileGuidance, upsertBlock, stripBlock, BEGIN } = await import('../../src/lib/blocks.mjs');
const blocksSection = (await import('../../src/commands/status/sections/blocks.mjs')).default;
const { localDrift } = await import('../../src/lib/nudge.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
const { guidanceContext } = await import('../../src/lib/providers.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-blocks-parity');
const SANDBOX_PATH = process.env.PATH;

/** Fresh machine guidance + kit.json, then sync's exact (writing) reconcile. */
async function converge(hosts, extra = {}) {
  rmrf(paths.claudeDir(), paths.codexDir(), paths.configDir(), path.join(PROJECT, 'AGENTS.md'));
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# machine notes\n');
  writeKitConfig(HOME, offlineKitConfig({
    integrations: { version: 3, hosts, bindings: [], ownership: {} }, ...extra,
  }));
  const cfg = loadKitConfig();
  await reconcileGuidance({ cwd: PROJECT, cfg, pkgRoot: PKG_ROOT, context: guidanceContext(cfg) });
  return cfg;
}

/** The three readers: sync's dry run, the status section, and the nudge. */
async function readers(cfg) {
  const writer = await reconcileGuidance({
    cwd: PROJECT, cfg, pkgRoot: PKG_ROOT, context: guidanceContext(cfg), dryRun: true,
  });
  const status = await blocksSection.collect({ cfg, cwd: PROJECT, pkgRoot: PKG_ROOT });
  // The nudge also reports cross-host MCP facts; only its block phrases are in scope.
  const nudge = (await localDrift({ pkgRoot: PKG_ROOT, cwd: PROJECT, cfg }))
    .filter((line) => / block\(s\)$/.test(line));
  return { writer, status, nudge };
}

function assertAllInSync({ writer, status, nudge }) {
  assert.deepEqual(writer.map((t) => t.changed), writer.map(() => ''), 'sync must see nothing to do after converging');
  assert.deepEqual(status.filter((r) => r.level !== 'ok').map((r) => r.message), [],
    'status must agree with sync that every managed block is in sync');
  assert.deepEqual(nudge, [], 'the nudge must agree with sync that nothing drifted');
}

test('Claude-only machine with AQE managed but not on PATH: status and nudge agree with sync', async () => {
  // kit.json intent says AQE is managed (aqe !== false), so sync keeps the AQE
  // reference; a PATH probe for `aqe` must not turn that into a strip.
  const cfg = await converge({ claude: true, codex: false, opencode: false });
  assert.ok(fs.readFileSync(paths.claudeMdPath(), 'utf8').includes(BEGIN('ruflo-aqe-reference')),
    'fixture precondition: the writer places the AQE reference from kit.json intent');
  assertAllInSync(await readers(cfg));
});

test('Codex installed but disabled in kit.json: a PATH probe does not re-add provider guidance',
  { skip: process.platform === 'win32' && 'POSIX `which` stub; the PATH-free cases cover Windows' },
  async (t) => {
    const bin = path.join(HOME, 'stub-bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = [bin, '/usr/bin', '/bin'].join(path.delimiter);
    t.after(() => { process.env.PATH = SANDBOX_PATH; });
    const cfg = await converge({ claude: true, codex: false, opencode: false });
    assert.ok(!fs.readFileSync(paths.claudeMdPath(), 'utf8').includes(BEGIN('ruflo-providers-reference')),
      'fixture precondition: disabled Codex keeps provider guidance out');
    assertAllInSync(await readers(cfg));
  });

test('Codex-only machine (Claude disabled): Claude-gated guidance is not reported as missing', async () => {
  const cfg = await converge({ claude: false, codex: true, opencode: false });
  assert.ok(!fs.readFileSync(paths.claudeMdPath(), 'utf8').includes(BEGIN('ruflo-reference')),
    'fixture precondition: Claude-gated reference stays out when Claude is disabled');
  assertAllInSync(await readers(cfg));
});

test('dual-host machine with AQE opted out and no codex on PATH: all three readers agree', async () => {
  // Enabled Codex keeps provider guidance even when this sandbox's PATH has no
  // `codex`; aqe:false keeps the AQE reference out even though no probe runs.
  const cfg = await converge({ claude: true, codex: true, opencode: false }, { aqe: false });
  assertAllInSync(await readers(cfg));
});

test('a custom block scoped only to an absent target is left alone by all three readers', async () => {
  const tpl = path.join(HOME, 'my-block.md');
  fs.writeFileSync(tpl, 'custom guidance\n');
  // ~/.codex is absent, so 'agents-user' is not a target on this machine: the
  // writer has no basis to call the block retired from CLAUDE.md.
  const cfg = await converge({ claude: true, codex: false, opencode: false }, {
    aqe: false,
    customBlocks: [{ slug: 'my-custom', templatePath: tpl, detector: { type: 'always' }, guidanceFiles: ['agents-user'] }],
  });
  fs.appendFileSync(paths.claudeMdPath(), '\n<!-- BEGIN my-custom -->\ncustom guidance\n<!-- END my-custom -->\n');
  assert.equal(fs.existsSync(paths.codexDir()), false, 'fixture precondition: no ~/.codex');
  assertAllInSync(await readers(cfg));
});

test('a real missing block is still reported by sync, status, and the nudge', async () => {
  const cfg = await converge({ claude: true, codex: false, opencode: false });
  const file = paths.claudeMdPath();
  fs.writeFileSync(file, stripBlock(fs.readFileSync(file, 'utf8'), 'ruflo-reference'));
  const { writer, status, nudge } = await readers(cfg);
  assert.equal(writer.find((t) => t.name === 'claude').changed, 'ruflo-reference upserted');
  const drift = status.find((r) => r.level === 'warn');
  assert.equal(drift?.message, '1 CLAUDE.md block(s) drifted: ruflo-reference→upserted');
  assert.equal(drift?.fix, 'sync reconciles blocks');
  assert.deepEqual(nudge, ['1 CLAUDE.md block(s)']);
});

test('a real stale block is reported as stripped (not "stripp") by status', async () => {
  const cfg = await converge({ claude: true, codex: true, opencode: false }, { aqe: false });
  const file = paths.claudeMdPath();
  fs.writeFileSync(file, upsertBlock(fs.readFileSync(file, 'utf8'), 'ruflo-aqe-reference',
    '<!-- BEGIN ruflo-aqe-reference -->\nstale\n<!-- END ruflo-aqe-reference -->\n'));
  const { writer, status, nudge } = await readers(cfg);
  assert.equal(writer.find((t) => t.name === 'claude').changed, 'ruflo-aqe-reference stripped');
  assert.equal(status.find((r) => r.level === 'warn')?.message,
    '1 CLAUDE.md block(s) drifted: ruflo-aqe-reference→stripped');
  assert.deepEqual(nudge, ['1 CLAUDE.md block(s)']);
});
