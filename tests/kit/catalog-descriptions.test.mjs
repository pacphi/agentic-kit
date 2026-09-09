import test from 'node:test';
import assert from 'node:assert/strict';
import { readResourceDescription, readPluginDescription } from '../../src/lib/footprint/catalog-descriptions.mjs';
const io = (text, extra = {}) => ({ fsImpl: { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: text.length, ...extra }), readFileSync: () => text } });
test('reads scalar and multiline declared descriptions without exporting body', () => {
  assert.equal(readResourceDescription('SKILL.md', io('---\ndescription: "Checks accessibility"\n---\nPRIVATE BODY')), 'Checks accessibility');
  assert.equal(readResourceDescription('SKILL.md', io('---\ndescription: >\n  Checks keyboard\n  and screen readers\n---\nPRIVATE BODY')), 'Checks keyboard and screen readers');
  assert.equal(readResourceDescription('SKILL.md', io('No frontmatter')), null);
});
test('bounds metadata and rejects symlinks and oversized inputs', () => {
  assert.equal(readResourceDescription('SKILL.md', io('---\ndescription: x\n---', { isSymbolicLink: () => true })), null);
  assert.equal(readResourceDescription('SKILL.md', io('x'.repeat(65537))), null);
  assert.equal(readResourceDescription('SKILL.md', io('---\ndescription: '+ 'x'.repeat(2000)+'\n---')).length, 1024);
});
test('plugin description comes only from the explicit manifest field', () => {
  assert.equal(readPluginDescription('/plugin', 'claude', io('{"description":"Source knowledge","secret":"hidden"}')), 'Source knowledge');
  assert.equal(readPluginDescription('/plugin', 'codex', io('{"description":{}}')), null);
  assert.equal(readPluginDescription('/plugin', 'codex', io('invalid')), null);
});
test('does not turn YAML null or collections into descriptions and supports keep-chomp blocks', () => {
  for (const value of ['null', '[one, two]', '{name: value}']) assert.equal(readResourceDescription('SKILL.md', io('---\ndescription: '+value+'\n---')), null);
  assert.equal(readResourceDescription('SKILL.md', io('---\ndescription: >+\n  Explains code\n---')), 'Explains code');
});
test('Codex uses supported manifest fallback and refuses symlinked manifest directories', () => {
  const opts = io('{"description":"Fallback plugin"}');
  const original = opts.fsImpl.readFileSync;
  opts.fsImpl.readFileSync = file => { if (!file.includes('.claude-plugin')) throw new Error('missing'); return original(); };
  assert.equal(readPluginDescription('/plugin', 'codex', opts), 'Fallback plugin');
  opts.fsImpl.lstatSync = () => ({ isSymbolicLink: () => true });
  assert.equal(readPluginDescription('/plugin', 'codex', opts), null);
});
