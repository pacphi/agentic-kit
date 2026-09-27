// P1 (Branch 0 real-machine pass): the About card for agentdb read "state
// unknown" on every machine. The standalone agentdb install was retired
// (5e02beb), and with it the `agentdb` status row the card joined on. AgentDB
// now ships inside Ruflo, and the status rows that report that bundled copy are
// the natives rows about its "agentdb location(s)": present, native, on the
// WASM fallback, or missing. The card joins those rows and nothing else in the
// natives subsystem (the agentic-qe binding, Ruflo's memory runtime and ak's
// install-edit receipts are about other packages).
//
// about.mjs is browser source, so it is loaded as text into a vm — the shipped
// aboutState, not a copy — and fed the rows natives.mjs really builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { RANK } from '../../src/lib/dashboard/groups.mjs';
import { agentdbLocationRow, runtimeNativeRows } from '../../src/commands/status/sections/natives.mjs';
import { row } from '../../src/commands/status/row.mjs';

const ABOUT_SOURCE = fs.readFileSync(new URL('../../src/lib/dashboard/client/about.mjs', import.meta.url), 'utf8');

function aboutStateFor(rows) {
  const context = vm.createContext({ RANK, aboutHostChip: () => null });
  vm.runInContext(ABOUT_SOURCE.replace(/^import .*;$/gm, '').replace(/\bexport /g, ''), context);
  context.__rows = rows;
  return vm.runInContext(
    "aboutState({ id: 'agentdb', category: 'engine-memory', detectionKey: 'agentdb' }, { rows: __rows })", context);
}

const located = (...native) => native.map((isNative, i) => ({ path: `/g/ruflo/node_modules/agentdb-${i}`, native: isNative }));
const otherNatives = [
  row('natives', 'fail', 'agentic-qe better-sqlite3 not native', 'sync repairs it'),
  ...runtimeNativeRows({ installed: true, contexts: [{ context: 'memory', state: 'unavailable', bindingPresent: false, reason: 'no prebuilt' }] }),
  row('versions', 'warn', 'ruflo 3.45.0 → 3.46.1 available', 'sync upgrades it'),
];

test('the agentdb card reads installed from the natives row for Ruflo\'s bundled copy', () => {
  const state = aboutStateFor([agentdbLocationRow(located(true), true), ...otherNatives]);
  assert.equal(state.state, 'ok', JSON.stringify(state));
  assert.equal(state.word, 'installed');
  assert.match(state.title, /native better-sqlite3 in 1 agentdb location\(s\)/);
  assert.doesNotMatch(state.title, /agentic-qe|memory runtime|ruflo 3\.45/,
    'natives rows about other packages, and the ruflo version row, are not about agentdb');
});

test('the agentdb card carries the verdict of every agentdb-location row shape', () => {
  const wasm = aboutStateFor([agentdbLocationRow(located(true, false), true)]);
  assert.equal(wasm.state, 'fail');
  assert.equal(wasm.detail.fix, 'sync installs native better-sqlite3');

  const bundleMissing = aboutStateFor([agentdbLocationRow([], true)]);
  assert.equal(bundleMissing.state, 'warn');
  assert.equal(bundleMissing.detail.repair, 'manual');

  const rufloMissing = aboutStateFor([agentdbLocationRow([], false)]);
  assert.equal(rufloMissing.state, 'warn');
  assert.match(rufloMissing.detail.message, /ruflo is not installed globally/);
});

test('with no agentdb-location row the card stays unknown rather than borrowing another natives verdict', () => {
  const state = aboutStateFor(otherNatives);
  assert.equal(state.state, 'unknown');
  assert.equal(state.title, 'no ak status row reported this on this machine');
});
