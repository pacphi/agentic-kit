import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  guidanceTargets, retiredForTarget, blocksForTarget, syncBlocks, registry, BUILTIN_BLOCKS,
} from '../../src/lib/blocks.mjs';
import { codexDir, codexAgentsMdPath, home, claudeMdPath } from '../../src/lib/paths.mjs';
import { HOST_REGISTRY } from '../../src/lib/adapters/index.mjs';

const block = (slug, body) => `<!-- BEGIN ${slug} -->\n${body}\n<!-- END ${slug} -->\n`;

// ── paths helpers ────────────────────────────────────────────────────────────

test('codexDir / codexAgentsMdPath resolve under ~/.codex', () => {
  assert.equal(codexDir(), path.join(home, '.codex'));
  assert.equal(codexAgentsMdPath(), path.join(home, '.codex', 'AGENTS.md'));
});

// ── guidanceTargets ──────────────────────────────────────────────────────────

test('guidanceTargets always yields claude + project agents, gated codex', () => {
  const cwd = '/tmp/proj-x';
  // codexRoot + opencodeRoot point at NON-existent dirs → agents-user AND
  // agents-opencode omitted (never mkdir'd).
  const absent = guidanceTargets({ cwd, codexRoot: path.join(os.tmpdir(), 'no-such-codex-xyz'), opencodeRoot: path.join(os.tmpdir(), 'no-such-opencode-xyz') });
  assert.deepEqual(absent.map((t) => t.name), ['claude', 'agents']);
  assert.equal(absent[0].file, claudeMdPath());
  assert.equal(absent[1].file, path.join(cwd, 'AGENTS.md'));
});

test('guidanceTargets includes agents-user only when the codex dir exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-codex-'));
  const cwd = '/tmp/proj-y';
  const targets = guidanceTargets({ cwd, codexRoot: tmp, opencodeRoot: path.join(os.tmpdir(), 'no-such-opencode-xyz') });
  assert.deepEqual(targets.map((t) => t.name), ['claude', 'agents', 'agents-user']);
  const au = targets.find((t) => t.name === 'agents-user');
  assert.equal(au.file, path.join(tmp, 'AGENTS.md'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('guidanceTargets does not create the codex dir when absent', () => {
  const missing = path.join(os.tmpdir(), `kit-codex-never-${Date.now()}`);
  guidanceTargets({ cwd: '/tmp/z', codexRoot: missing });
  assert.equal(fs.existsSync(missing), false, 'target discovery must never mkdir ~/.codex');
});

test('guidanceTargets defaults codexRoot to the real ~/.codex path', () => {
  // Presence of agents-user tracks whether the real ~/.codex exists on this box.
  const targets = guidanceTargets({ cwd: '/tmp/z' });
  const hasCodex = fs.existsSync(codexDir());
  assert.equal(targets.some((t) => t.name === 'agents-user'), hasCodex);
});

// ── F-17: guidanceTargets is derived from HOST_REGISTRY, not a closed literal
// list. These four cases pin EXACTLY today's shape (name/label/file, in order)
// for every host-enablement combination, so the registry-derived rewrite below
// cannot silently change what ships. ────────────────────────────────────────

test('F-17 pin: claude-only (neither codex nor opencode present)', () => {
  const cwd = '/tmp/proj-pin-claude-only';
  const missingCodex = path.join(os.tmpdir(), 'no-such-codex-pin');
  const missingOpencode = path.join(os.tmpdir(), 'no-such-opencode-pin');
  const targets = guidanceTargets({ cwd, codexRoot: missingCodex, opencodeRoot: missingOpencode });
  assert.deepEqual(targets, [
    { name: 'claude', label: 'CLAUDE.md', file: claudeMdPath() },
    { name: 'agents', label: 'AGENTS.md', file: path.join(cwd, 'AGENTS.md') },
  ]);
});

test('F-17 pin: +codex (codex dir present, opencode absent)', () => {
  const cwd = '/tmp/proj-pin-codex';
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-pin-codex-'));
  const missingOpencode = path.join(os.tmpdir(), 'no-such-opencode-pin-2');
  const targets = guidanceTargets({ cwd, codexRoot, opencodeRoot: missingOpencode });
  assert.deepEqual(targets, [
    { name: 'claude', label: 'CLAUDE.md', file: claudeMdPath() },
    { name: 'agents', label: 'AGENTS.md', file: path.join(cwd, 'AGENTS.md') },
    { name: 'agents-user', label: '~/.codex/AGENTS.md', file: path.join(codexRoot, 'AGENTS.md') },
  ]);
  fs.rmSync(codexRoot, { recursive: true, force: true });
});

test('F-17 pin: +opencode (opencode dir present, codex absent)', () => {
  const cwd = '/tmp/proj-pin-opencode';
  const missingCodex = path.join(os.tmpdir(), 'no-such-codex-pin-3');
  const opencodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-pin-opencode-'));
  const targets = guidanceTargets({ cwd, codexRoot: missingCodex, opencodeRoot });
  assert.deepEqual(targets, [
    { name: 'claude', label: 'CLAUDE.md', file: claudeMdPath() },
    { name: 'agents', label: 'AGENTS.md', file: path.join(cwd, 'AGENTS.md') },
    { name: 'agents-opencode', label: 'opencode AGENTS.md', file: path.join(opencodeRoot, 'AGENTS.md') },
  ]);
  fs.rmSync(opencodeRoot, { recursive: true, force: true });
});

test('F-17 pin: all hosts present (codex + opencode)', () => {
  const cwd = '/tmp/proj-pin-all';
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-pin-codex-all-'));
  const opencodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-pin-opencode-all-'));
  const targets = guidanceTargets({ cwd, codexRoot, opencodeRoot });
  assert.deepEqual(targets, [
    { name: 'claude', label: 'CLAUDE.md', file: claudeMdPath() },
    { name: 'agents', label: 'AGENTS.md', file: path.join(cwd, 'AGENTS.md') },
    { name: 'agents-user', label: '~/.codex/AGENTS.md', file: path.join(codexRoot, 'AGENTS.md') },
    { name: 'agents-opencode', label: 'opencode AGENTS.md', file: path.join(opencodeRoot, 'AGENTS.md') },
  ]);
  fs.rmSync(codexRoot, { recursive: true, force: true });
  fs.rmSync(opencodeRoot, { recursive: true, force: true });
});

// ── F-17: synthetic-host derivation — proves the loop is genuinely driven by
// the `hosts` registry (default HOST_REGISTRY), not a hardcoded literal array.
// A registry entry this module has no bespoke path/label mapping for still
// joins the loop via the generic fallback, named after its own guidanceFile. ─

test('F-17: a synthetic nativeGuidance host with a guidanceFile joins the loop', () => {
  const cwd = '/tmp/proj-synthetic';
  const syntheticHost = {
    id: 'acme-cli',
    label: 'Acme CLI',
    capabilities: { nativeGuidance: true },
    legacy: { guidanceFile: 'agents-acme' },
  };
  const hosts = [...HOST_REGISTRY, syntheticHost];
  const targets = guidanceTargets({ cwd, hosts, codexRoot: '/no/such/codex', opencodeRoot: '/no/such/opencode' });
  const acme = targets.find((t) => t.name === 'agents-acme');
  assert.ok(acme, 'synthetic host contributes a target named after its guidanceFile');
  assert.equal(acme.file, path.join(cwd, 'agents-acme.md'));
  // Real hosts' output is unaffected by the addition.
  assert.deepEqual(targets.map((t) => t.name), ['claude', 'agents', 'agents-acme']);
});

test('F-17: a non-id-shaped guidanceFile contributes NO target (path-traversal hardening)', () => {
  const cwd = '/tmp/proj-hardened';
  const hostile = (guidanceFile) => ({
    id: 'evil-cli', label: 'Evil CLI',
    capabilities: { nativeGuidance: true },
    legacy: { guidanceFile },
  });
  for (const name of ['../../../../etc/cron.d/evil', '/etc/passwd', 'a/b', 'a\\b', 'UPPER', 'dot.dot', '']) {
    const targets = guidanceTargets({
      cwd, hosts: [...HOST_REGISTRY, hostile(name)],
      codexRoot: '/no/such/codex', opencodeRoot: '/no/such/opencode',
    });
    // The hostile host is skipped entirely (no target at all — so no file
    // path is ever derived from the hostile name); built-ins are untouched.
    assert.deepEqual(targets.map((t) => t.name), ['claude', 'agents'], `skipped for ${JSON.stringify(name)}`);
  }
});

test('F-17: a host WITHOUT nativeGuidance never contributes a target, even with a guidanceFile', () => {
  const cwd = '/tmp/proj-no-native-guidance';
  const syntheticHost = {
    id: 'silent-cli',
    label: 'Silent CLI',
    capabilities: { nativeGuidance: false },
    legacy: { guidanceFile: 'agents-silent' },
  };
  const targets = guidanceTargets({ cwd, hosts: [syntheticHost] });
  assert.deepEqual(targets, []);
});

test('F-17: HOST_REGISTRY is the real default — passing it explicitly matches the implicit default', () => {
  const explicit = guidanceTargets({ cwd: '/tmp/z', hosts: HOST_REGISTRY });
  const implicit = guidanceTargets({ cwd: '/tmp/z' });
  assert.deepEqual(explicit, implicit);
});

// ── retiredForTarget ─────────────────────────────────────────────────────────

test('retiredForTarget returns rows NOT listing the target, with a false detector', async () => {
  const rows = [
    { slug: 'claude-only', detector: { type: 'always' } },
    { slug: 'dual', guidanceFiles: ['claude', 'agents-user'], detector: { type: 'flag', target: 'dualMode' } },
  ];
  // For the project 'agents' target NEITHER row belongs → both retired.
  const retiredAgents = retiredForTarget(rows, 'agents');
  assert.deepEqual(retiredAgents.map((r) => r.slug).sort(), ['claude-only', 'dual']);
  // For 'agents-user' only the claude-only row is retired (dual belongs there).
  const retiredUser = retiredForTarget(rows, 'agents-user');
  assert.deepEqual(retiredUser.map((r) => r.slug), ['claude-only']);
  // For 'claude' nothing is retired (every row lists claude).
  assert.deepEqual(retiredForTarget(rows, 'claude'), []);
  // Retired rows carry a detector that never fires (forced strip, not upsert).
  for (const r of retiredUser) {
    assert.notEqual(r.detector?.type, 'flag', 'retired detector must not re-fire the original');
  }
});

// ── F-17: retiredForTarget's optional `knownTargets` universe ───────────────

test('retiredForTarget without knownTargets is unchanged (2-arg call sites keep todays behavior)', () => {
  // status.mjs / nudge.mjs / opencode.mjs all call retiredForTarget with 2 args
  // and are outside this refactor's edit boundary — the 3rd param must default
  // to exactly today's unconditional-strip behavior, even for a row naming a
  // target unknown to any host.
  const rows = [
    { slug: 'typo-target', guidanceFiles: ['not-a-real-target'], detector: { type: 'always' } },
  ];
  const retired = retiredForTarget(rows, 'claude');
  assert.deepEqual(retired.map((r) => r.slug), ['typo-target']);
});

test('retiredForTarget with knownTargets leaves an unrecognized-target row untouched', () => {
  const knownTargets = ['claude', 'agents', 'agents-user', 'agents-opencode'];
  const rows = [
    { slug: 'typo-target', guidanceFiles: ['not-a-real-target'], detector: { type: 'always' } },
    { slug: 'moved-away', guidanceFiles: ['agents-opencode'], detector: { type: 'always' } },
  ];
  const retired = retiredForTarget(rows, 'claude', knownTargets);
  // 'typo-target' names nothing in the known universe → left alone, not force-stripped.
  // 'moved-away' names a REAL known target (just not claude) → still force-stripped,
  // preserving the original re-scoping/migration behavior.
  assert.deepEqual(retired.map((r) => r.slug), ['moved-away']);
});

test('reconcileGuidance-style knownTargets derived from guidanceTargets() matches the real universe', () => {
  const derived = guidanceTargets({ cwd: '/tmp/z', codexRoot: home ? codexDir() : '/no/codex' }).map((t) => t.name);
  // Whatever the real machine's derived universe is, a row naming something
  // entirely outside it is never force-stripped once knownTargets is passed.
  const rows = [{ slug: 'outsider', guidanceFiles: ['definitely-not-a-real-target-xyz'], detector: { type: 'always' } }];
  for (const name of derived) {
    assert.deepEqual(retiredForTarget(rows, name, derived), [], `outsider row must not be force-stripped for ${name}`);
  }
});

// ── registry re-scoping of the dual-mode block ───────────────────────────────

test('dual-mode block is re-scoped to claude + agents-user (machine files)', () => {
  const dual = BUILTIN_BLOCKS.find((b) => b.slug === 'ruflo-dual-mode-reference');
  assert.deepEqual(dual.guidanceFiles, ['claude', 'agents-user']);
});

// ── migration: strip an orphaned dual block from a project AGENTS.md ──────────

test('project AGENTS.md carrying the dual block gets it stripped (retired strip)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-mig-'));
  const file = path.join(tmp, 'AGENTS.md');
  const tplDir = path.join(tmp, 'tpl');
  fs.mkdirSync(tplDir);
  fs.writeFileSync(path.join(tplDir, 'dual.md'), block('ruflo-dual-mode-reference', 'DUAL'));
  fs.writeFileSync(file, `# Project\n\n${block('ruflo-dual-mode-reference', 'DUAL')}\nkeep me\n`);
  const rows = registry();
  const resolve = () => path.join(tplDir, 'dual.md');
  // Even with dualMode ON, the project 'agents' target must NOT re-add the block:
  // no row targets 'agents', and the retired row forces a strip.
  const treg = [...blocksForTarget(rows, 'agents'), ...retiredForTarget(rows, 'agents')];
  const ctx = { flags: { dualMode: true } };
  const res = await syncBlocks(file, treg, resolve, { context: ctx });
  assert.ok(res.some((r) => r.slug === 'ruflo-dual-mode-reference' && r.action === 'stripped'));
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(!after.includes('DUAL'), 'dual block stripped from project AGENTS.md');
  assert.ok(after.includes('keep me'), 'surrounding content preserved');
  // idempotent second run
  const again = await syncBlocks(file, treg, resolve, { context: ctx });
  assert.ok(again.every((r) => r.action === 'unchanged'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── agents-user: upsert + one-time backup, no spurious writes ────────────────

test('agents-user upserts the dual block with a one-time .bak when file pre-existed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-au-'));
  const file = path.join(tmp, 'AGENTS.md');
  const tplDir = path.join(tmp, 'tpl');
  fs.mkdirSync(tplDir);
  fs.writeFileSync(path.join(tplDir, 'dual.md'), block('ruflo-dual-mode-reference', 'DUAL'));
  fs.writeFileSync(file, '# user content\n');
  const rows = registry();
  const resolve = () => path.join(tplDir, 'dual.md');
  const treg = [...blocksForTarget(rows, 'agents-user'), ...retiredForTarget(rows, 'agents-user')];
  const res = await syncBlocks(file, treg, resolve, { context: { flags: { dualMode: true } } });
  assert.ok(res.some((r) => r.slug === 'ruflo-dual-mode-reference' && r.action === 'upserted'));
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.includes('DUAL') && after.includes('# user content'));
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '# user content\n', 'pre-rewrite content backed up once');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('agents-user makes no file and no backup when single-host and never managed (AC-5)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-au-empty-'));
  const file = path.join(tmp, 'AGENTS.md'); // does not exist yet
  const tplDir = path.join(tmp, 'tpl');
  fs.mkdirSync(tplDir);
  fs.writeFileSync(path.join(tplDir, 'dual.md'), block('ruflo-dual-mode-reference', 'DUAL'));
  const rows = registry();
  const resolve = () => path.join(tplDir, 'dual.md');
  const treg = [...blocksForTarget(rows, 'agents-user'), ...retiredForTarget(rows, 'agents-user')];
  // single-host → dualMode false → dual block not wanted, nothing else present.
  const res = await syncBlocks(file, treg, resolve, { context: { flags: { dualMode: false } } });
  assert.ok(res.every((r) => r.action === 'unchanged'));
  assert.equal(fs.existsSync(file), false, 'no created-but-empty file');
  assert.equal(fs.existsSync(`${file}.bak`), false, 'no spurious backup');
  fs.rmSync(tmp, { recursive: true, force: true });
});
