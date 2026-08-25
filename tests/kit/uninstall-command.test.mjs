// `ak uninstall` — the teardown path. It edits the user's machine-wide
// ~/.claude/CLAUDE.md, deletes a deployed skill, rewrites shell rc files and
// (optionally) removes kit.json, so the properties that matter are: --dry-run
// changes nothing, a real run backs up before it mutates, foreign content in
// the files it touches survives, and running it twice is a no-op the second
// time. Every path below runs against a sandboxed HOME (see helpers/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  sandboxHome, assertSandboxed, snapshot, assertUnchanged, captureLog, rmrf,
  sandboxProject, writeKitConfig,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-uninstall');
// Dynamic — paths.mjs snapshots os.homedir() at load, so it must not be
// hoisted above sandboxHome().
const paths = await import('../../src/lib/paths.mjs');
const { BEGIN, END } = await import('../../src/lib/blocks.mjs');
const uninstall = await import('../../src/commands/uninstall.mjs');
assertSandboxed(paths, HOME);

const FOREIGN_MD = `# My own notes

Hand-written guidance that ak did not author and must never destroy.
`;
const block = (slug, body) => `${BEGIN(slug)}\n${body}\n${END(slug)}\n`;

/** Reset the sandbox home to a known state: a CLAUDE.md carrying two managed
 *  blocks wrapped around foreign content, a deployed skill, and a kit.json. */
function seedHome() {
  rmrf(paths.claudeDir(), paths.configDir());
  fs.mkdirSync(paths.claudeSkillsDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(),
    `${block('ruflo-preamble', 'preamble body')}\n${FOREIGN_MD}\n${block('ruflo-reference', 'reference body')}`);
  const skill = path.join(paths.claudeSkillsDir(), 'ruflo-token-audit');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# skill\n');
  writeKitConfig(HOME, { aqe: true });
  return { skill };
}

const readMd = () => fs.readFileSync(paths.claudeMdPath(), 'utf8');
const bakFiles = () => fs.readdirSync(paths.claudeDir()).filter((f) => f.startsWith('CLAUDE.md.bak'));

test('--dry-run reports the teardown without writing a single byte', async () => {
  seedHome();
  const before = snapshot(HOME);
  const { result, out } = await captureLog(() => uninstall.run({ flags: { 'dry-run': true } }));
  assert.equal(result, 0);
  assert.match(out, /\[dry-run\] stripped 2 managed block\(s\)/);
  assert.match(out, /\[dry-run\] removed skill ruflo-token-audit/);
  assert.match(out, /\[dry-run\] unregister claude-flow\/ruflo MCP/);
  assertUnchanged(before, HOME, '`ak uninstall --dry-run` must not touch the filesystem');
});

test('--dry-run --purge still writes nothing (kit.json survives a previewed purge)', async () => {
  seedHome();
  const before = snapshot(HOME);
  const { result } = await captureLog(() => uninstall.run({ flags: { 'dry-run': true, purge: true, yes: true } }));
  assert.equal(result, 0);
  assert.ok(fs.existsSync(paths.kitConfigPath()), 'kit.json must survive a dry-run purge');
  assertUnchanged(before, HOME, '`ak uninstall --purge --dry-run` must not touch the filesystem');
});

test('a real run strips only the managed blocks and preserves foreign content', async () => {
  seedHome();
  const { result } = await captureLog(() => uninstall.run({ flags: { yes: true } }));
  assert.equal(result, 0);
  const md = readMd();
  assert.ok(!md.includes(BEGIN('ruflo-preamble')), 'preamble block stripped');
  assert.ok(!md.includes(BEGIN('ruflo-reference')), 'reference block stripped');
  assert.ok(!md.includes('preamble body') && !md.includes('reference body'), 'block bodies stripped');
  assert.ok(md.includes('Hand-written guidance that ak did not author'),
    'foreign content between the managed blocks must survive the strip');
});

test('the CLAUDE.md backup is written BEFORE the mutation and holds the pre-strip content', async () => {
  seedHome();
  const original = readMd();
  await captureLog(() => uninstall.run({ flags: { yes: true } }));
  const baks = bakFiles();
  assert.equal(baks.length, 1, `exactly one timestamped backup, got: ${baks}`);
  assert.equal(fs.readFileSync(path.join(paths.claudeDir(), baks[0]), 'utf8'), original,
    'the backup must be the file as it stood before the first mutation');
});

test('running uninstall twice is idempotent — the second run finds nothing to strip', async () => {
  seedHome();
  await captureLog(() => uninstall.run({ flags: { yes: true } }));
  const afterFirst = readMd();
  const baksAfterFirst = bakFiles().length;

  const { result, out } = await captureLog(() => uninstall.run({ flags: { yes: true } }));
  assert.equal(result, 0);
  assert.equal(readMd(), afterFirst, 'second run leaves CLAUDE.md byte-identical');
  assert.ok(!/stripped \d+ managed block/.test(out), 'second run reports no block strip');
  assert.equal(bakFiles().length, baksAfterFirst, 'second run writes no further backup');
});

test('an orphaned BEGIN sentinel is left alone rather than truncating the file', async () => {
  seedHome();
  fs.writeFileSync(paths.claudeMdPath(), `${BEGIN('ruflo-preamble')}\nbody with no END\n\n${FOREIGN_MD}`);
  await captureLog(() => uninstall.run({ flags: { yes: true } }));
  assert.ok(readMd().includes('Hand-written guidance that ak did not author'),
    'a malformed block must never take the rest of the user\'s CLAUDE.md with it');
});

test('the deployed skill is removed but kit.json survives without --purge', async () => {
  const { skill } = seedHome();
  await captureLog(() => uninstall.run({ flags: { yes: true } }));
  assert.equal(fs.existsSync(skill), false, 'ruflo-token-audit skill removed');
  assert.ok(fs.existsSync(paths.kitConfigPath()), 'kit.json is only removed under --purge');
});

test('--purge removes kit.json', async () => {
  seedHome();
  const dir = path.dirname(paths.kitConfigPath());
  const inventory = path.join(dir, 'model-inventory.json');
  const scopeKey = path.join(dir, 'model-scope.key');
  fs.writeFileSync(inventory, '{}');
  fs.writeFileSync(scopeKey, 'ab'.repeat(32));
  await captureLog(() => uninstall.run({ flags: { yes: true, purge: true } }));
  assert.equal(fs.existsSync(paths.kitConfigPath()), false);
  assert.equal(fs.existsSync(inventory), false);
  assert.equal(fs.existsSync(scopeKey), false);
});

test('legacy shell-kit rc lines are removed, other rc lines and a .bak survive', async () => {
  seedHome();
  const rc = path.join(paths.home, '.zshrc');
  fs.writeFileSync(rc, 'export EDITOR=vim\nsource ~/.config/ruflo/ruflo-functions.sh\nalias g=git\n');
  await captureLog(() => uninstall.run({ flags: { yes: true } }));
  const txt = fs.readFileSync(rc, 'utf8');
  assert.ok(!txt.includes('ruflo-functions.sh'), 'shell-kit source line removed');
  assert.ok(txt.includes('export EDITOR=vim') && txt.includes('alias g=git'),
    'the user\'s own rc lines must survive');
  assert.ok(fs.existsSync(`${rc}.bak`), 'rc rewrite is backed up first');
  assert.match(fs.readFileSync(`${rc}.bak`, 'utf8'), /ruflo-functions\.sh/);
});

test('an rc file with no shell-kit line is not rewritten at all', async () => {
  seedHome();
  const rc = path.join(paths.home, '.bashrc');
  fs.writeFileSync(rc, 'alias ll="ls -al"\n');
  const before = snapshot(paths.home);
  await captureLog(() => uninstall.run({ flags: { yes: true } }));
  assert.equal(fs.readFileSync(rc, 'utf8'), 'alias ll="ls -al"\n');
  assert.equal(fs.existsSync(`${rc}.bak`), false, 'no gratuitous .bak for an untouched rc');
  assert.ok(before.has('.bashrc'));
});

test('legacy ~/.local/bin/ruflo-* shims are removed, unrelated bins are not', async () => {
  seedHome();
  const bin = path.join(paths.home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ruflo-setup-project'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(bin, 'my-own-tool'), '#!/bin/sh\n');
  await captureLog(() => uninstall.run({ flags: { yes: true } }));
  assert.equal(fs.existsSync(path.join(bin, 'ruflo-setup-project')), false);
  assert.ok(fs.existsSync(path.join(bin, 'my-own-tool')), 'non-ruflo bins are none of our business');
});

test('--this-project reverts the statusline footer and backs the helper up', async () => {
  seedHome();
  const project = sandboxProject('ak-uninstall');
  const sl = paths.projectStatusline(project);
  fs.mkdirSync(path.dirname(sl), { recursive: true });
  const body = 'const base = () => "x";\n'
    + '/* ruflo-seg:BEGIN */\nfunction rufloActivationSegments() { return ""; }\n/* ruflo-seg:END */\n'
    + 'console.log(base() + rufloActivationSegments(process.cwd()));\n';
  fs.writeFileSync(sl, body);
  const cwd = process.cwd();
  process.chdir(project);
  try {
    await captureLog(() => uninstall.run({ flags: { yes: true, 'this-project': true } }));
  } finally { process.chdir(cwd); }
  const after = fs.readFileSync(sl, 'utf8');
  assert.ok(!after.includes('ruflo-seg:BEGIN'), 'injected segment block removed');
  assert.ok(!after.includes('rufloActivationSegments(process.cwd())'), 'call site removed');
  assert.ok(after.includes('const base = () => "x";'), 'the rest of the helper survives');
  assert.equal(fs.readFileSync(`${sl}.bak`, 'utf8'), body, 'pre-revert helper is backed up');
  rmrf(project);
});

test('without --this-project the current project is left completely alone', async () => {
  seedHome();
  const project = sandboxProject('ak-uninstall-keep');
  const sl = paths.projectStatusline(project);
  fs.mkdirSync(path.dirname(sl), { recursive: true });
  fs.writeFileSync(sl, '/* ruflo-seg:BEGIN */\nx\n/* ruflo-seg:END */\n');
  const before = snapshot(project);
  const cwd = process.cwd();
  process.chdir(project);
  try {
    await captureLog(() => uninstall.run({ flags: { yes: true } }));
  } finally { process.chdir(cwd); }
  assertUnchanged(before, project, 'default uninstall is machine-scope only');
  rmrf(project);
});

test('a missing ~/.claude/CLAUDE.md is not an error', async () => {
  rmrf(paths.claudeDir(), paths.configDir());
  const { result } = await captureLog(() => uninstall.run({ flags: { yes: true } }));
  assert.equal(result, 0, 'uninstalling from a machine that was never set up still succeeds');
});

// ── opencode teardown ────────────────────────────────────────────────────────
// The third host's footprint: opencode.json wiring (value-precise — user priors
// restored), ak-marked artifacts (plugin/agents/skill), and the AGENTS.md
// guidance blocks. User-edited and marker-less files always survive; repeated
// runs are harmless; --dry-run writes nothing; --purge still honors ownership
// because the markers are read BEFORE kit.json is removed.

const ocHome = () => path.join(HOME, '.config', 'opencode');
const hash = (text) => createHash('sha256').update(text).digest('hex');

/** Seed an ak-managed opencode state (wiring + artifacts + markers), plus a
 *  user-owned agent and user config keys that must survive every teardown. */
function seedManagedOpencode() {
  const cfgDir = ocHome();
  fs.mkdirSync(path.join(cfgDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(cfgDir, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(cfgDir, 'skills', 'ruflo'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'opencode.json'), JSON.stringify({
    model: 'opencode/kimi-k3',
    mcp: {
      'my-server': { type: 'local', command: ['x'] },
      'claude-flow': { type: 'local', command: ['ruflo', 'mcp', 'start'], enabled: true },
    },
    permission: { 'claude-flow_*': 'allow', edit: 'ask' },
  }, null, 2));
  const plugin = '// from src/templates/opencode-ruflo-hooks.js — ak-managed\n';
  const agent = '---\ndescription: x\n---\n\n<!-- generated-by: agentic-kit — re-synced by `ak sync`; do not edit -->\nbody\n';
  const stamp = '{"source":"x"}\n';
  const skill = '# Ruflo\n\n<!-- deployed by agentic-kit --> from fixture@9.9.9\n';
  fs.writeFileSync(path.join(cfgDir, 'plugins', 'ruflo-hooks.js'), plugin);
  fs.writeFileSync(path.join(cfgDir, 'agents', 'coder.md'), agent);
  fs.writeFileSync(path.join(cfgDir, 'agents', '.ak-agents-stamp.json'), stamp);
  fs.writeFileSync(path.join(cfgDir, 'agents', 'my-agent.md'), '---\ndescription: mine\n---\n\nUser agent.\n');
  fs.writeFileSync(path.join(cfgDir, 'skills', 'ruflo', 'SKILL.md'), skill);
  fs.writeFileSync(path.join(cfgDir, 'AGENTS.md'),
    '# my notes\n\n<!-- BEGIN ruflo-opencode-reference -->\nguidance\n<!-- END ruflo-opencode-reference -->\n');
  writeKitConfig(HOME, {
    aqe: true,
    integrations: {
      version: 2,
      hosts: { claude: true, codex: false, opencode: true },
      bindings: [],
      ownership: {
        opencode: {
          mcp: 'ak',
          managed: {
            mcp: { 'claude-flow': { prior: null, written: { type: 'local', command: ['ruflo', 'mcp', 'start'], enabled: true } } },
            paths: [],
            permissions: { 'claude-flow_*': { prior: null, written: 'allow' } },
            permissionScalar: null,
            artifacts: {
              plugin: hash(plugin),
              agents: { 'coder.md': hash(agent) },
              agentStamp: hash(stamp),
              skill: hash(skill),
            },
          },
        },
      },
    },
    routing: { version: 1, primaryHost: 'claude', routes: {} },
    providers: {},
  });
}

test('default uninstall strips ak opencode wiring + artifacts and restores user config', async () => {
  seedHome();
  seedManagedOpencode();
  const { result } = await captureLog(() => uninstall.run({ flags: { yes: true } }));
  assert.equal(result, 0);
  const doc = JSON.parse(fs.readFileSync(path.join(ocHome(), 'opencode.json'), 'utf8'));
  assert.ok(!doc.mcp?.['claude-flow'], 'ak MCP entry stripped');
  assert.deepEqual(doc.mcp?.['my-server'], { type: 'local', command: ['x'] }, 'user MCP server survives');
  assert.equal(doc.model, 'opencode/kimi-k3', 'user model key survives');
  assert.equal(doc.permission?.edit, 'ask', 'user permission survives');
  assert.ok(!doc.permission?.['claude-flow_*'], 'ak permission pattern stripped');
  assert.ok(!fs.existsSync(path.join(ocHome(), 'plugins', 'ruflo-hooks.js')), 'ak plugin removed');
  assert.ok(!fs.existsSync(path.join(ocHome(), 'agents', 'coder.md')), 'ak agent removed');
  assert.ok(!fs.existsSync(path.join(ocHome(), 'agents', '.ak-agents-stamp.json')), 'agent stamp removed');
  assert.ok(fs.existsSync(path.join(ocHome(), 'agents', 'my-agent.md')), 'user-owned agent survives');
  assert.ok(!fs.existsSync(path.join(ocHome(), 'skills', 'ruflo', 'SKILL.md')), 'ak skill removed');
  const md = fs.readFileSync(path.join(ocHome(), 'AGENTS.md'), 'utf8');
  assert.ok(!md.includes('ruflo-opencode-reference'), 'guidance block stripped');
  assert.ok(md.includes('# my notes'), 'user guidance survives');
  const cfg = JSON.parse(fs.readFileSync(paths.kitConfigPath(), 'utf8'));
  assert.equal(cfg.integrations.ownership.opencode.mcp, null, 'ownership markers nulled (kit.json kept without --purge)');
});

test('a quiet-success undo still persists the nulled ownership markers (save is not gated on file changes)', async () => {
  // The stale-marker case the save-gate bug stranded forever: ownership says
  // mcp:'ak' but the tracked entries are ALREADY absent from opencode.json and
  // no ak artifacts exist on disk — undo rewrites nothing (changed:false,
  // ok:true) yet nulls cfg's markers in memory. Those nulls must reach
  // kit.json anyway, exactly as x/host.mjs's off()/pick() persist them.
  seedHome();
  const cfgDir = ocHome();
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'opencode.json'), JSON.stringify({
    model: 'opencode/kimi-k3',
    mcp: { 'my-server': { type: 'local', command: ['x'] } },
    permission: { edit: 'ask' },
  }, null, 2));
  writeKitConfig(HOME, {
    aqe: true,
    integrations: {
      version: 2,
      hosts: { claude: true, codex: false, opencode: true },
      bindings: [],
      ownership: {
        opencode: {
          mcp: 'ak',
          managed: {
            mcp: { 'claude-flow': { prior: null, written: { type: 'local', command: ['ruflo', 'mcp', 'start'], enabled: true } } },
            paths: [],
            permissions: { 'claude-flow_*': { prior: null, written: 'allow' } },
            permissionScalar: null,
            artifacts: { plugin: hash('never-on-disk'), agents: {}, agentStamp: null, skill: hash('never-on-disk') },
          },
        },
      },
    },
    routing: { version: 1, primaryHost: 'claude', routes: {} },
    providers: {},
  });
  const { result } = await captureLog(() => uninstall.run({ flags: { yes: true } }));
  assert.equal(result, 0);
  const cfg = JSON.parse(fs.readFileSync(paths.kitConfigPath(), 'utf8'));
  assert.equal(cfg.integrations.ownership.opencode.mcp, null,
    'stale mcp:ak marker is nulled in kit.json even when undo rewrote no file');
  const doc = JSON.parse(fs.readFileSync(path.join(cfgDir, 'opencode.json'), 'utf8'));
  assert.deepEqual(doc.mcp, { 'my-server': { type: 'local', command: ['x'] } }, 'user config untouched');
});

test('repeated uninstall is harmless for the opencode footprint', async () => {
  seedHome();
  seedManagedOpencode();
  await captureLog(() => uninstall.run({ flags: { yes: true } }));
  const after = snapshot(ocHome());
  const { result } = await captureLog(() => uninstall.run({ flags: { yes: true } }));
  assert.equal(result, 0, 'second uninstall succeeds with nothing left to strip');
  assertUnchanged(after, ocHome(), 'second uninstall changes nothing');
});

test('uninstall --dry-run writes and removes nothing on the opencode surfaces', async () => {
  seedHome();
  seedManagedOpencode();
  const before = snapshot(HOME);
  const { result, out } = await captureLog(() => uninstall.run({ flags: { 'dry-run': true, yes: true } }));
  assert.equal(result, 0);
  assert.match(out, /\[dry-run\] stripped ak-managed opencode wiring/, 'dry-run reports the opencode teardown');
  assertUnchanged(before, HOME, 'dry-run must not touch the filesystem');
});

test('uninstall --purge removes kit.json AFTER reading ownership — opencode wiring is still stripped', async () => {
  seedHome();
  seedManagedOpencode();
  const { result } = await captureLog(() => uninstall.run({ flags: { yes: true, purge: true } }));
  assert.equal(result, 0);
  assert.ok(!fs.existsSync(paths.kitConfigPath()), 'kit.json purged');
  const doc = JSON.parse(fs.readFileSync(path.join(ocHome(), 'opencode.json'), 'utf8'));
  assert.ok(!doc.mcp?.['claude-flow'], 'wiring stripped even under purge (ownership read first)');
  assert.ok(!fs.existsSync(path.join(ocHome(), 'plugins', 'ruflo-hooks.js')), 'artifacts removed under purge');
  assert.ok(!fs.existsSync(paths.kitConfigPath()), 'purge must not recreate kit.json');
});

test('uninstall --purge retains kit.json when OpenCode teardown cannot consume JSONC', async () => {
  seedHome();
  seedManagedOpencode();
  fs.writeFileSync(path.join(ocHome(), 'opencode.json'), `{
    // OpenCode accepts JSONC; ak must not erase the ownership receipt when it cannot rewrite this.
    "mcp": { "claude-flow": { "type": "local", "command": ["ruflo", "mcp", "start"] } }
  }\n`);

  const { result, out } = await captureLog(() => uninstall.run({ flags: { yes: true, purge: true } }));

  assert.equal(result, 1, 'incomplete teardown must be machine-detectable');
  assert.ok(fs.existsSync(paths.kitConfigPath()),
    'kit.json must retain the ownership receipt after an incomplete teardown');
  assert.match(out, /kit\.json retained because OpenCode teardown is incomplete/);
  assert.match(fs.readFileSync(path.join(ocHome(), 'opencode.json'), 'utf8'), /claude-flow/,
    'unparseable user configuration is preserved byte-for-byte');
});

// ── N-2 (Wave C security review follow-up): printReportLine level mapping ──
// setup.mjs/sync.mjs got a printReportLine helper that routes a 'fail'-level
// lifecycle-render.mjs line to fail(), not a silent downgrade to warn().
// uninstall.mjs's own copy must map identically — renderUndoReport only ever
// emits 'ok'/'warn' today (this is latent), but the mapping itself must
// already be correct for the day an undo renderer adopts F5's levelForResult.
test('printReportLine routes each level to its own output function (ok/warn/fail/info)', async () => {
  const { out: okOut } = await captureLog(() => uninstall.printReportLine({ level: 'ok', text: 'all good' }));
  assert.match(okOut, /✓.*all good/);
  const { out: warnOut } = await captureLog(() => uninstall.printReportLine({ level: 'warn', text: 'careful' }));
  assert.match(warnOut, /⚠.*careful/);
  const { out: failOut } = await captureLog(() => uninstall.printReportLine({ level: 'fail', text: 'broken' }));
  assert.match(failOut, /✗.*broken/, 'a fail-level line must reach fail(), not be downgraded to warn()');
  const { out: infoOut } = await captureLog(() => uninstall.printReportLine({ level: 'info', text: 'fyi' }));
  assert.match(infoOut, /ℹ.*fyi/);
});

test.after(() => rmrf(HOME));
