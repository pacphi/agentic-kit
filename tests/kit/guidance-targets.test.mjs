import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  guidanceTargets, retiredForTarget, blocksForTarget, syncBlocks, registry, BUILTIN_BLOCKS,
} from '../../src/lib/blocks.mjs';
import { codexDir, codexAgentsMdPath, home, claudeMdPath } from '../../src/lib/paths.mjs';

const block = (slug, body) => `<!-- BEGIN ${slug} -->\n${body}\n<!-- END ${slug} -->\n`;

// ── paths helpers ────────────────────────────────────────────────────────────

test('codexDir / codexAgentsMdPath resolve under ~/.codex', () => {
  assert.equal(codexDir(), path.join(home, '.codex'));
  assert.equal(codexAgentsMdPath(), path.join(home, '.codex', 'AGENTS.md'));
});

// ── guidanceTargets ──────────────────────────────────────────────────────────

test('guidanceTargets always yields claude + project agents, gated codex', () => {
  const cwd = '/tmp/proj-x';
  // codexRoot points at a NON-existent dir → agents-user omitted (never mkdir'd).
  const absent = guidanceTargets({ cwd, codexRoot: path.join(os.tmpdir(), 'no-such-codex-xyz') });
  assert.deepEqual(absent.map((t) => t.name), ['claude', 'agents']);
  assert.equal(absent[0].file, claudeMdPath());
  assert.equal(absent[1].file, path.join(cwd, 'AGENTS.md'));
});

test('guidanceTargets includes agents-user only when the codex dir exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-codex-'));
  const cwd = '/tmp/proj-y';
  const targets = guidanceTargets({ cwd, codexRoot: tmp });
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
