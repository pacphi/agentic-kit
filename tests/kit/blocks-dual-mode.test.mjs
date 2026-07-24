import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detect, syncBlocks, registry, blocksForTarget, BUILTIN_BLOCKS,
} from '../../src/lib/blocks.mjs';

const block = (slug, body) => `<!-- BEGIN ${slug} -->\n${body}\n<!-- END ${slug} -->\n`;

// ── flag detector ───────────────────────────────────────────────────────────

test('flag detector is false when no context is supplied', async () => {
  const result = await detect({ type: 'flag', target: 'dualMode' });
  assert.equal(result, false);
});

test('flag detector is false when the flag is absent from context', async () => {
  const result = await detect({ type: 'flag', target: 'dualMode' }, { flags: {} });
  assert.equal(result, false);
});

test('flag detector is true when the flag is set in context', async () => {
  const result = await detect({ type: 'flag', target: 'dualMode' }, { flags: { dualMode: true } });
  assert.equal(result, true);
});

// ── backward compatibility of the new opts ──────────────────────────────────

test('existing blocks are unaffected when no context is passed to syncBlocks', async () => {
  // Arrange: an 'always' block and a 'flag' block; caller omits context.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-dm-'));
  const file = path.join(tmp, 'CLAUDE.md');
  const tplDir = path.join(tmp, 'tpl');
  fs.mkdirSync(tplDir);
  fs.writeFileSync(path.join(tplDir, 'a.md'), block('blk-a', 'AAA'));
  fs.writeFileSync(path.join(tplDir, 'd.md'), block('blk-d', 'DUAL'));
  const rows = [
    { slug: 'blk-a', template: 'a.md', position: 'append', detector: { type: 'always' } },
    { slug: 'blk-d', template: 'd.md', position: 'append', detector: { type: 'flag', target: 'dualMode' } },
  ];
  const resolve = (row) => path.join(tplDir, row.template);

  // Act: no context → flag defaults false, 'always' still fires.
  const res = await syncBlocks(file, rows, resolve);

  // Assert
  assert.deepEqual(res.map((r) => r.action), ['upserted', 'unchanged']);
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('AAA'));
  assert.ok(!content.includes('DUAL'), 'flag block stays out without context');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('syncBlocks upserts a flag-gated block when context enables the flag', async () => {
  // Arrange
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-dm-on-'));
  const file = path.join(tmp, 'AGENTS.md');
  const tplDir = path.join(tmp, 'tpl');
  fs.mkdirSync(tplDir);
  fs.writeFileSync(path.join(tplDir, 'd.md'), block('blk-d', 'DUAL'));
  const rows = [
    { slug: 'blk-d', template: 'd.md', position: 'append', detector: { type: 'flag', target: 'dualMode' } },
  ];
  const resolve = (row) => path.join(tplDir, row.template);

  // Act
  const res = await syncBlocks(file, rows, resolve, { context: { flags: { dualMode: true } } });

  // Assert
  assert.equal(res[0].action, 'upserted');
  assert.ok(fs.readFileSync(file, 'utf8').includes('DUAL'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a flag block is stripped when the flag flips off', async () => {
  // Arrange: file already carries the block, but context now disables the flag.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-dm-off-'));
  const file = path.join(tmp, 'AGENTS.md');
  const tplDir = path.join(tmp, 'tpl');
  fs.mkdirSync(tplDir);
  fs.writeFileSync(path.join(tplDir, 'd.md'), block('blk-d', 'DUAL'));
  fs.writeFileSync(file, `top\n${block('blk-d', 'DUAL')}bottom\n`);
  const rows = [
    { slug: 'blk-d', template: 'd.md', position: 'append', detector: { type: 'flag', target: 'dualMode' } },
  ];
  const resolve = (row) => path.join(tplDir, row.template);

  // Act
  const res = await syncBlocks(file, rows, resolve, { context: { flags: { dualMode: false } } });

  // Assert
  assert.equal(res[0].action, 'stripped');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('DUAL'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── blocksForTarget ─────────────────────────────────────────────────────────

test('blocksForTarget defaults a row without guidanceFiles to the claude target', () => {
  const rows = [{ slug: 'legacy', detector: { type: 'always' } }];
  assert.equal(blocksForTarget(rows, 'claude').length, 1);
  assert.equal(blocksForTarget(rows, 'agents').length, 0);
});

test('blocksForTarget includes a multi-target row in every listed target', () => {
  const rows = [{ slug: 'dual', guidanceFiles: ['claude', 'agents'], detector: { type: 'flag', target: 'dualMode' } }];
  assert.equal(blocksForTarget(rows, 'claude').length, 1);
  assert.equal(blocksForTarget(rows, 'agents').length, 1);
});

test('blocksForTarget partitions a mixed registry by target', () => {
  const rows = [
    { slug: 'claude-only', detector: { type: 'always' } },
    { slug: 'dual', guidanceFiles: ['claude', 'agents'], detector: { type: 'flag', target: 'dualMode' } },
  ];
  assert.deepEqual(blocksForTarget(rows, 'claude').map((r) => r.slug), ['claude-only', 'dual']);
  assert.deepEqual(blocksForTarget(rows, 'agents').map((r) => r.slug), ['dual']);
});

// ── registry wiring of the dual-mode block ──────────────────────────────────

test('the dual-mode block is registered as a flag-gated multi-target row', () => {
  const dual = BUILTIN_BLOCKS.find((b) => b.slug === 'ruflo-dual-mode-reference');
  assert.ok(dual, 'ruflo-dual-mode-reference is a builtin');
  assert.deepEqual(dual.detector, { type: 'flag', target: 'dualMode' });
  assert.deepEqual(dual.guidanceFiles, ['claude', 'agents']);
});

test('registry defaults a custom row without guidanceFiles to claude', () => {
  const rows = registry([
    { slug: 'x-reference', templatePath: '/tmp/x.md', detector: { type: 'always' } },
  ]);
  assert.deepEqual(rows.at(-1).guidanceFiles, ['claude']);
});
