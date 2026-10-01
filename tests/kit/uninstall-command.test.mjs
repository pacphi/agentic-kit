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
import { isolateProject } from './helpers/project-isolation.mjs';

const HOME = sandboxHome('ak-uninstall');
// Dynamic — paths.mjs snapshots os.homedir() at load, so it must not be
// hoisted above sandboxHome().
const paths = await import('../../src/lib/paths.mjs');
const { BEGIN, END } = await import('../../src/lib/blocks.mjs');
const uninstall = await import('../../src/commands/uninstall.mjs');
assertSandboxed(paths, HOME);
isolateProject('ak-uninstall-command');

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

// Controller ruling: every ruflo-components teardown failure must gate
// ownershipTeardownOk exactly like every other uninstall step that can fail
// to release what it owns (agent-browser, opencode, deja-vu, ...).
test('a ruflo component env conflict blocks ownership teardown so a purge must not delete kit.json', async () => {
  seedHome();
  const settingsFile = paths.claudeSettingsPath();
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  // A receipt claims ak set CLAUDE_FLOW_ROUTER_TYPESAFE=1, but the file on disk
  // now carries a different, user-edited value — planOwnedEnv preserves it and
  // keeps the receipt entry (a 'user-edited' conflict), so the release is
  // incomplete and nothing is silently overwritten.
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { CLAUDE_FLOW_ROUTER_TYPESAFE: 'user-edited' } }, null, 2) + '\n');
  fs.writeFileSync(`${settingsFile}.agentic-kit-ruflo-components.json`, JSON.stringify({
    version: 2, pending: false,
    keys: { CLAUDE_FLOW_ROUTER_TYPESAFE: { before: { present: false }, after: { present: true, value: '1' } } },
  }) + '\n');
  const { result, out } = await captureLog(() => uninstall.run({ flags: { yes: true, purge: true } }));
  assert.equal(result, 1, out);
  assert.match(out, /ruflo component env:/);
  assert.ok(fs.existsSync(paths.kitConfigPath()),
    'kit.json must survive a purge when ruflo-components teardown could not release an owned, user-edited value');
});

// ADR-0058 §1 "ak uninstall undoes every receipted change" (final review I2): governance
// applied in two projects is released in BOTH — policy file, project env key, memory pin
// and their receipt sidecars — even when uninstall runs from neither.
test('uninstall releases every receipted project, not only the cwd project', async () => {
  seedHome();
  const { reconcilePolicy } = await import('../../src/lib/ruflo-components/policy.mjs');
  const { reconcileClaudeComponentEnv, reconcileMemoryPin } = await import('../../src/lib/claude-env-projection.mjs');
  const { recordProjectReceipts } = await import('../../src/lib/ruflo-components/apply.mjs');
  const cfg = {
    aqe: true,
    integrations: { hosts: { claude: true }, ownership: { rufloComponents: { policies: {} } } },
    rufloComponents: { mcpGovernance: { maxCallsPerMinute: 120 } },
  };
  const projects = ['a', 'b'].map((name) => {
    const root = sandboxProject(`ak-uninstall-rc-${name}`);
    fs.mkdirSync(path.join(root, '.claude-flow'), { recursive: true });
    reconcilePolicy(root, cfg.rufloComponents.mcpGovernance, cfg.integrations.ownership.rufloComponents.policies);
    assert.equal(reconcileClaudeComponentEnv(cfg, { projectRoot: root, rufloVersion: '3.44.0', userScope: false }).changed, true);
    assert.equal(reconcileMemoryPin(root, { enabled: true }).ok, true);
    recordProjectReceipts(cfg, root);
    return root;
  });
  writeKitConfig(HOME, cfg);
  const elsewhere = sandboxProject('ak-uninstall-rc-elsewhere');
  const prior = process.cwd();
  process.chdir(elsewhere);
  let run;
  try {
    run = await captureLog(() => uninstall.run({ flags: { yes: true } }));
  } finally { process.chdir(prior); }
  for (const root of projects) {
    const local = paths.projectSettingsLocal(root);
    const env = fs.existsSync(local) ? JSON.parse(fs.readFileSync(local, 'utf8')).env ?? {} : {};
    assert.equal(env.RUFLO_MCP_ENFORCE_POLICY, undefined, `${root}: enforcement left behind\n${run.out}`);
    assert.equal(env.CLAUDE_FLOW_DB_PATH, undefined, `${root}: memory pin left behind`);
    assert.equal(fs.existsSync(path.join(root, '.harness', 'mcp-policy.json')), false);
    const sidecars = fs.readdirSync(path.dirname(local)).filter((f) => f.includes('.agentic-kit-'));
    assert.deepEqual(sidecars, [], `${root}: receipt sidecars left behind`);
  }
  rmrf(...projects, elsewhere);
});

// Final review M2: --purge deletes kit.json, the only record that ak installed the
// typesafe package, so a failed package removal must keep it and fail the run.
test('a failed typesafe package removal keeps kit.json under --purge', async () => {
  seedHome();
  writeKitConfig(HOME, {
    aqe: true,
    integrations: { ownership: { rufloComponents: {
      typesafePackage: { owner: 'agentic-kit', package: '@ruvector/typesafe', version: '0.1.0' },
    } } },
  });
  const { result, out } = await captureLog(() => uninstall.run({ flags: { yes: true, purge: true } }));
  assert.equal(result, 1, out);
  assert.match(out, /typesafe: npm uninstall failed/);
  assert.ok(fs.existsSync(paths.kitConfigPath()), 'kit.json holds the only typesafe receipt');
});

test.after(() => rmrf(HOME));

// uninstall puts back what ak changed for Ruflo's daemon
// in every receipted project: the autoStart value and the flat keys (and the
// .claude-flow/config.json ak created).
test('uninstall restores autoStart and removes the managed daemon keys in receipted projects', async () => {
  seedHome();
  const { reconcileRufloDaemon } = await import('../../src/lib/ruflo-daemon-config.mjs');
  const root = sandboxProject('ak-uninstall-daemon');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(paths.projectSettings(root), JSON.stringify({ claudeFlow: { daemon: { autoStart: false } } }));
  const receipts = {};
  reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts });
  writeKitConfig(HOME, { aqe: true, rufloDaemon: { autoStart: true, receipts } });
  const elsewhere = sandboxProject('ak-uninstall-daemon-elsewhere');
  const prior = process.cwd();
  process.chdir(elsewhere);
  let run;
  try {
    run = await captureLog(() => uninstall.run({ flags: { yes: true } }));
  } finally { process.chdir(prior); }
  assert.equal(JSON.parse(fs.readFileSync(paths.projectSettings(root), 'utf8')).claudeFlow.daemon.autoStart, false, run.out);
  assert.equal(fs.existsSync(path.join(root, '.claude-flow', 'config.json')), false);
  const kit = JSON.parse(fs.readFileSync(paths.kitConfigPath(), 'utf8'));
  assert.deepEqual(kit.rufloDaemon.receipts, {}, 'receipts are dropped once released');
  assert.match(run.out, /ruflo daemon settings restored/);
  rmrf(root, elsewhere);
});

// #310 (exit release): --purge runs the host-off teardown that `ak host off` runs —
// provider env, the AQE router, the Codex MCP entries and the AQE embedding
// projections — while kit.json still holds the receipts, then deletes kit.json.
function seedHostOwnership(ownership) {
  seedHome();
  writeKitConfig(HOME, { aqe: true, integrations: { ownership: { codex: ownership } } });
}
function fakeUndo(calls, overrides = {}) {
  const ok = (detail) => ({ ok: true, changed: true, detail });
  return {
    providers: (cwd) => { calls.push(['providers', cwd]); return ok('provider env restored'); },
    aqeRouter: (cwd) => { calls.push(['aqeRouter', cwd]); return ok('aqe router restored'); },
    codexMcp: async (cwd, opts) => { calls.push(['codexMcp', cwd, opts.managed]); return ok('codex MCP removed'); },
    rufloMcpInCodex: async (cwd, opts) => { calls.push(['rufloMcpInCodex', cwd, opts.managed]); return ok('ruflo MCP removed from codex'); },
    aqeEmbedding: (cfg, cwd) => { calls.push(['aqeEmbedding', cfg.aqeEmbedding?.mode, cwd]); return ok('embedding projections released'); },
    ...overrides,
  };
}

test('--purge runs every host-off teardown, each before kit.json is deleted', async () => {
  seedHostOwnership({ mcp: 'ak', reverseMcp: 'ak' });
  const calls = [];
  let kitJsonSeen = null;
  const undo = fakeUndo(calls, {
    aqeEmbedding: (cfg, cwd) => { kitJsonSeen = fs.existsSync(paths.kitConfigPath()); calls.push(['aqeEmbedding', cfg.aqeEmbedding?.mode, cwd]); return { ok: true, changed: true, detail: 'x' }; },
  });
  const { result, out } = await captureLog(() => uninstall.run({ flags: { yes: true, purge: true }, deps: { undo } }));
  assert.equal(result, 0, out);
  assert.deepEqual(calls.map((c) => c[0]), ['providers', 'aqeRouter', 'codexMcp', 'rufloMcpInCodex', 'aqeEmbedding']);
  assert.equal(calls.find((c) => c[0] === 'codexMcp')[2], true, 'ak-owned Codex MCP is removed');
  assert.equal(calls.find((c) => c[0] === 'rufloMcpInCodex')[2], true, 'ak-owned ruflo-in-Codex entry is removed');
  assert.equal(calls.find((c) => c[0] === 'aqeEmbedding')[1], 'unmanaged', 'embedding projections are released through the receipts');
  assert.equal(kitJsonSeen, true, 'teardown reads receipts while kit.json still exists');
  assert.equal(fs.existsSync(paths.kitConfigPath()), false);
});

test('--purge never removes a Codex MCP entry the user added themselves', async () => {
  seedHostOwnership({});
  const calls = [];
  await captureLog(() => uninstall.run({ flags: { yes: true, purge: true }, deps: { undo: fakeUndo(calls) } }));
  assert.equal(calls.find((c) => c[0] === 'codexMcp')[2], false);
  assert.equal(calls.find((c) => c[0] === 'rufloMcpInCodex')[2], false);
});

test('a failed host teardown keeps kit.json under --purge and exits 1', async () => {
  seedHostOwnership({ mcp: 'ak', reverseMcp: 'ak' });
  const calls = [];
  const undo = fakeUndo(calls, { codexMcp: async () => ({ ok: false, changed: false, detail: 'codex MCP removal failed: exit 1' }) });
  const { result, out } = await captureLog(() => uninstall.run({ flags: { yes: true, purge: true }, deps: { undo } }));
  assert.equal(result, 1, out);
  assert.match(out, /codex MCP removal failed/);
  assert.ok(fs.existsSync(paths.kitConfigPath()), 'kit.json holds the receipts a retry needs');
});

test('--purge --dry-run lists each host teardown step and runs none', async () => {
  seedHostOwnership({ mcp: 'ak', reverseMcp: 'ak' });
  const calls = [];
  const before = snapshot(HOME);
  const { out } = await captureLog(() => uninstall.run({ flags: { yes: true, purge: true, 'dry-run': true }, deps: { undo: fakeUndo(calls) } }));
  assert.deepEqual(calls, []);
  for (const label of ['provider env', 'AQE router', 'Codex MCP', 'AQE embedding']) assert.match(out, new RegExp(`\\[dry-run\\].*${label}`));
  assertUnchanged(before, HOME, 'a previewed purge must not touch the filesystem');
});

test('a plain uninstall (no --purge) leaves provider env and Codex MCP alone', async () => {
  seedHostOwnership({ mcp: 'ak', reverseMcp: 'ak' });
  const calls = [];
  await captureLog(() => uninstall.run({ flags: { yes: true }, deps: { undo: fakeUndo(calls) } }));
  assert.deepEqual(calls, []);
});

// #311 (exit release): --purge also removes what older ak installed outside kit.json's
// receipts. Removals ak can prove it owns ask first (--yes approves them). Defaults that
// KEEP data (deja-vu package/index, the standalone agentdb) need an interactive yes that
// --yes does not give, so `--purge --yes` can never delete them.
const ALIAS = 'Xenova/all-MiniLM-L6-v2';
function fakeExtras(calls, o = {}) {
  return {
    confirm: async (q, yes) => { calls.push(['confirm', q]); return o.confirm ?? yes === true; },
    confirmKeep: async (q) => { calls.push(['confirmKeep', q]); return o.confirmKeep ?? false; },
    run: async (cmd, args) => {
      calls.push(['run', cmd, ...args]);
      if (cmd === 'ollama' && args[0] === 'list') {
        return { code: 0, stdout: o.ollamaList ?? `NAME ID SIZE MODIFIED\nall-minilm:22m 1b226e2802db 45 MB 2 days ago\n${ALIAS}:latest 1b226e2802db 45 MB 2 days ago\n`, stderr: '' };
      }
      return { code: o.runCode ?? 0, stdout: '', stderr: '' };
    },
    have: async (cmd) => o.have?.includes(cmd) ?? true,
    brainPresent: () => o.brain ?? true,
    disableNightly: async () => { calls.push(['nightly']); return { ok: true, detail: 'nightly self-updater disabled' }; },
    agentdbDir: () => o.agentdbDir ?? null,
  };
}
const purgeWith = (extras, flags = {}) => captureLog(() => uninstall.run({
  flags: { purge: true, ...flags }, deps: { undo: fakeUndo([]), extras },
}));
const ran = (calls) => calls.filter((c) => c[0] === 'run').map((c) => c.slice(1).join(' '));

test('--purge removes the Brain plugin and nightly LaunchAgent after a confirmation, and keeps the knowledge base', async () => {
  seedHome();
  const calls = [];
  const { out } = await purgeWith(fakeExtras(calls), { yes: true });
  assert.ok(ran(calls).includes('claude plugin uninstall ruvnet-brain@ruvnet-brain'));
  assert.ok(calls.some((c) => c[0] === 'nightly'));
  assert.ok(!ran(calls).some((c) => /ruvnet-brain.*--uninstall|rm -rf/.test(c)), 'the knowledge base is never removed');
  assert.match(out, /knowledge base.*kept/i);
});

test('declining the Brain confirmation removes nothing', async () => {
  seedHome();
  const calls = [];
  await purgeWith(fakeExtras(calls, { confirm: false }));
  assert.deepEqual(ran(calls).filter((c) => c.includes('plugin')), []);
  assert.ok(!calls.some((c) => c[0] === 'nightly'));
});

test('--purge removes the Ollama alias only when it is a copy of the model ak pulled', async () => {
  seedHome();
  const calls = [];
  await purgeWith(fakeExtras(calls), { yes: true });
  assert.ok(ran(calls).includes(`ollama rm ${ALIAS}`));
});

test('a foreign Ollama model under the alias name is left alone', async () => {
  seedHome();
  const calls = [];
  const ollamaList = `NAME ID SIZE MODIFIED\nall-minilm:22m 1b226e2802db 45 MB 2 days ago\n${ALIAS}:latest ffffffffffff 90 MB 1 day ago\n`;
  const { out } = await purgeWith(fakeExtras(calls, { ollamaList }), { yes: true });
  assert.ok(!ran(calls).some((c) => c.startsWith('ollama rm')));
  assert.match(out, /not a copy ak made/i);
});

test('--purge removes a standalone agentdb only with the older-ak marker AND an interactive yes', async () => {
  seedHome();
  const agentdbDir = path.join(HOME, 'npm-global', 'agentdb');
  fs.mkdirSync(agentdbDir, { recursive: true });
  writeKitConfig(HOME, { aqe: true, agentdb: { enabled: true } });
  const calls = [];
  await purgeWith(fakeExtras(calls, { agentdbDir, confirmKeep: true }), { yes: true });
  assert.ok(ran(calls).includes('npm uninstall -g agentdb'));
});

test('--purge --yes alone never removes a standalone agentdb; it prints the command', async () => {
  seedHome();
  const agentdbDir = path.join(HOME, 'npm-global', 'agentdb');
  fs.mkdirSync(agentdbDir, { recursive: true });
  writeKitConfig(HOME, { aqe: true, agentdb: { enabled: true } });
  const calls = [];
  const { out } = await purgeWith(fakeExtras(calls, { agentdbDir }), { yes: true });
  assert.ok(!ran(calls).includes('npm uninstall -g agentdb'));
  assert.match(out, /npm uninstall -g agentdb/);
});

test('without the older-ak marker, agentdb is never removed even when the user says yes', async () => {
  seedHome();
  const agentdbDir = path.join(HOME, 'npm-global', 'agentdb');
  fs.mkdirSync(agentdbDir, { recursive: true });
  const calls = [];
  const { out } = await purgeWith(fakeExtras(calls, { agentdbDir, confirmKeep: true }), { yes: true });
  assert.ok(!ran(calls).includes('npm uninstall -g agentdb'));
  assert.match(out, /npm uninstall -g agentdb/);
});

test('--purge --yes keeps the deja-vu derived index; only an interactive yes deletes it', async () => {
  seedHome();
  const purged = [];
  const dejaIndex = (o) => ({ purgeDejaVuIndex: async (a) => { purged.push(Boolean(a.dryRun)); return { ok: true, changed: true }; }, ...o });
  await captureLog(() => uninstall.run({ flags: { purge: true, yes: true }, deps: { undo: fakeUndo([]), extras: fakeExtras([]), ...dejaIndex({}) } }));
  assert.deepEqual(purged, []);
  await captureLog(() => uninstall.run({ flags: { purge: true, yes: true }, deps: { undo: fakeUndo([]), extras: fakeExtras([], { confirmKeep: true }), ...dejaIndex({}) } }));
  assert.deepEqual(purged, [false]);
});

test('--purge --dry-run lists the extra removals and runs none of them', async () => {
  seedHome();
  const calls = [];
  const { out } = await purgeWith(fakeExtras(calls), { yes: true, 'dry-run': true });
  assert.deepEqual(ran(calls).filter((c) => !c.startsWith('ollama list')), []);
  for (const label of ['Brain plugin', 'Ollama alias', 'agentdb']) assert.match(out, new RegExp(`\\[dry-run\\].*${label}`));
});

test('a plain uninstall touches none of the extras', async () => {
  seedHome();
  const calls = [];
  await captureLog(() => uninstall.run({ flags: { yes: true }, deps: { undo: fakeUndo([]), extras: fakeExtras(calls) } }));
  assert.deepEqual(ran(calls), []);
});
