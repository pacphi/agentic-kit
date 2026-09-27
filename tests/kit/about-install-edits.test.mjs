// `ak about` shows ak's receipted edit inside Ruflo's install next to the
// ruflo chip (audit 2026-09-26 Addendum 2, problem 3): the native SQLite pin
// Ruflo itself intends (ruvnet/ruflo#2219). The chip stays the install fact;
// the edit is a separate line and a separate JSON field.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeGlobalRoot, sandboxHome, rmrf } from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-about-edits');
after(() => rmrf(HOME));
const paths = await import('../../src/lib/paths.mjs');
const about = await import('../../src/commands/about.mjs');

const globalRoot = fakeGlobalRoot(HOME, { ruflo: '3.45.0' });
paths._setGlobalRootForTest(globalRoot);
const cli = path.join(globalRoot, 'ruflo', 'node_modules', '@claude-flow', 'cli');
fs.mkdirSync(cli, { recursive: true });
fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ optionalDependencies: { 'better-sqlite3': '^12.10.0' } }));
fs.mkdirSync(path.dirname(paths.installEditsPath()), { recursive: true });
fs.writeFileSync(paths.installEditsPath(), JSON.stringify({ version: 1, edits: [{
  file: path.join(cli, 'package.json'), section: 'optionalDependencies', name: 'better-sqlite3', from: '^12.9.0', to: '^12.10.0', at: 1,
}] }));

async function capture(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try { return { code: await fn(), out: lines.join('\n') }; } finally { console.log = log; }
}

test('ak about ruflo --json carries the applied edit beside the install chip', async () => {
  assert.ok(paths.installEditsPath().startsWith(HOME), 'the ledger is inside the sandbox');
  const { code, out } = await capture(() => about.run({ flags: { json: true }, positionals: ['ruflo'] }));
  assert.equal(code, 0);
  const [entry] = JSON.parse(out).entries;
  assert.equal(entry.state.state, 'installed');
  assert.equal(entry.state.version, '3.45.0');
  assert.equal(entry.state.edits.length, 1);
  assert.match(entry.state.edits[0], /^ak applied Ruflo's native SQLite pin \(ruvnet\/ruflo#2219\): @claude-flow\/cli package\.json optionalDependencies better-sqlite3 \^12\.9\.0 → \^12\.10\.0/);
});

test('the terminal card prints the edit on its own line under the ruflo entry', async () => {
  const { out } = await capture(() => about.run({ flags: {}, positionals: ['ruflo'] }));
  const line = out.split('\n').find((l) => /native SQLite pin/.test(l));
  assert.ok(line, out);
  assert.match(line, /ruvnet\/ruflo#2219/);
});
