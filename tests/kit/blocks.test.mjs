import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  upsertBlock, stripBlock, hasBlock, syncBlocks, registry, detect, BUILTIN_BLOCKS,
} from '../../src/lib/blocks.mjs';

const block = (slug, body) => `<!-- BEGIN ${slug} -->\n${body}\n<!-- END ${slug} -->\n`;

test('upsertBlock appends to existing content with a separating blank line', () => {
  const out = upsertBlock('# My file\n', 's1', block('s1', 'hello'));
  assert.equal(out, '# My file\n\n<!-- BEGIN s1 -->\nhello\n<!-- END s1 -->\n');
});

test('upsertBlock replaces in place, preserving text before and after', () => {
  const initial = `top\n${block('s1', 'old')}bottom\n`;
  const out = upsertBlock(initial, 's1', block('s1', 'new'));
  assert.equal(out, `top\n${block('s1', 'new')}bottom\n`);
});

test('upsertBlock is idempotent', () => {
  const once = upsertBlock('x\n', 's1', block('s1', 'body'));
  const twice = upsertBlock(once, 's1', block('s1', 'body'));
  assert.equal(twice, once);
});

test('upsertBlock prepend leads the file when block absent', () => {
  const out = upsertBlock('existing\n', 'pre', block('pre', 'rules'), 'prepend');
  assert.ok(out.startsWith('<!-- BEGIN pre -->'));
  assert.ok(out.endsWith('existing\n'));
});

test('upsertBlock prepend still replaces in place when block already mid-file', () => {
  const initial = `top\n${block('pre', 'old')}bottom\n`;
  const out = upsertBlock(initial, 'pre', block('pre', 'new'), 'prepend');
  assert.equal(out, `top\n${block('pre', 'new')}bottom\n`);
});

test('upsertBlock creates content when file empty', () => {
  assert.equal(upsertBlock('', 's1', block('s1', 'b')), block('s1', 'b'));
});

test('stripBlock removes block inclusive and leaves the rest', () => {
  const initial = `top\n${block('s1', 'b')}\nbottom\n`;
  assert.equal(stripBlock(initial, 's1'), 'top\nbottom\n');
});

test('stripBlock is a no-op when block absent', () => {
  assert.equal(stripBlock('plain\n', 'nope'), 'plain\n');
});

test('CRLF content round-trips with CRLF preserved', () => {
  const initial = 'top\r\n';
  const out = upsertBlock(initial, 's1', block('s1', 'b'));
  assert.ok(out.includes('\r\n'));
  assert.ok(!out.match(/(?<!\r)\n/), 'no bare LF in CRLF file');
  const stripped = stripBlock(out, 's1');
  assert.equal(stripped, 'top\r\n');
});

test('hasBlock detects presence regardless of line endings', () => {
  assert.ok(hasBlock('a\r\n<!-- BEGIN x -->\r\n<!-- END x -->\r\n', 'x'));
  assert.ok(!hasBlock('nothing', 'x'));
});

test('registry merges custom rows after builtins and drops malformed rows', () => {
  const rows = registry([
    { slug: 'clarity-reference', templatePath: '/tmp/c.md', detector: { type: 'always' } },
    { slug: 'broken' }, // no template/detector — dropped
  ]);
  assert.equal(rows.length, BUILTIN_BLOCKS.length + 1);
  assert.equal(rows.at(-1).slug, 'clarity-reference');
  assert.ok(rows.at(-1).custom);
});

test('detect: always/file/dir/unknown detector types', async () => {
  assert.equal(await detect({ type: 'always' }), true);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-det-'));
  assert.equal(await detect({ type: 'dir', target: tmp }), true);
  const f = path.join(tmp, 'probe.txt');
  fs.writeFileSync(f, 'x');
  assert.equal(await detect({ type: 'file', target: f }), true);
  assert.equal(await detect({ type: 'file', target: path.join(tmp, 'absent') }), false);
  assert.equal(await detect({ type: 'nonsense' }), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('syncBlocks upserts wanted blocks, strips unwanted, honors dryRun', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-sync-'));
  const file = path.join(tmp, 'CLAUDE.md');
  const tplDir = path.join(tmp, 'tpl');
  fs.mkdirSync(tplDir);
  fs.writeFileSync(path.join(tplDir, 'a.md'), block('blk-a', 'AAA'));
  fs.writeFileSync(file, `header\n${block('blk-b', 'stale')}`);

  const rows = [
    { slug: 'blk-a', template: 'a.md', position: 'append', detector: { type: 'always' } },
    { slug: 'blk-b', template: 'b.md', position: 'append', detector: { type: 'file', target: path.join(tmp, 'absent') } },
  ];
  const resolve = (row) => path.join(tplDir, row.template);

  const dry = await syncBlocks(file, rows, resolve, { dryRun: true });
  assert.deepEqual(dry.map((r) => r.action), ['upserted', 'stripped']);
  assert.ok(fs.readFileSync(file, 'utf8').includes('stale'), 'dryRun must not write');

  const wet = await syncBlocks(file, rows, resolve);
  assert.deepEqual(wet.map((r) => r.action), ['upserted', 'stripped']);
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('AAA'));
  assert.ok(!content.includes('stale'));

  const again = await syncBlocks(file, rows, resolve);
  assert.deepEqual(again.map((r) => r.action), ['unchanged', 'unchanged']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('syncBlocks reports missing-template without corrupting the file', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-mt-'));
  const file = path.join(tmp, 'CLAUDE.md');
  fs.writeFileSync(file, 'keep\n');
  const rows = [{ slug: 'gone', template: 'gone.md', position: 'append', detector: { type: 'always' } }];
  const res = await syncBlocks(file, rows, () => path.join(tmp, 'gone.md'));
  assert.equal(res[0].action, 'missing-template');
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep\n');
  fs.rmSync(tmp, { recursive: true, force: true });
});
