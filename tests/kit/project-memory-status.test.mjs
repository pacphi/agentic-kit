import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import section from '../../src/commands/status/sections/project-memory.mjs';
import * as paths from '../../src/lib/paths.mjs';

test('memory status never treats file presence as a proven writer and checks both stores', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-status-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.equal((await section.collect({ cwd }))[0].level, 'info');
  fs.mkdirSync(path.join(cwd, '.swarm'));
  const native = path.join(cwd, '.swarm/agentdb-memory.db');
  const db = new DatabaseSync(native);
  db.exec('CREATE TABLE memory_entries (status TEXT); INSERT INTO memory_entries VALUES (NULL)');
  db.close();
  const single = await section.collect({ cwd });
  assert.equal(single[0].level, 'info');
  assert.match(single[0].message, /agentdb-memory\.db: 1 active entry observed.*backend.*routing unverified/);
  assert.doesNotMatch(single[0].message, /native-agentdb:/);
  fs.writeFileSync(path.join(cwd, '.swarm/memory.db'), 'corrupt');
  const dual = await section.collect({ cwd });
  assert.ok(dual.some((r) => r.level === 'warn' && /memory\.db store is unreadable/.test(r.message)));
  assert.ok(dual.some((r) => /two project memory stores/.test(r.message)));
  assert.ok(dual.some((r) => /--path/.test(r.message)));
  assert.ok(dual.some((r) => /preserve both/.test(r.message)));
  assert.ok(dual.every((r) => r.level !== 'ok' && r.fix === null));
});

function dualStoreProject(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-routing-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, '.swarm'));
  for (const file of ['memory.db', 'agentdb-memory.db']) {
    const db = new DatabaseSync(path.join(cwd, '.swarm', file));
    db.exec('CREATE TABLE memory_entries (status TEXT); INSERT INTO memory_entries VALUES (NULL)');
    db.close();
  }
  return cwd;
}

const coexist = (rows) => rows.find((r) => /two project memory stores/.test(r.message));
const UNVERIFIED = /MCP routing needs separate verification/;

test('on an observed release and platform the two-store row states which interface reads which file', async (t) => {
  const cwd = dualStoreProject(t);
  for (const rufloVersion of ['3.42.4', '3.45.0']) {
    const { message, level, fix } = coexist(await section.collect({ cwd, rufloVersion, platform: 'darwin' }));
    assert.equal(level, 'warn', 'the split stays a warning');
    assert.equal(fix, null, 'nothing for sync to repair: both stores are preserved');
    assert.match(message, /CLI[^.]*memory\.db/);
    assert.match(message, /MCP[^.]*agentdb-memory\.db/);
    assert.match(message, /native bridge/, 'the claim is conditional on the native bridge');
    assert.match(message, /preserve both/);
    assert.match(message, /--path/);
    assert.match(message, /ak x verify memory/, 'points at the live check instead of asserting it');
    assert.doesNotMatch(message, UNVERIFIED, rufloVersion);
  }
});

test('any other release, platform, or non-release version keeps routing unverified', async (t) => {
  const cwd = dualStoreProject(t);
  const cases = [
    ['3.41.2', 'darwin'], ['3.42.3', 'darwin'], ['3.42.5', 'darwin'], ['3.43.0', 'darwin'], ['3.44.0', 'darwin'],
    ['3.45.1', 'darwin'], ['4.0.0', 'darwin'],
    ['3.42.4-alpha.1', 'darwin'], ['3.45.0+build.7', 'darwin'], ['v3.45.0', 'darwin'], [null, 'darwin'], ['', 'darwin'],
    ['3.42.4', 'linux'], ['3.45.0', 'linux'], ['3.45.0', 'win32'],
  ];
  for (const [rufloVersion, platform] of cases) {
    const { message } = coexist(await section.collect({ cwd, rufloVersion, platform }));
    assert.match(message, UNVERIFIED, `${rufloVersion} on ${platform}: no claim beyond the evidence`);
    assert.match(message, /preserve both/);
  }
});

function withGlobalRoot(t, { ruflo, cli, hoisted }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-global-root-'));
  const put = (dir, version) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ version }));
  };
  if (ruflo) put('ruflo', ruflo);
  if (cli) put('ruflo/node_modules/@claude-flow/cli', cli);
  if (hoisted) put('@claude-flow/cli', hoisted);
  paths._setGlobalRootForTest(root);
  t.after(() => { paths._setGlobalRootForTest(null); fs.rmSync(root, { recursive: true, force: true }); });
}

test('routing is gated on the resolved @claude-flow/cli, not the ruflo wrapper version', async (t) => {
  const cwd = dualStoreProject(t);
  withGlobalRoot(t, { ruflo: '3.45.0', cli: '3.45.1' });
  assert.match(coexist(await section.collect({ cwd, platform: 'darwin' })).message, UNVERIFIED,
    'the wrapper is in range but the CLI that decides routing is not');
});

test('the resolved CLI version is what enables the observed wording', async (t) => {
  const cwd = dualStoreProject(t);
  withGlobalRoot(t, { ruflo: '3.45.9', cli: '3.45.0' });
  assert.doesNotMatch(coexist(await section.collect({ cwd, platform: 'darwin' })).message, UNVERIFIED);
});

test('a hoisted @claude-flow/cli is used only when ruflo has no nested copy, and no CLI means unverified', async (t) => {
  const cwd = dualStoreProject(t);
  withGlobalRoot(t, { ruflo: '3.45.0', hoisted: '3.45.0' });
  assert.doesNotMatch(coexist(await section.collect({ cwd, platform: 'darwin' })).message, UNVERIFIED);
  withGlobalRoot(t, { ruflo: '3.45.0' });
  assert.match(coexist(await section.collect({ cwd, platform: 'darwin' })).message, UNVERIFIED);
});
