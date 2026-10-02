// tests/kit/shipped-guidance-paths.test.mjs
// Shipped guidance must not point at a path the kit does not create. The ruflo-reference block once told
// every Claude session to read ~/.config/ruflo/ruflo-reference-full.md, a file nothing deploys (prerequisite
// A, #307), so the agent wasted a tool call or concluded the reference was unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLAUDE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../claude');
// The retired shell kit's config folder. Only `ak uninstall` still touches it, to delete what it left.
const NOT_DEPLOYED = [/\.config\/ruflo\b/, /%APPDATA%[\\/]ruflo\b/i];
const templates = fs.readdirSync(CLAUDE_DIR).filter((file) => file.endsWith('.md')).sort();
const names = (text) => NOT_DEPLOYED.some((pattern) => pattern.test(text));

test('the guard sees the shipped templates and recognises the path it exists to catch', () => {
  assert.ok(templates.includes('ruflo-reference.md'), 'the guard scans the ruflo-reference template');
  assert.ok(templates.length >= 8, `the guard scans the shipped templates, found ${templates.length}`);
  assert.equal(names('Read `~/.config/ruflo/ruflo-reference-full.md` or run `ruflo <cmd> --help`'), true);
  assert.equal(names('see %APPDATA%\\ruflo\\notes.md'), true);
  assert.equal(names('settings live in ~/.config/agentic-kit/kit.json'), false);
});

test('no shipped guidance names a ruflo config path that nothing deploys', () => {
  const offenders = templates.filter((file) => names(fs.readFileSync(path.join(CLAUDE_DIR, file), 'utf8')));
  assert.deepEqual(offenders, [], `claude/ templates point at a path the kit does not create: ${offenders.join(', ')}`);
});
